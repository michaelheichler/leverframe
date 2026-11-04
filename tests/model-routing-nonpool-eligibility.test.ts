import { once } from 'node:events';
import * as http from 'node:http';
import { dirname, relative, sep } from 'node:path';
import { expect, it, vi } from 'vitest';
import * as requestPolicy from '../src/context/request-policy.js';
import { buildRoutingCatalog } from '../src/model-routing.js';
import { httpProxyModelId } from '../src/http-proxy/routes.js';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { startHttpProxy } from '../src/http-proxy/server.js';
import type { ProxyRoute } from '../src/proxy.js';
import type { RoutingConfig } from '../src/model-routing.js';
import { createRoutingBinding, resolveRoutingBinding, routingBindingErrors, routingBindingStatePath } from '../src/routing-bindings.js';
import type { RoutingControlContext } from '../src/proxy-routing-control.js';
import { getAppHome, getProvidersPath } from '../src/paths.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';
import { input, observation, provider } from './model-routing-fixtures.js';
import { acknowledgeLaunchNotice, assertIsolatedRoutingSession, readNoticeSequence, registerConsumer,
  sendBoundRequest } from './fixtures/model-routing-proxy.js';

const ref = { providerId: 'fixture-nonpool-provider', modelId: 'fixture-nonpool-model' };
const upstreamModelId = 'fixture-nonpool-upstream';
const outerHome = process.env['LEVERFRAME_TEST_HOME'];

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

