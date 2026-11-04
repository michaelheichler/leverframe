import { once } from 'node:events';
import * as http from 'node:http';
import { join, relative, sep } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { cachedModelToLocal } from '../src/registry/materialize.js';
import { localModelToRoute } from '../src/catalog.js';
import { buildRoutingCatalog } from '../src/model-routing.js';
import { httpProxyModelId } from '../src/http-proxy/routes.js';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { startHttpProxy } from '../src/http-proxy/server.js';
import { createRoutingBinding } from '../src/routing-bindings.js';
import { routingAccountEligibility } from '../src/routing-account-eligibility.js';
import { getAppHome } from '../src/paths.js';
import { saveRegistry } from '../src/registry/io.js';
import type { RegistryProvider } from '../src/registry/types.js';
import type { ProxyRoute } from '../src/proxy.js';
import { input } from './model-routing-fixtures.js';
import { acknowledgeLaunchNotice, assertIsolatedRoutingSession, readNoticeSequence, registerConsumer,
  sendBoundRequest } from './fixtures/model-routing-proxy.js';

const outerHome = process.env['LEVERFRAME_TEST_HOME'];
const providerId = 'fixture-google-normalization';
const normalizedModelId = 'gemini-fixture';
const rawModelId = 'models/gemini-fixture';
const upstreamModelId = 'models/gemini-fixture';
const alphaAuthRef = 'keyring:provider:fixture-google-normalization:google-alpha';
const betaAuthRef = 'keyring:provider:fixture-google-normalization:google-beta';
let isolatedHome: string;
let previousHome: string | undefined;
let credentialReads: string[];

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function googleProvider(endpoint: string): RegistryProvider {
  const cachedModel = {
    id: rawModelId,
    name: 'Gemini fixture',
    upstreamModelId,
    modelFormat: 'openai' as const,
    npm: '@ai-sdk/google',
    apiUrl: endpoint,
    contextWindow: 1_000_000,
    outputTokenLimit: 65_536,
    supportedReasoningEfforts: ['low'],
    pricing: { input: 1, output: 2, source: 'fixture-price' },
  };
  return {
    id: providerId,
    templateId: 'google',
    name: 'Google fixture pool',
    enabled: true,
    authRef: alphaAuthRef,
    authType: 'api',
    pinnedAccountId: 'google-alpha',
    api: { npm: '@ai-sdk/google', url: endpoint },
    addedAt: '2026-10-01T00:00:00.000Z',
    accounts: [
      { id: 'google-alpha', authRef: alphaAuthRef, enabled: true,
        modelsCache: { source: 'account', fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel] } },
      { id: 'google-beta', authRef: betaAuthRef, enabled: true,
        modelsCache: { source: 'account', fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel] } },
    ],
  };
}

function googleRoutingContext(registered: RegistryProvider) {
  const accounts = registered.accounts ?? [];
  const target = { providerId, modelId: normalizedModelId };
  return {
    proxyToken: 'fixture-google-normalization-token',
    routerTarget: target,
    config: { enabled: true, cheapFallback: target, pool: [target], categories: { implementation: { target, effort: 'low' } } },
    catalog: buildRoutingCatalog(input([registered], {
      credentials: accounts.map(account => ({ providerId, accountId: account.id, kind: 'api_key' as const, available: true })),
      discovery: accounts.map(account => ({ providerId, accountId: account.id, status: 'live' as const,
        cacheFetchedAt: account.modelsCache!.fetchedAt })),
    })),
    workload: { input: 200, output: 80, cacheRead: 0, cacheWrite: 0 },
  };
}

