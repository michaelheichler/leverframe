import * as http from 'node:http';
import { dirname, relative, sep } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import type { LocalProvider } from '../src/types.js';
import type { ProviderRegistry, RegistryProvider } from '../src/registry/types.js';

const mocks = vi.hoisted(() => ({
  loadPreferences: vi.fn(),
  fetchFreshProviderCatalog: vi.fn(),
  resolveLocalProviderApiKey: vi.fn(),
  resolveProviderAuth: vi.fn(),
  resolveProviderAccountAuth: vi.fn(),
  readNativeAuth: vi.fn(),
  listNativeModels: vi.fn(),
  loadRegistry: vi.fn(),
  resolveClaudeInstallation: vi.fn(),
  runLaunchPatchCheck: vi.fn(),
}));

vi.mock('../src/config.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/config.js')>(),
  loadPreferences: mocks.loadPreferences,
}));
vi.mock('../src/provider-catalog.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/provider-catalog.js')>(),
  fetchFreshProviderCatalog: mocks.fetchFreshProviderCatalog,
  resolveLocalProviderApiKey: mocks.resolveLocalProviderApiKey,
}));
vi.mock('../src/target-compatibility.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/target-compatibility.js')>(),
  providersForTarget: (providers: unknown[]) => providers,
}));
vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  resolveProviderAuth: mocks.resolveProviderAuth,
  resolveProviderAccountAuth: mocks.resolveProviderAccountAuth,
}));
vi.mock('../src/claude-code-credentials.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/claude-code-credentials.js')>(),
  readClaudeCodeAuthMaterial: mocks.readNativeAuth,
}));
vi.mock('../src/registry/anthropic-models-fetch.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/registry/anthropic-models-fetch.js')>(),
  fetchAnthropicModels: mocks.listNativeModels,
}));
vi.mock('../src/registry/io.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/registry/io.js')>(),
  loadRegistry: mocks.loadRegistry,
}));
vi.mock('../src/claude-installation.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/claude-installation.js')>(),
  resolveClaudeInstallation: mocks.resolveClaudeInstallation,
}));
vi.mock('../src/patcher.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/patcher.js')>(),
  runLaunchPatchCheck: mocks.runLaunchPatchCheck,
}));

import { getAppHome } from '../src/paths.js';
import * as proxyServer from '../src/http-proxy/server.js';
import { startConfiguredHttpProxy } from '../src/http-proxy/index.js';
import { buildRoutingCatalog } from '../src/model-routing.js';
import { createRoutingBinding, routingBindingStatePath } from '../src/routing-bindings.js';
import { httpProxyModelId } from '../src/http-proxy/routes.js';
import { input, observation } from './model-routing-fixtures.js';
import { routingBindingErrors } from '../src/routing-bindings.js';

const outerHome = process.env['LEVERFRAME_TEST_HOME'];
const target = { providerId: 'fixture-startup-provider', modelId: 'fixture-startup-model' };
const recoveredTarget = { providerId: 'fixture-startup-recovery-provider', modelId: 'fixture-startup-recovered-model' };
const routing = {
  enabled: true,
  visibleModelId: 'auto',
  cheapFallback: target,
  pool: [target],
};
const timestamp = '2026-10-01T00:00:00.000Z';

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function recoveredProvider(): RegistryProvider {
  return {
    id: recoveredTarget.providerId,
    templateId: 'fixture',
    name: recoveredTarget.providerId,
    enabled: true,
    authRef: 'keyring:synthetic-startup-recovery-provider',
    authType: 'api',
    api: { url: 'http://127.0.0.1:43123/v1', npm: '@ai-sdk/openai' },
    addedAt: timestamp,
    modelsCache: { fetchedAt: timestamp, source: 'account', models: [{
      id: recoveredTarget.modelId,
      name: recoveredTarget.modelId,
      upstreamModelId: 'fixture-startup-recovered-upstream',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      apiUrl: 'http://127.0.0.1:43123/v1',
      contextWindow: 32_000,
      outputTokenLimit: 6_000,
      supportedReasoningEfforts: ['low'],
      pricing: { input: 2, output: 8, source: 'fixture-price', observedAt: timestamp },
    }] },
  };
}

function registry(includeRecovered = false): ProviderRegistry {
  const registered: RegistryProvider = {
    id: target.providerId,
    templateId: 'fixture',
    name: target.providerId,
    enabled: true,
    authRef: 'keyring:synthetic-startup-provider',
    authType: 'api',
    api: { url: 'http://127.0.0.1:43123/v1', npm: '@ai-sdk/openai' },
    addedAt: timestamp,
    modelsCache: { fetchedAt: timestamp, source: 'account', models: [{
      id: target.modelId,
      name: target.modelId,
      family: 'fixture',
      brand: 'fixture',
      upstreamModelId: 'fixture-startup-upstream-model',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      apiUrl: 'http://127.0.0.1:43123/v1',
      contextWindow: 92_000,
      outputTokenLimit: 13_000,
      supportedReasoningEfforts: ['low', 'medium'],
      pricing: { input: 2, output: 8, source: 'fixture-price', observedAt: timestamp },
    }] },
  };
  return { schemaVersion: 1, providers: includeRecovered ? [registered, recoveredProvider()] : [registered] };
}

