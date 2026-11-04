import { once } from 'node:events';
import * as http from 'node:http';
import { dirname, join, relative, sep } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { buildRoutingCatalog } from '../src/model-routing.js';
import { httpProxyModelId } from '../src/http-proxy/routes.js';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { startHttpProxy } from '../src/http-proxy/server.js';
import type { ProxyRoute } from '../src/proxy.js';
import { createRoutingBinding, routingBindingErrors, routingBindingStatePath } from '../src/routing-bindings.js';
import type { RoutingControlContext } from '../src/proxy-routing-control.js';
import { getAppHome } from '../src/paths.js';
import { savePreferences } from '../src/config.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';
import { input } from './model-routing-fixtures.js';
import { acknowledgeLaunchNotice, assertIsolatedRoutingSession, readNoticeSequence, registerConsumer,
  sendBoundRequest } from './fixtures/model-routing-proxy.js';
import { messageResponse, startNativeUpstream } from './fixtures/account-pool-proxy.js';
import type { RoutingRequirements } from '../src/routing-policy.js';

const ref = { providerId: 'fixture-routing-pool', modelId: 'fixture-routing-pool-model' };
const upstreamModelId = 'fixture-routing-pool-upstream';
const outerHome = process.env['LEVERFRAME_TEST_HOME'];
const alphaRef = 'keyring:provider:fixture-routing-pool:123e4567-e89b-42d3-a456-426614174200';
const betaRef = 'keyring:provider:fixture-routing-pool:123e4567-e89b-42d3-a456-426614174201';
let home: string;
let previousHome: string | undefined;
let fakeCredentials: Map<string, string>;
let credentialReads: string[];

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

interface RoutingModelFeatures {
  reasoning: boolean;
  tools?: boolean;
  images?: boolean;
  contextWindow?: number;
}

function modelFeatures(value: boolean | RoutingModelFeatures): RoutingModelFeatures {
  return typeof value === 'boolean' ? { reasoning: value } : value;
}

function account(id: string, authRef: string, inputFeatures: boolean | RoutingModelFeatures, modelFormat: 'openai' | 'anthropic') {
  const features = modelFeatures(inputFeatures);
  return {
    id,
    authRef,
    enabled: true,
    modelsCache: {
      source: 'account' as const,
      fetchedAt: '2026-10-01T00:00:00.000Z',
      models: [{ id: ref.modelId, name: ref.modelId, upstreamModelId, modelFormat,
        reasoning: features.reasoning,
        outputTokenLimit: 100_000,
        ...(features.tools === undefined ? {} : { supportedParameters: features.tools ? ['tools'] : [] }),
        ...(features.images === undefined ? {} : { vision: features.images }),
        contextWindow: features.contextWindow ?? 100_000,
        supportedReasoningEfforts: ['low'], pricing: { input: 2, output: 8, source: 'fixture-price' } }],
    },
  };
}

function poolProvider(alphaFeatures: boolean | RoutingModelFeatures, betaFeatures: boolean | RoutingModelFeatures,
  modelFormat: 'openai' | 'anthropic' = 'openai') {
  return {
    id: ref.providerId,
    templateId: 'fixture',
    name: 'Fixture routing pool',
    enabled: true,
    authType: 'api' as const,
    authRef: alphaRef,
    pinnedAccountId: 'beta',
    api: { npm: '@ai-sdk/openai-compatible' },
    addedAt: '2026-10-01T00:00:00.000Z',
    accounts: [account('alpha', alphaRef, alphaFeatures, modelFormat), account('beta', betaRef, betaFeatures, modelFormat)],
  };
}

function routingContext(snapshotProvider: ReturnType<typeof poolProvider>): RoutingControlContext {
  const snapshot = input([snapshotProvider], {
    credentials: snapshotProvider.accounts.map(item => ({ providerId: ref.providerId, accountId: item.id, kind: 'api_key' as const, available: true })),
    discovery: snapshotProvider.accounts.map(item => ({ providerId: ref.providerId, accountId: item.id,
      status: 'live' as const, cacheFetchedAt: item.modelsCache.fetchedAt })),
  });
  return {
    proxyToken: 'fixture-account-routing-proxy-token',
    routerTarget: ref,
    config: { enabled: true, cheapFallback: ref, pool: [ref], categories: { implementation: { target: ref, effort: 'low' } } },
    catalog: buildRoutingCatalog(snapshot),
    workload: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
  };
}