async function startGoogleUpstream() {
  const calls: Array<{ url?: string }> = [];
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    calls.push({ url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'normalized model response' }], role: 'model' },
      finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Google model fixture did not bind');
  return {
    calls,
    endpoint: `http://127.0.0.1:${address.port}/v1beta`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function materializedGoogleRoute(registered: RegistryProvider): ProxyRoute {
  const accountModel = registered.accounts![0]!.modelsCache!.models[0]!;
  const model = cachedModelToLocal(accountModel, registered)!;
  const route = localModelToRoute({ id: providerId, name: registered.name, apiKey: 'route-fixture-key', models: [model] }, model)!;
  return { ...route, aliasId: httpProxyModelId(providerId, normalizedModelId), providerId, authType: 'api' };
}

function saveIsolatedGoogleRegistry(registered: RegistryProvider): void {
  expect(outerHome).toBeTruthy();
  expect(inside(outerHome!, getAppHome())).toBe(true);
  saveRegistry({ schemaVersion: 1, providers: [registered] });
}

beforeEach(() => {
  expect(outerHome).toBeTruthy();
  expect(inside(outerHome!, getAppHome())).toBe(true);
  previousHome = process.env['LEVERFRAME_HOME'];
  mkdirSync(getAppHome(), { recursive: true });
  isolatedHome = mkdtempSync(join(getAppHome(), 'google-normalization-e2e-'));
  process.env['LEVERFRAME_HOME'] = isolatedHome;
  expect(inside(outerHome!, isolatedHome)).toBe(true);
  credentialReads = [];
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async operation => {
    if (operation.operation === 'read' || operation.operation === 'peek') {
      credentialReads.push(operation.account);
      return { ok: true, value: operation.account === alphaAuthRef.slice('keyring:'.length)
        ? 'fixture-google-alpha-key' : 'fixture-google-beta-key' };
    }
    return { ok: true, value: null };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(outerHome).toBeTruthy();
  expect(inside(outerHome!, isolatedHome)).toBe(true);
  rmSync(isolatedHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousHome;
  expect(inside(outerHome!, getAppHome())).toBe(true);
});

it('routes a bound Google pool request through the materialized ID from cached `models/` metadata', async () => {
  const upstream = await startGoogleUpstream();
  const registered = googleProvider(upstream.endpoint);
  saveIsolatedGoogleRegistry(registered);
  const context = googleRoutingContext(registered);
  const sessionId = 'b1515151-1515-4515-8515-151515151515';
  assertIsolatedRoutingSession(sessionId);
  const catalogModel = context.catalog.models[0]!;
  const route = materializedGoogleRoute(registered);
  expect(catalogModel.ref).toEqual({ providerId, modelId: normalizedModelId });
  expect(catalogModel.ref.modelId).toBe(normalizedModelId);
  expect(catalogModel.upstreamModelId).toBe(route.realModelId);
  expect(route.realModelId).toBe(normalizedModelId);
  const binding = await createRoutingBinding({ sessionId, launchId: 'launch-google-normalized-bound',
    role: 'specialist', category: 'implementation', task: 'Use the normalized Google model',
    config: context.config, catalog: context.catalog, workload: context.workload });
  const eligibleAccount = routingAccountEligibility(binding, context.catalog, {
    model: binding.id, max_tokens: 80, messages: [{ role: 'user', content: 'Run the integration task' }],
  });
  expect(eligibleAccount(registered.accounts![0]!, registered)).toBe(true);
  const { proxyToken: _proxyToken, ...routing } = context;
  const certificates = ensureHttpProxyCertificates();
  const proxy = await startHttpProxy({ routes: [route], routing, proxyAuthToken: context.proxyToken,
    resolveClaudeCodeAuth: async () => { throw new Error('Native credentials are not part of this Google test.'); } });
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(proxy.port, sessionId, proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(proxy.port, sessionId, consumerId, proxy.token);
    expect((await notices.connected).status).toBe(200);
    const request = sendBoundRequest(proxy, certificates.caCert, sessionId, binding.id, 'low');
    await acknowledgeLaunchNotice(proxy.port, sessionId, consumerId, proxy.token, notices);
    const response = await request;

    expect(response.status, JSON.stringify(response.body)).toContain('200');
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.url).toContain(normalizedModelId);
    expect(credentialReads).toEqual([alphaAuthRef.slice('keyring:'.length)]);
  } finally {
    notices?.close();
    await proxy.close();
    await upstream.close();
  }
}, 20_000);
