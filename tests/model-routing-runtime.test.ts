import { once } from 'node:events';
import * as http from 'node:http';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { expect, it } from 'vitest';
import { buildRoutingRuntime } from '../src/routing-runtime.js';
import { fetchAnthropicModels } from '../src/registry/anthropic-models-fetch.js';
import { getAppHome } from '../src/paths.js';
import { getProviderDebugLogPath, prepareProviderTraceLog } from '../src/log-paths.js';
import type { ModelRef, RoutingConfig } from '../src/model-routing.js';
import type { FreshProviderCatalog } from '../src/provider-catalog.js';
import type { CachedModel, ProviderRegistry, RegistryProvider } from '../src/registry/types.js';
import { provider } from './model-routing-fixtures.js';

const timestamp = '2026-10-01T00:00:00.000Z';
const testHome = process.env['LEVERFRAME_TEST_HOME'];

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

async function listModelsWithHeaders(apiKey: string, extraHeaders?: Record<string, string>, response?: string) {
  let received: Record<string, string | string[] | undefined> = {};
  const server = http.createServer((req, res) => {
    received = req.headers;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(response ?? JSON.stringify({ data: [{ id: 'claude-loopback-model' }], has_more: false }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback fixture did not bind');
  try {
    await fetchAnthropicModels(`http://127.0.0.1:${address.port}`, apiKey, extraHeaders);
    return received;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function config(ref: ModelRef): RoutingConfig {
  return { enabled: true, pool: [ref], cheapFallback: ref };
}

function registryWithAccount(): { registry: ProviderRegistry; provider: RegistryProvider; accountId: string; ref: ModelRef } {
  const ref = { providerId: 'fixture-provider', modelId: 'fixture-account-model' };
  const accountId = 'fixture-account';
  const cachedModel: CachedModel = {
    id: ref.modelId,
    name: ref.modelId,
    upstreamModelId: 'fixture-upstream-model',
    modelFormat: 'openai',
    supportedReasoningEfforts: ['low'],
  };
  const registeredProvider = provider({
    id: ref.providerId,
    templateId: 'fixture',
    accounts: [{
      id: accountId,
      authRef: 'keyring:fixture-account',
      enabled: true,
      modelsCache: { fetchedAt: timestamp, source: 'account', models: [cachedModel] },
    }],
  });
  const unrelatedProvider = provider({ id: 'unused-enabled-provider', templateId: 'fixture' });
  return {
    registry: { schemaVersion: 1, providers: [registeredProvider, unrelatedProvider] } as ProviderRegistry,
    provider: registeredProvider,
    accountId,
    ref,
  };
}

function freshResult(providerId: string, accountId: string, live: boolean): FreshProviderCatalog {
  return {
    providers: [],
    unavailable: [],
    refresh: { refreshed: [{
      id: providerId,
      name: providerId,
      ok: true,
      modelSource: live ? 'live' : 'cache',
      accountResults: [{ accountId, ok: live }],
    }] },
  };
}

it('marks account models current only after live discovery and credential resolution', async () => {
  const { registry, accountId, ref } = registryWithAccount();
  const secret = 'fixture-account-secret';
  let nativeAuthReads = 0;
  let nativeModelReads = 0;
  const snapshot = await buildRoutingRuntime({
    config: config(ref),
    registry,
    fresh: freshResult(ref.providerId, accountId, true),
    resolveAccount: async () => ({ apiKey: secret }),
    resolveProvider: async () => { throw new Error('unrelated provider resolver should not run'); },
    readNativeAuth: async () => { nativeAuthReads++; return null; },
    listNativeModels: async () => { nativeModelReads++; throw new Error('unexpected native discovery'); },
    now: () => Date.parse(timestamp),
  });

  expect(snapshot.models).toMatchObject([{
    ref,
    credential: { available: true },
    discovery: { confirmed: true },
  }]);
  expect(JSON.stringify(snapshot)).not.toContain(secret);
  expect(nativeAuthReads).toBe(0);
  expect(nativeModelReads).toBe(0);
});

it('resolves live account evidence from the primary providers cached models', async () => {
  const ref = { providerId: 'fixture-primary-cache-provider', modelId: 'fixture-primary-cached-model' };
  const accountId = 'fixture-primary-account';
  const authRef = `keyring:provider:${ref.providerId}`;
  const cached: CachedModel = {
    id: ref.modelId,
    name: ref.modelId,
    upstreamModelId: 'fixture-primary-upstream-model',
    modelFormat: 'openai',
  };
  const registeredProvider = provider({
    id: ref.providerId,
    templateId: 'fixture',
    authRef,
    modelsCache: { fetchedAt: timestamp, source: 'account', models: [cached] },
    accounts: [{ id: accountId, authRef, enabled: true }],
  });
  const snapshot = await buildRoutingRuntime({
    config: config(ref),
    registry: { schemaVersion: 1, providers: [registeredProvider] } as ProviderRegistry,
    fresh: freshResult(ref.providerId, accountId, true),
    resolveAccount: async () => ({ apiKey: 'fixture-primary-account-key' }),
    resolveProvider: async () => { throw new Error('primary account should use account credentials'); },
    readNativeAuth: async () => null,
    now: () => Date.parse(timestamp),
  });

  expect(snapshot.models).toMatchObject([{
    ref,
    credential: { available: true },
    discovery: { state: 'current', confirmed: true },
  }]);
});

it('keeps cached account models ineligible when discovery or credentials fail', async () => {
  const { registry, accountId, ref } = registryWithAccount();
  let nativeAuthReads = 0;
  let nativeModelReads = 0;
  const snapshot = await buildRoutingRuntime({
    config: config(ref),
    registry,
    fresh: freshResult(ref.providerId, accountId, false),
    resolveAccount: async () => ({ apiKey: null }),
    resolveProvider: async () => { throw new Error('unrelated provider resolver should not run'); },
    readNativeAuth: async () => { nativeAuthReads++; return null; },
    listNativeModels: async () => { nativeModelReads++; throw new Error('unexpected native discovery'); },
    now: () => Date.parse(timestamp),
  });

  expect(snapshot.models).toMatchObject([{
    ref,
    credential: { available: false },
    discovery: { confirmed: false },
  }]);
  expect(nativeAuthReads).toBe(0);
  expect(nativeModelReads).toBe(0);
});

it('does not read native credentials for an empty config by default', async () => {
  let nativeAuthReads = 0;
  let nativeModelReads = 0;
  const snapshot = await buildRoutingRuntime({
    config: { enabled: true },
    registry: { schemaVersion: 1, providers: [] } as ProviderRegistry,
    fresh: { providers: [], unavailable: [], refresh: { refreshed: [] } },
    readNativeAuth: async () => { nativeAuthReads++; return null; },
    listNativeModels: async () => { nativeModelReads++; throw new Error('unexpected native model lookup'); },
    now: () => Date.parse(timestamp),
  });

  expect(snapshot.models).toEqual([]);
  expect(nativeAuthReads).toBe(0);
  expect(nativeModelReads).toBe(0);
});

it('discovers returned native model refs for explicit first setup', async () => {
  const model: CachedModel = {
    id: 'setup-native-model',
    name: 'Setup native model',
    upstreamModelId: 'setup-native-upstream',
    modelFormat: 'anthropic',
    supportedReasoningEfforts: ['low'],
  };
  const token = 'first-setup-native-secret';
  let nativeAuthReads = 0;
  let nativeModelReads = 0;
  const snapshot = await buildRoutingRuntime({
    config: { enabled: true },
    registry: { schemaVersion: 1, providers: [] } as ProviderRegistry,
    fresh: { providers: [], unavailable: [], refresh: { refreshed: [] } },
    includeNative: true,
    readNativeAuth: async () => { nativeAuthReads++; return { kind: 'oauth', token }; },
    listNativeModels: async baseUrl => {
      nativeModelReads++;
      return { baseUrl, models: [model] };
    },
    now: () => Date.parse(timestamp),
  });

  expect(snapshot.models.map(row => row.ref.modelId)).toEqual([model.id]);
  expect(snapshot.models[0]?.upstreamModelId).toBe(model.upstreamModelId);
  expect(nativeAuthReads).toBe(1);
  expect(nativeModelReads).toBe(1);
});

it('builds native Claude routing evidence from injected auth and model discovery without retaining the token', async () => {
  const ref = { providerId: 'anthropic', modelId: 'claude-fixture-native-model' };
  const token = 'fixture-native-secret';
  let authHeader: string | undefined;
  const model: CachedModel = {
    id: ref.modelId,
    name: ref.modelId,
    upstreamModelId: 'claude-fixture-upstream-model',
    modelFormat: 'anthropic',
    supportedReasoningEfforts: ['low'],
  };
  const snapshot = await buildRoutingRuntime({
    config: config(ref),
    registry: { schemaVersion: 1, providers: [] } as ProviderRegistry,
    fresh: { providers: [], unavailable: [], refresh: { refreshed: [] } },
    readNativeAuth: async () => ({ kind: 'oauth', token }),
    listNativeModels: async (baseUrl, _apiKey, headers) => {
      authHeader = headers?.authorization;
      return { baseUrl, models: [model] };
    },
    now: () => Date.parse(timestamp),
  });

  expect(snapshot.models).toMatchObject([{
    ref,
    upstreamModelId: model.upstreamModelId,
    credential: { available: true },
    discovery: { confirmed: true },
  }]);
  expect(authHeader).toBe(`Bearer ${token}`);
  expect(JSON.stringify(snapshot)).not.toContain(token);
});

it('sends native OAuth discovery without an empty API key header', async () => {
  const headers = await listModelsWithHeaders('', { authorization: 'Bearer fixture-oauth-token' });

  expect(headers.authorization).toBe('Bearer fixture-oauth-token');
  expect(headers['x-api-key']).toBeUndefined();
});

it('retains the API key header for ordinary key-based model discovery', async () => {
  const headers = await listModelsWithHeaders('fixture-api-key');

  expect(headers['x-api-key']).toBe('fixture-api-key');
  expect(headers.authorization).toBeUndefined();
});

it('preserves the prior empty API key header when no bearer credential is present', async () => {
  const headers = await listModelsWithHeaders('');

  expect(headers['x-api-key']).toBe('');
});

it('redacts the native OAuth token from provider trace output', async () => {
  const token = 'fixture-oauth-trace-secret';
  const previousTrace = process.env['LEVERFRAME_TRACE'];
  const tracePath = join(getAppHome(), 'logs', 'provider-debug.log');
  expect(testHome).toBeTruthy();
  expect(isInside(testHome!, getAppHome())).toBe(true);
  expect(isInside(testHome!, dirname(tracePath))).toBe(true);

  try {
    process.env['LEVERFRAME_TRACE'] = '1';
    expect(prepareProviderTraceLog()).toBe(tracePath);
    await listModelsWithHeaders('', { authorization: `Bearer ${token}` }, JSON.stringify({
      data: [{ id: 'claude-loopback-model' }],
      has_more: false,
      note: `Bearer ${token}`,
    }));
    const trace = readFileSync(getProviderDebugLogPath(), 'utf8');

    expect(trace).not.toContain(token);
  } finally {
    if (previousTrace === undefined) delete process.env['LEVERFRAME_TRACE'];
    else process.env['LEVERFRAME_TRACE'] = previousTrace;
    if (existsSync(tracePath)) unlinkSync(tracePath);
  }
});