function localCatalog(includeRecovered = false): LocalProvider[] {
  const providers: LocalProvider[] = [{
    id: target.providerId,
    name: target.providerId,
    apiKey: 'synthetic-startup-route-key',
    models: [{
      id: target.modelId,
      name: target.modelId,
      family: 'fixture',
      brand: 'fixture',
      upstreamModelId: 'fixture-startup-upstream-model',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      apiBaseUrl: 'http://127.0.0.1:43123/v1',
      completionsUrl: 'http://127.0.0.1:43123/v1/chat/completions',
      contextWindow: 92_000,
    }],
  }];
  if (includeRecovered) providers.push({
    id: recoveredTarget.providerId,
    name: recoveredTarget.providerId,
    apiKey: 'synthetic-recovered-route-key',
    models: [{ id: recoveredTarget.modelId, name: recoveredTarget.modelId, family: 'fixture', brand: 'fixture',
      upstreamModelId: 'fixture-startup-recovered-upstream', modelFormat: 'openai', npm: '@ai-sdk/openai',
      apiBaseUrl: 'http://127.0.0.1:43123/v1', completionsUrl: 'http://127.0.0.1:43123/v1/chat/completions',
      contextWindow: 32_000, outputTokenLimit: 6_000, supportedReasoningEfforts: ['low'] }],
  });
  return providers;
}

async function postRecovery(port: number, token: string, sessionId: string) {
  const body = JSON.stringify({ sessionId, launchId: 'missing-saved-launch', sidecarValid: true, marker: 'missing-marker' });
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/v1/leverframe/routing-recovery',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body), Connection: 'close' } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(text) as Record<string, unknown>; }
        catch { parsed = { raw: text }; }
        resolve({ status: response.statusCode ?? 0, body: parsed });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadPreferences.mockReturnValue({ favoriteModels: [], modelAliases: [], routing });
  mocks.fetchFreshProviderCatalog.mockResolvedValue({
    providers: localCatalog(),
    unavailable: [],
    refresh: { refreshed: [{ id: target.providerId, name: target.providerId, ok: true, modelSource: 'live' }] },
  });
  mocks.resolveLocalProviderApiKey.mockResolvedValue('synthetic-startup-route-key');
  mocks.resolveProviderAuth.mockResolvedValue({ apiKey: 'synthetic-startup-registry-key' });
  mocks.resolveProviderAccountAuth.mockRejectedValue(new Error('No account auth should be read.'));
  mocks.readNativeAuth.mockImplementation(() => { throw new Error('Native credentials must not be read.'); });
  mocks.listNativeModels.mockImplementation(() => { throw new Error('Native model discovery must not run.'); });
  mocks.loadRegistry.mockReturnValue(registry());
  mocks.resolveClaudeInstallation.mockReturnValue({ canonicalPath: '/tmp/fixture-claude-installation' });
  mocks.runLaunchPatchCheck.mockResolvedValue(undefined);
});

it('passes one confirmed router preflight through proxy startup without native credential discovery', async () => {
  expect(outerHome).toBeTruthy();
  expect(inside(outerHome!, getAppHome())).toBe(true);
  const startProxy = vi.spyOn(proxyServer, 'startHttpProxy');
  const started = await startConfiguredHttpProxy(0, false, '/tmp/fixture-startup-inference.jsonl', undefined, undefined, true, true);
  const handle = started.handle as typeof started.handle & { routingPreflight?: {
    target: typeof target;
    policyModelId: string;
    metadata?: { contextWindow?: number; maxOutputTokens?: number; supportedReasoningEfforts?: string[] };
  } };

  try {
    expect(inside(outerHome!, handle.caCertPath)).toBe(true);
    expect(handle.routingPreflight).toMatchObject({
      target,
      policyModelId: 'leverframe:fixture-startup-provider:fixture-startup-model',
      metadata: {
        contextWindow: 92_000,
        maxOutputTokens: 13_000,
        supportedReasoningEfforts: ['low', 'medium'],
      },
    });
    expect(startProxy).toHaveBeenCalledWith(expect.objectContaining({ routing: expect.objectContaining({
      routerTarget: handle.routingPreflight?.target,
    }) }));
    expect(mocks.runLaunchPatchCheck).toHaveBeenCalledWith(expect.objectContaining({
      routingPreflight: handle.routingPreflight,
    }));
    expect(mocks.readNativeAuth).not.toHaveBeenCalled();
    expect(mocks.listNativeModels).not.toHaveBeenCalled();
    expect(mocks.resolveProviderAuth).toHaveBeenCalledTimes(1);
  } finally {
    await handle.close();
    startProxy.mockRestore();
  }
});