async function startLoopbackUpstream() {
  const calls: Array<{ authorization?: string; model?: string }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { model?: string };
    const authorization = req.headers.authorization;
    calls.push({ authorization: typeof authorization === 'string' ? authorization : undefined, model: body.model });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'fixture-pool-answer', object: 'chat.completion', created: 1, model: upstreamModelId,
      choices: [{ index: 0, message: { role: 'assistant', content: 'eligible pool response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('account pool upstream fixture did not bind');
  return {
    calls,
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function saveCurrentRegistry(snapshotProvider: ReturnType<typeof poolProvider>): void {
  expect(outerHome).toBeTruthy();
  expect(inside(outerHome!, getAppHome())).toBe(true);
  saveRegistry({ schemaVersion: 1, providers: [snapshotProvider] });
}

beforeEach(() => {
  expect(outerHome).toBeTruthy();
  expect(inside(outerHome!, getAppHome())).toBe(true);
  previousHome = process.env['LEVERFRAME_HOME'];
  mkdirSync(getAppHome(), { recursive: true });
  home = mkdtempSync(join(getAppHome(), 'routing-pool-e2e-'));
  process.env['LEVERFRAME_HOME'] = home;
  expect(inside(outerHome!, home)).toBe(true);
  fakeCredentials = new Map([[alphaRef.slice('keyring:'.length), 'eligible-account-secret'],
    [betaRef.slice('keyring:'.length), 'ineligible-account-secret']]);
  credentialReads = [];
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async operation => {
    if (operation.operation === 'read' || operation.operation === 'peek') {
      credentialReads.push(operation.account);
      return { ok: true, value: fakeCredentials.get(operation.account) ?? null };
    }
    return { ok: true, value: null };
  });
  expect(inside(outerHome!, getAppHome())).toBe(true);
  savePreferences({ accountPoolBalancing: false, accountPoolFailover: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(outerHome).toBeTruthy();
  expect(inside(outerHome!, home)).toBe(true);
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousHome;
  if (outerHome) expect(inside(outerHome, getAppHome())).toBe(true);
});

async function dispatchBoundAccountRequest(snapshotProvider: ReturnType<typeof poolProvider>, sessionId: string,
  requirements?: RoutingRequirements, routeModelId = upstreamModelId, effort = 'low') {
  expect(outerHome).toBeTruthy();
  assertIsolatedRoutingSession(sessionId);
  const upstream = await startLoopbackUpstream();
  const routedProvider = { ...snapshotProvider, api: { ...snapshotProvider.api, url: upstream.baseURL } };
  saveCurrentRegistry(routedProvider);
  const context = routingContext(routedProvider);
  context.config = { ...context.config, categories: { implementation: { target: ref, effort } } };
  const bindingPath = routingBindingStatePath(sessionId);
  expect(inside(outerHome!, dirname(bindingPath))).toBe(true);
  const binding = await createRoutingBinding({ sessionId, launchId: `launch-${sessionId}`, role: 'specialist',
    category: 'implementation', task: 'Use an account with reasoning support',
    ...(requirements ? { requirements } : {}), config: context.config, catalog: context.catalog, workload: context.workload });
  expect(inside(outerHome!, getAppHome())).toBe(true);
  const certificates = ensureHttpProxyCertificates();
  const route: ProxyRoute = {
    aliasId: httpProxyModelId(ref.providerId, ref.modelId),
    realModelId: routeModelId,
    displayName: 'Fixture pool model',
    upstreamUrl: upstream.baseURL,
    baseURL: upstream.baseURL,
    apiKey: 'route-snapshot-key',
    modelFormat: 'openai',
    npm: '@ai-sdk/openai-compatible',
    providerId: ref.providerId,
    authType: 'api',
    reasoning: true,
    supportedParameters: ['tools'],
    supportedReasoningEfforts: [effort],
  };
  const { proxyToken: _proxyToken, ...routing } = context;
  const proxy = await startHttpProxy({ routes: [route], routing, proxyAuthToken: context.proxyToken,
    resolveClaudeCodeAuth: async () => { throw new Error('native auth is not part of this SDK pool fixture'); } });
  const consumer = await registerConsumer(proxy.port, sessionId, proxy.token);
  const consumerId = String(consumer.body.consumerId);
  const notices = readNoticeSequence(proxy.port, sessionId, consumerId, proxy.token);
  expect((await notices.connected).status).toBe(200);
  return { binding, upstream, proxy, certificates, consumerId, notices };
}

async function dispatchBoundNativeAccountRequest(snapshotProvider: ReturnType<typeof poolProvider>, sessionId: string) {
  expect(outerHome).toBeTruthy();
  assertIsolatedRoutingSession(sessionId);
  const upstream = await startNativeUpstream((_call, response) => messageResponse(response));
  const routedProvider = { ...snapshotProvider, api: { npm: '@ai-sdk/anthropic', url: `http://127.0.0.1:${upstream.port}` } };
  saveCurrentRegistry(routedProvider);
  const context = routingContext(routedProvider);
  const bindingPath = routingBindingStatePath(sessionId);
  expect(inside(outerHome!, dirname(bindingPath))).toBe(true);
  const binding = await createRoutingBinding({ sessionId, launchId: `launch-${sessionId}`, role: 'specialist',
    category: 'implementation', task: 'Use a native account with reasoning support',
    requirements: { capabilities: ['reasoning'] }, config: context.config, catalog: context.catalog, workload: context.workload });
  expect(inside(outerHome!, getAppHome())).toBe(true);
  const certificates = ensureHttpProxyCertificates();
  const route: ProxyRoute = {
    aliasId: httpProxyModelId(ref.providerId, ref.modelId),
    realModelId: upstreamModelId,
    displayName: 'Fixture native pool model',
    upstreamUrl: `http://127.0.0.1:${upstream.port}`,
    apiKey: 'route-snapshot-key',
    modelFormat: 'anthropic',
    npm: '@ai-sdk/anthropic',
    providerId: ref.providerId,
    authType: 'api',
    reasoning: true,
    supportedReasoningEfforts: ['low'],
  };
  const { proxyToken: _proxyToken, ...routing } = context;
  const proxy = await startHttpProxy({ routes: [route], routing, proxyAuthToken: context.proxyToken,
    resolveClaudeCodeAuth: async () => { throw new Error('native Claude credentials are not part of this account pool fixture'); } });
  const consumer = await registerConsumer(proxy.port, sessionId, proxy.token);
  const consumerId = String(consumer.body.consumerId);
  const notices = readNoticeSequence(proxy.port, sessionId, consumerId, proxy.token);
  expect((await notices.connected).status).toBe(200);
  return { binding, upstream, proxy, certificates, consumerId, notices };
}

it('dispatches a bound request only through accounts that satisfy its model requirements', async () => {
  const snapshotProvider = poolProvider(true, false);
  saveCurrentRegistry(snapshotProvider);
  const sessionId = 'b1111111-1111-4111-8111-111111111111';
  const service = await dispatchBoundAccountRequest(snapshotProvider, sessionId, { capabilities: ['reasoning'] });

  try {
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, service.binding.id, 'low');
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, service.consumerId, service.proxy.token, service.notices);
    const response = await request;

    expect(response.status, JSON.stringify(response.body)).toContain('200');
    expect(response.body.error).toBeUndefined();
    expect(service.upstream.calls).toEqual([{ authorization: 'Bearer eligible-account-secret', model: upstreamModelId }]);
    expect(credentialReads).toEqual([alphaRef.slice('keyring:'.length)]);
  } finally {
    service.notices.close();
    await service.proxy.close();
    await service.upstream.close();
  }
});

it('does not resolve credentials or call the provider when current accounts no longer meet binding requirements', async () => {
  const snapshotProvider = poolProvider(true, false);
  saveCurrentRegistry(snapshotProvider);
  const sessionId = 'b2222222-2222-4222-8222-222222222222';
  const service = await dispatchBoundAccountRequest(snapshotProvider, sessionId, { capabilities: ['reasoning'] });
  const currentProvider = poolProvider(false, false);
  saveCurrentRegistry(currentProvider);

  try {
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, service.binding.id, 'low');
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, service.consumerId, service.proxy.token, service.notices);
    const response = await request;

    expect(response.status).not.toContain('200');
    expect(service.upstream.calls).toHaveLength(0);
    expect(credentialReads).toHaveLength(0);
  } finally {
    service.notices.close();
    await service.proxy.close();
    await service.upstream.close();
  }
});

it('rejects a request when the current account cache lowers its output cap after binding', async () => {
  const snapshotProvider = poolProvider(true, true);
  for (const item of snapshotProvider.accounts) {
    Object.assign(item.modelsCache!.models[0]!, { outputTokenLimit: 128 });
  }
  const sessionId = 'b2323232-2323-4232-8232-232323232323';
  const service = await dispatchBoundAccountRequest(snapshotProvider, sessionId);
  const currentRegistry = loadRegistry();
  const currentProvider = currentRegistry.providers.find(item => item.id === ref.providerId)!;
  for (const item of currentProvider.accounts ?? []) {
    Object.assign(item.modelsCache!.models[0]!, { outputTokenLimit: 64 });
  }
  saveRegistry(currentRegistry);

  try {
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, service.binding.id, 'low', {},
      { max_tokens: 80 });
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, service.consumerId, service.proxy.token, service.notices);
    const response = await request;

    expect(response.status).not.toContain('200');
    expect(service.upstream.calls).toHaveLength(0);
    expect(credentialReads).toHaveLength(0);
  } finally {
    service.notices.close();
    await service.proxy.close();
    await service.upstream.close();
  }
});