async function startUpstream() {
  const calls: Array<{ authorization?: string; model?: string }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { model?: string };
    const authorization = req.headers.authorization;
    calls.push({ authorization: typeof authorization === 'string' ? authorization : undefined, model: body.model });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'fixture-unrestricted-response', object: 'chat.completion', created: 1,
      model: upstreamModelId, choices: [{ index: 0, message: { role: 'assistant', content: 'adapter response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('non-pool upstream fixture did not bind');
  return {
    calls,
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

const requestCases = [
  { label: 'tool request', sessionId: 'c1111111-1111-4111-8111-111111111111', contextWindow: 100_000,
    body: { tools: [{ name: 'lookup', description: 'Synthetic lookup', input_schema: { type: 'object', properties: {} } }] } },
  { label: 'image request', sessionId: 'c2222222-2222-4222-8222-222222222222', contextWindow: 100_000,
    body: { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }] } },
  { label: 'oversized context request', sessionId: 'c3333333-3333-4333-8333-333333333333', contextWindow: 256,
    body: { messages: [{ role: 'user', content: 'x'.repeat(2000) }] } },
];

it.each(requestCases)('rejects a bound non-pool $label before provider dispatch', async ({ sessionId, contextWindow, body }) => {
  expect(outerHome).toBeTruthy();
  assertIsolatedRoutingSession(sessionId);
  const statePath = routingBindingStatePath(sessionId);
  expect(inside(outerHome!, dirname(statePath))).toBe(true);
  const upstream = await startUpstream();
  const registeredProvider = provider({
    id: ref.providerId,
    templateId: 'fixture',
    modelsCache: {
      fetchedAt: '2026-10-01T00:00:00.000Z',
      source: 'account',
      models: [{ id: ref.modelId, name: ref.modelId, upstreamModelId, modelFormat: 'openai',
        reasoning: true, supportedReasoningEfforts: ['low'], contextWindow,
        pricing: { input: 2, output: 8, source: 'fixture-price' } }],
    },
  });
  const snapshot = input([registeredProvider], {
    credentials: [observation(ref.providerId)],
    discovery: [{ providerId: ref.providerId, status: 'live', cacheFetchedAt: '2026-10-01T00:00:00.000Z' }],
  });
  const context: RoutingControlContext = {
    proxyToken: 'fixture-nonpool-proxy-token',
    routerTarget: ref,
    config: { enabled: true, cheapFallback: ref, pool: [ref],
      categories: { implementation: { target: ref, effort: 'low' } } },
    catalog: buildRoutingCatalog(snapshot),
    workload: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
  };
  const binding = await createRoutingBinding({ sessionId, launchId: `launch-${sessionId}`, role: 'specialist',
    category: 'implementation', task: 'Use the requested model capability', config: context.config,
    catalog: context.catalog, workload: context.workload });
  expect(inside(outerHome!, getAppHome())).toBe(true);
  const certificates = ensureHttpProxyCertificates();
  const { proxyToken: _proxyToken, ...routing } = context;
  const route: ProxyRoute = {
    aliasId: httpProxyModelId(ref.providerId, ref.modelId),
    realModelId: upstreamModelId,
    displayName: 'Fixture non-pool model',
    upstreamUrl: upstream.baseURL,
    baseURL: upstream.baseURL,
    apiKey: 'fixture-route-key',
    modelFormat: 'openai',
    npm: '@ai-sdk/openai-compatible',
    providerId: ref.providerId,
    authType: 'api',
    reasoning: true,
    supportedReasoningEfforts: ['low'],
  };
  const proxy = await startHttpProxy({ routes: [route], routing, proxyAuthToken: context.proxyToken,
    resolveClaudeCodeAuth: async () => { throw new Error('native authentication is not part of this adapter fixture'); } });

  try {
    const response = await sendBoundRequest(proxy, certificates.caCert, sessionId, binding.id, 'low', {}, body);

    expect(response.status).not.toContain('200');
    expect(upstream.calls).toHaveLength(0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
}, 20_000);

const currentRegistryDrifts = [
  { label: 'endpoint', sessionId: 'c4444444-4444-4444-8444-444444444444', change: (registered: ReturnType<typeof provider>) => ({ ...registered,
    api: { ...registered.api, url: `${registered.api.url}/changed` } }) },
  { label: 'SDK npm', sessionId: 'c5555555-5555-4555-8555-555555555555', change: (registered: ReturnType<typeof provider>) => ({ ...registered,
    api: { ...registered.api, npm: '@ai-sdk/openai' } }) },
  { label: 'wire format', sessionId: 'c6666666-6666-4666-8666-666666666666', change: (registered: ReturnType<typeof provider>) => ({ ...registered,
    modelsCache: { ...registered.modelsCache!, models: registered.modelsCache!.models.map(model => ({ ...model, modelFormat: 'openai' as const })) } }) },
  { label: 'upstream model ID', sessionId: 'c7777777-7777-4777-8777-777777777777', change: (registered: ReturnType<typeof provider>) => ({ ...registered,
    modelsCache: { ...registered.modelsCache!, models: registered.modelsCache!.models.map(model => ({ ...model, upstreamModelId: `${model.upstreamModelId}-changed` })) } }) },
];

async function startCurrentRegistryDrift(sessionId: string) {
  assertIsolatedRoutingSession(sessionId);
  const upstream = await startUpstream();
  const registeredProvider = provider({
    id: ref.providerId,
    templateId: 'fixture',
    api: { npm: '@ai-sdk/anthropic', url: upstream.baseURL },
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', source: 'account', models: [{
      id: ref.modelId,
      name: ref.modelId,
      upstreamModelId,
      modelFormat: 'anthropic',
      reasoning: true,
      supportedReasoningEfforts: ['low'],
      contextWindow: 100_000,
      outputTokenLimit: 12_000,
      pricing: { input: 2, output: 8, source: 'fixture-price' },
    }] },
  });
  const registryPath = getProvidersPath();
  expect(inside(outerHome!, registryPath)).toBe(true);
  saveRegistry({ schemaVersion: 1, providers: [registeredProvider] });
  const snapshot = input([registeredProvider], {
    credentials: [observation(ref.providerId)],
    discovery: [{ providerId: ref.providerId, status: 'live', cacheFetchedAt: '2026-10-01T00:00:00.000Z' }],
  });
  const config: RoutingConfig = { enabled: true, cheapFallback: ref, pool: [ref],
    categories: { implementation: { target: ref, effort: 'low' } } };
  const catalog = buildRoutingCatalog(snapshot);
  const workload = { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 };
  const statePath = routingBindingStatePath(sessionId);
  expect(inside(outerHome!, dirname(statePath))).toBe(true);
  const binding = await createRoutingBinding({ sessionId, launchId: `launch-${sessionId}`, role: 'specialist',
    category: 'implementation', task: 'Keep this model identity pinned', config, catalog, workload });
  const { proxyToken: _proxyToken, ...routing } = { routerTarget: ref, config, catalog, workload, proxyToken: 'fixture-drift-token' };
  const certificates = ensureHttpProxyCertificates();
  const route: ProxyRoute = {
    aliasId: httpProxyModelId(ref.providerId, ref.modelId),
    realModelId: upstreamModelId,
    displayName: 'Fixture current-registry drift model',
    upstreamUrl: upstream.baseURL,
    baseURL: upstream.baseURL,
    apiKey: 'synthetic-route-key',
    modelFormat: 'anthropic',
    npm: '@ai-sdk/anthropic',
    providerId: ref.providerId,
    authType: 'oauth',
    reasoning: true,
    supportedReasoningEfforts: ['low'],
  };
  const proxy = await startHttpProxy({ routes: [route], routing, proxyAuthToken: 'fixture-drift-token',
    resolveClaudeCodeAuth: async () => { throw new Error('Native credentials are not part of this direct route fixture.'); } });
  return { upstream, binding, registryPath, certificates, proxy };
}

it.each(currentRegistryDrifts)('rejects a non-pool binding when current registry $label changed after startup', async ({ sessionId, change }) => {
  const { upstream, binding, registryPath, certificates, proxy } = await startCurrentRegistryDrift(sessionId);
  const applyPolicy = vi.spyOn(requestPolicy, 'applyRequestContextPolicy');
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const current = loadRegistry();
    expect(inside(outerHome!, registryPath)).toBe(true);
    current.providers = [change(current.providers[0]!)];
    saveRegistry(current);

    const consumer = await registerConsumer(proxy.port, sessionId, proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(proxy.port, sessionId, consumerId, proxy.token);
    expect((await notices.connected).status).toBe(200);
    const request = sendBoundRequest(proxy, certificates.caCert, sessionId, binding.id, 'low');
    await acknowledgeLaunchNotice(proxy.port, sessionId, consumerId, proxy.token, notices);
    const response = await request;
    const restored = await resolveRoutingBinding({ sessionId, modelId: binding.id });

    expect(response.status, JSON.stringify(response.body)).toContain('400');
    expect({ error: response.body.error, upstreamRequests: upstream.calls.length,
      policyCalls: applyPolicy.mock.calls.length }).toMatchObject({
      error: { code: routingBindingErrors.identityMismatch }, upstreamRequests: 0, policyCalls: 0,
    });
    const { estimate: baselineEstimate, events: baselineEvents, ...baselineSelection } = binding.decision;
    const { estimate: restoredEstimate, events: restoredEvents, ...restoredSelection } = restored.decision;
    expect(restoredSelection).toEqual(baselineSelection);
    expect(restoredEstimate.kind).toBe(baselineEstimate.kind);
    expect(restoredEstimate.snapshot).toEqual(baselineEstimate.snapshot);
    expect(restoredEvents).toEqual([...baselineEvents, {
      reason: 'request_cost_estimate_uncached_bytes', target: binding.decision.target,
    }]);
    expect(restored.identity).toEqual(binding.identity);
    expect(restored.revision).toBe(binding.revision);
    expect(restored.fallbackAuthorization).toEqual(binding.fallbackAuthorization);
    expect(restored.attemptedTargets).toEqual(binding.attemptedTargets);
  } finally {
    applyPolicy.mockRestore();
    notices?.close();
    await proxy.close();
    await upstream.close();
  }
}, 20_000);