it('starts an empty recovery listener for the saved recovery flag without model discovery', async () => {
  const startProxy = vi.spyOn(proxyServer, 'startHttpProxy');
  mocks.loadPreferences.mockReturnValue({ favoriteModels: [], modelAliases: [], routing: { enabled: false, recoveryEnabled: true } });
  mocks.loadRegistry.mockClear();
  const started = await startConfiguredHttpProxy(0, false, `${outerHome}/recovery-only-inference.jsonl`, undefined,
    undefined, true, true);

  try {
    const recoveryRequest = await postRecovery(started.handle.port, started.handle.token, 'empty-recovery-session');
    const routing = startProxy.mock.calls[0]?.[0].routing as { config?: { enabled?: boolean }; catalog?: { models?: unknown[] }; recoveryOnly?: true } | undefined;
    expect({ recoveryOnly: started.handle.routingRecoveryOnly, active: started.handle.routingEnabled,
      enabled: routing?.config?.enabled, modelCount: routing?.catalog?.models?.length, request: recoveryRequest })
      .toMatchObject({ recoveryOnly: true, active: undefined, enabled: false, modelCount: 0,
        request: { status: 400, body: { error: { code: routingBindingErrors.invalid } } } });
    expect(routing?.recoveryOnly).toBe(true);
    expect(mocks.loadRegistry).not.toHaveBeenCalled();
    expect(mocks.readNativeAuth).not.toHaveBeenCalled();
    expect(mocks.listNativeModels).not.toHaveBeenCalled();
    expect(mocks.resolveProviderAuth).not.toHaveBeenCalled();
    expect(mocks.resolveProviderAccountAuth).not.toHaveBeenCalled();
    expect(mocks.fetchFreshProviderCatalog).toHaveBeenCalledTimes(1);
  } finally {
    await started.handle.close();
    startProxy.mockRestore();
  }
});

it('discovers a saved child target without adding it to the current new-job pool', async () => {
  expect(outerHome).toBeTruthy();
  expect(inside(outerHome!, getAppHome())).toBe(true);
  const oldRegistry = registry(true);
  const savedProvider = oldRegistry.providers[1]!;
  const savedConfig = { enabled: true, cheapFallback: recoveredTarget, pool: [recoveredTarget],
    categories: { implementation: { target: recoveredTarget, effort: 'low' } } };
  const savedCatalog = buildRoutingCatalog(input([savedProvider], {
    credentials: [observation(recoveredTarget.providerId)],
    discovery: [{ providerId: recoveredTarget.providerId, status: 'live', cacheFetchedAt: timestamp }],
  }));
  const sessionId = 'start-up-recovered-target-session';
  const statePath = routingBindingStatePath(sessionId);
  expect(inside(outerHome!, dirname(statePath))).toBe(true);
  await createRoutingBinding({ sessionId, launchId: 'start-up-recovered-target-launch', role: 'specialist',
    category: 'implementation', task: 'Continue the accepted child task', config: savedConfig,
    catalog: savedCatalog, workload: { input: 100, output: 80, cacheRead: 0, cacheWrite: 0 } });

  const currentRouting = { ...routing, pool: [target], categories: { implementation: { target, effort: 'low' } } };
  mocks.loadPreferences.mockReturnValue({ favoriteModels: [], modelAliases: [], routing: currentRouting });
  mocks.loadRegistry.mockReturnValue(oldRegistry);
  mocks.fetchFreshProviderCatalog.mockResolvedValue({ providers: localCatalog(true), unavailable: [],
    refresh: { refreshed: [target.providerId, recoveredTarget.providerId].map(id => ({
      id, name: id, ok: true, modelSource: 'live' as const,
    })) } });
  const startProxy = vi.spyOn(proxyServer, 'startHttpProxy');
  const started = await startConfiguredHttpProxy(0, false, `${outerHome}/recovered-target.jsonl`, undefined,
    undefined, true, true);

  try {
    const recoveredPolicyId = httpProxyModelId(recoveredTarget.providerId, recoveredTarget.modelId);
    const routingOptions = startProxy.mock.calls[0]?.[0].routing;
    expect(started.handle.routingPreflight?.target).toEqual(target);
    expect(started.handle.routingPreflight?.targetMetadata[recoveredPolicyId]).toMatchObject({
      contextWindow: 32_000, maxOutputTokens: 6_000, supportedReasoningEfforts: ['low'],
    });
    expect(routingOptions?.config.pool).toEqual([target]);
    expect(routingOptions?.config.categories?.['implementation']?.target).toEqual(target);
    expect(started.handle.modelIds).toContain(recoveredPolicyId);
  } finally {
    await started.handle.close();
    startProxy.mockRestore();
  }
});