it('rejects a bound route whose upstream identity changed before credential lookup', async () => {
  const snapshotProvider = poolProvider(true, true);
  saveCurrentRegistry(snapshotProvider);
  const sessionId = 'b1212121-1212-4121-8121-121212121212';
  const service = await dispatchBoundAccountRequest(snapshotProvider, sessionId, undefined, 'fixture-route-drift-model');

  try {
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, service.binding.id, 'low');
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, service.consumerId, service.proxy.token, service.notices);
    const response = await request;

    expect(response.status, JSON.stringify(response.body)).toContain('400');
    expect(credentialReads).toHaveLength(0);
    expect(service.upstream.calls).toHaveLength(0);
  } finally {
    service.notices.close();
    await service.proxy.close();
    await service.upstream.close();
  }
});

const transportRouteDriftCases: Array<{
  label: string;
  route: (snapshotBase: string, alternateOrigin: string) => Pick<ProxyRoute, 'upstreamUrl' | 'baseURL' | 'npm' | 'modelFormat'>;
}> = [
  { label: 'endpoint path', route: (snapshotBase) => ({ upstreamUrl: `${snapshotBase}/alternate/chat/completions`,
    baseURL: `${snapshotBase}/alternate`, npm: '@ai-sdk/openai-compatible', modelFormat: 'openai' }) },
  { label: 'endpoint origin', route: (_snapshotBase, alternateOrigin) => ({ upstreamUrl: `${alternateOrigin}/chat/completions`,
    baseURL: alternateOrigin, npm: '@ai-sdk/openai-compatible', modelFormat: 'openai' }) },
  { label: 'SDK npm', route: (snapshotBase) => ({ upstreamUrl: `${snapshotBase}/chat/completions`,
    baseURL: snapshotBase, npm: '@ai-sdk/openai', modelFormat: 'openai' }) },
  { label: 'wire format', route: (snapshotBase) => ({ upstreamUrl: snapshotBase,
    baseURL: undefined, npm: '@ai-sdk/anthropic', modelFormat: 'anthropic' }) },
];

it.each(transportRouteDriftCases)('rejects a bound route whose $label changed before credentials or inference', async ({ route: makeRoute }) => {
  const snapshotUpstream = await startLoopbackUpstream();
  const alternateUpstream = await startLoopbackUpstream();
  const snapshotProvider = { ...poolProvider(true, true),
    api: { npm: '@ai-sdk/openai-compatible', url: snapshotUpstream.baseURL } };
  saveCurrentRegistry(snapshotProvider);
  const sessionId = 'b1414141-1414-4141-8141-141414141414';
  assertIsolatedRoutingSession(sessionId);
  const context = routingContext(snapshotProvider);
  const binding = await createRoutingBinding({ sessionId, launchId: `launch-transport-${sessionId}`,
    role: 'specialist', category: 'implementation', task: 'Keep the same bound transport',
    config: context.config, catalog: context.catalog, workload: context.workload });
  const changedRoute = makeRoute(snapshotUpstream.baseURL, alternateUpstream.baseURL);
  const route: ProxyRoute = {
    aliasId: httpProxyModelId(ref.providerId, ref.modelId),
    realModelId: upstreamModelId,
    displayName: 'Fixture transport drift model',
    apiKey: 'synthetic-transport-route-key',
    providerId: ref.providerId,
    authType: 'api',
    supportedReasoningEfforts: ['low'],
    ...changedRoute,
  };
  const { proxyToken: _proxyToken, ...routing } = context;
  const proxy = await startHttpProxy({ routes: [route], routing, proxyAuthToken: context.proxyToken,
    resolveClaudeCodeAuth: async () => { throw new Error('Native credentials are not part of this transport test.'); } });
  const consumer = await registerConsumer(proxy.port, sessionId, proxy.token);
  const consumerId = String(consumer.body.consumerId);
  const notices = readNoticeSequence(proxy.port, sessionId, consumerId, proxy.token);
  expect((await notices.connected).status).toBe(200);

  try {
    const request = sendBoundRequest(proxy, ensureHttpProxyCertificates().caCert, sessionId, binding.id, 'low');
    await acknowledgeLaunchNotice(proxy.port, sessionId, consumerId, proxy.token, notices);
    const response = await request;

    expect(response.status, JSON.stringify(response.body)).toContain('400');
    expect({ error: response.body.error, credentialLookups: credentialReads.length,
      snapshotRequests: snapshotUpstream.calls.length, alternateRequests: alternateUpstream.calls.length }).toMatchObject({
      error: { code: routingBindingErrors.identityMismatch }, credentialLookups: 0, snapshotRequests: 0, alternateRequests: 0,
    });
  } finally {
    notices.close();
    await proxy.close();
    await snapshotUpstream.close();
    await alternateUpstream.close();
  }
}, 20_000);

it('applies the same binding account requirements to native API-key pool forwarding', async () => {
  const snapshotProvider = poolProvider(true, false, 'anthropic');
  saveCurrentRegistry(snapshotProvider);
  const sessionId = 'b3333333-3333-4333-8333-333333333333';
  const service = await dispatchBoundNativeAccountRequest(snapshotProvider, sessionId);

  try {
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, service.binding.id, 'low');
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, service.consumerId, service.proxy.token, service.notices);
    const response = await request;

    expect(response.status, JSON.stringify(response.body)).toContain('200');
    expect(service.upstream.calls).toEqual([{ key: 'eligible-account-secret', model: upstreamModelId }]);
    expect(credentialReads).toEqual([alphaRef.slice('keyring:'.length)]);
  } finally {
    service.notices.close();
    await service.proxy.close();
    await service.upstream.close();
  }
});

it('keeps a high-effort binding usable when same-reference accounts have disjoint effort support', async () => {
  const snapshotProvider = poolProvider({ reasoning: true }, { reasoning: true });
  const [lowAccount, highAccount] = snapshotProvider.accounts;
  const lowModel = lowAccount!.modelsCache!.models[0]!;
  const highModel = highAccount!.modelsCache!.models[0]!;
  lowModel.supportedReasoningEfforts = ['low'];
  lowModel.contextWindow = 90_000;
  Object.assign(lowModel, { outputTokenLimit: 10_000 });
  highModel.supportedReasoningEfforts = ['high'];
  highModel.contextWindow = 45_000;
  Object.assign(highModel, { outputTokenLimit: 4_000 });
  snapshotProvider.pinnedAccountId = 'alpha';
  saveCurrentRegistry(snapshotProvider);
  const sessionId = 'b3131313-3131-4131-8131-313131313131';
  const service = await dispatchBoundAccountRequest(snapshotProvider, sessionId, undefined, upstreamModelId, 'high');

  try {
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId,
      service.binding.id, 'low');
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, service.consumerId, service.proxy.token, service.notices);
    const response = await request;

    expect(service.binding.decision.effort).toBe('high');
    expect(response.status, JSON.stringify(response.body)).toContain('200');
    expect(service.upstream.calls).toEqual([{ authorization: 'Bearer ineligible-account-secret', model: upstreamModelId }]);
    expect(credentialReads).toEqual([betaRef.slice('keyring:'.length)]);
  } finally {
    service.notices.close();
    await service.proxy.close();
    await service.upstream.close();
  }
}, 20_000);

const accountRequirementCases: Array<{
  label: string;
  sessionId: string;
  alpha: RoutingModelFeatures;
  beta: RoutingModelFeatures;
  requirements: RoutingRequirements;
}> = [
  { label: 'tool support', sessionId: 'b4444444-4444-4444-8444-444444444444',
    alpha: { reasoning: false, tools: true }, beta: { reasoning: false, tools: false },
    requirements: { capabilities: ['tools'] } },
  { label: 'image support', sessionId: 'b5555555-5555-4555-8555-555555555555',
    alpha: { reasoning: false, images: true }, beta: { reasoning: false, images: false },
    requirements: { capabilities: ['images'] } },
  { label: 'confirmed context size', sessionId: 'b6666666-6666-4666-8666-666666666666',
    alpha: { reasoning: false, contextWindow: 100_000 }, beta: { reasoning: false, contextWindow: 50_000 },
    requirements: { contextTokens: 80_000 } },
];

const requestRequirementCases: Array<{
  label: string;
  sessionId: string;
  alpha: RoutingModelFeatures;
  beta: RoutingModelFeatures;
  body: Record<string, unknown>;
}> = [
  { label: 'tools', sessionId: 'b7777777-7777-4777-8777-777777777777',
    alpha: { reasoning: true, tools: true, contextWindow: 10_000 }, beta: { reasoning: true, tools: false, contextWindow: 10_000 },
    body: { tools: [{ name: 'lookup', description: 'Synthetic lookup', input_schema: { type: 'object', properties: {} } }] } },
  { label: 'images', sessionId: 'b8888888-8888-4888-8888-888888888888',
    alpha: { reasoning: true, images: true, contextWindow: 10_000 }, beta: { reasoning: true, images: false, contextWindow: 10_000 },
    body: { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }] } },
  { label: 'tool argument with an image-like value', sessionId: 'baaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    alpha: { reasoning: true, tools: true, images: false, contextWindow: 10_000 },
    beta: { reasoning: true, tools: false, images: true, contextWindow: 10_000 },
    body: { tools: [{ name: 'lookup', description: 'Synthetic lookup', input_schema: { type: 'object', properties: {} } }],
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'fixture-tool-use', name: 'lookup',
          input: { type: 'image', value: 'ordinary tool input data' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fixture-tool-use', content: 'completed' }] },
      ] } },
  { label: 'context size', sessionId: 'b9999999-9999-4999-8999-999999999999',
    alpha: { reasoning: true, contextWindow: 10_000 }, beta: { reasoning: true, contextWindow: 256 },
    body: { messages: [{ role: 'user', content: 'x'.repeat(2000) }] } },
];

it.each(accountRequirementCases)('filters bound pool selection by $label', async ({ sessionId, alpha, beta, requirements }) => {
  const snapshotProvider = poolProvider(alpha, beta);
  saveCurrentRegistry(snapshotProvider);
  const service = await dispatchBoundAccountRequest(snapshotProvider, sessionId, requirements);

  try {
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, service.binding.id, 'low');
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, service.consumerId, service.proxy.token, service.notices);
    const response = await request;

    expect(response.status, JSON.stringify(response.body)).toContain('200');
    expect(service.upstream.calls).toEqual([{ authorization: 'Bearer eligible-account-secret', model: upstreamModelId }]);
    expect(credentialReads).toEqual([alphaRef.slice('keyring:'.length)]);
  } finally {
    service.notices.close();
    await service.proxy.close();
    await service.upstream.close();
  }
}, 20_000);

it.each(requestRequirementCases)('filters pool accounts by $label requirements from the actual request', async ({ sessionId, alpha, beta, body }) => {
  const snapshotProvider = poolProvider(alpha, beta);
  saveCurrentRegistry(snapshotProvider);
  const service = await dispatchBoundAccountRequest(snapshotProvider, sessionId);

  try {
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, service.binding.id, 'low', {}, body);
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, service.consumerId, service.proxy.token, service.notices);
    const response = await request;

    expect(service.binding.requirements).toBeUndefined();
    expect(response.status, JSON.stringify(response.body)).toContain('200');
    expect(service.upstream.calls).toEqual([{ authorization: 'Bearer eligible-account-secret', model: upstreamModelId }]);
    expect(credentialReads).toEqual([alphaRef.slice('keyring:'.length)]);
  } finally {
    service.notices.close();
    await service.proxy.close();
    await service.upstream.close();
  }
}, 20_000);
