import { once } from 'node:events';
import * as http from 'node:http';
import { dirname, relative, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildRoutingCatalog } from '../src/model-routing.js';
import { httpProxyModelId } from '../src/http-proxy/routes.js';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { startHttpProxy } from '../src/http-proxy/server.js';
import type { ProxyRoute } from '../src/proxy.js';
import type { RoutingConfig } from '../src/model-routing.js';
import { createRoutingBinding, resolveRoutingBinding, routingBindingErrors, routingBindingStatePath } from '../src/routing-bindings.js';
import type { RoutingControlContext } from '../src/proxy-routing-control.js';
import { getProvidersPath } from '../src/paths.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';
import { input, observation, provider } from './model-routing-fixtures.js';
import { assertIsolatedRoutingSession, sendBoundRequest } from './fixtures/model-routing-proxy.js';

const accountAuth = vi.hoisted(() => ({ resolveProviderAccountAuth: vi.fn(async () => ({ apiKey: 'synthetic-account-key' })) }));
vi.mock('../src/env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/env.js')>();
  return { ...actual, resolveProviderAccountAuth: accountAuth.resolveProviderAccountAuth };
});
afterEach(() => accountAuth.resolveProviderAccountAuth.mockClear());

const sessionId = 'd1111111-1111-4111-8111-111111111111';
const ref = { providerId: 'fixture-count-token-provider', modelId: 'fixture-count-token-model' };
const accountId = 'fixture-count-token-account';
const modelUpstreamId = 'fixture-count-token-upstream';
const cacheTime = '2026-10-01T00:00:00.000Z';
const outerHome = process.env['LEVERFRAME_TEST_HOME'];

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

async function startUpstream() {
  const calls: string[] = [];
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    calls.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: 5 }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Count-token fixture did not bind to loopback.');
  return { calls, server, baseURL: `http://127.0.0.1:${address.port}` };
}

function createRegisteredProvider(baseURL: string, maxOutputTokens: number) {
  const modelCache = { fetchedAt: cacheTime, source: 'account' as const, models: [{
    id: ref.modelId, name: ref.modelId, upstreamModelId: modelUpstreamId, modelFormat: 'anthropic' as const,
    reasoning: true, supportedReasoningEfforts: ['low'], contextWindow: 64_000, outputTokenLimit: maxOutputTokens,
    pricing: { input: 2, output: 8, source: 'fixture-price' },
  }] };
  return provider({ id: ref.providerId, templateId: 'fixture',
    api: { npm: '@ai-sdk/anthropic', url: baseURL },
    accounts: [{ id: accountId, authRef: 'keyring:synthetic-count-token-account', enabled: true, modelsCache: modelCache }],
  });
}

async function createBoundProxy(baseURL: string, currentSession = sessionId, maxOutputTokens = 12_000) {
  const registeredProvider = createRegisteredProvider(baseURL, maxOutputTokens);
  const registryPath = getProvidersPath();
  expect(outerHome).toBeTruthy();
  expect(inside(outerHome!, registryPath)).toBe(true);
  saveRegistry({ schemaVersion: 1, providers: [registeredProvider] });
  const catalog = buildRoutingCatalog(input([registeredProvider], {
    credentials: [{ ...observation(ref.providerId), accountId }],
    discovery: [{ providerId: ref.providerId, accountId, status: 'live', cacheFetchedAt: cacheTime }],
  }));
  const config: RoutingConfig = { enabled: true, cheapFallback: ref, pool: [ref],
    categories: { implementation: { target: ref, effort: 'low' } } };
  const context: RoutingControlContext = { proxyToken: 'fixture-count-token-proxy-token', routerTarget: ref,
    config, catalog, workload: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 } };
  const binding = await createRoutingBinding({ sessionId: currentSession, launchId: 'count-token-identity-drift', role: 'specialist',
    category: 'implementation', task: 'Count tokens for the accepted account model', config, catalog, workload: context.workload });
  const statePath = routingBindingStatePath(sessionId);
  expect(inside(outerHome!, dirname(statePath))).toBe(true);
  let credentialReads = 0;
  const route: ProxyRoute = { aliasId: httpProxyModelId(ref.providerId, ref.modelId), accountId,
    realModelId: modelUpstreamId, displayName: 'Fixture account model', upstreamUrl: baseURL,
    get apiKey() { credentialReads += 1; return 'synthetic-route-key'; }, modelFormat: 'anthropic', npm: '@ai-sdk/anthropic',
    providerId: ref.providerId, authType: 'oauth', contextWindow: 64_000, outputTokenLimit: maxOutputTokens,
    reasoning: true, supportedReasoningEfforts: ['low'] };
  const { proxyToken: _proxyToken, ...routing } = context;
  const proxy = await startHttpProxy({ routes: [route], routing, proxyAuthToken: context.proxyToken });
  return { binding, proxy, catalog, readCredentialCount: () => credentialReads };
}

function changeCurrentAccountIdentity(): void {
  const current = loadRegistry();
  const account = current.providers[0]!.accounts![0]!;
  account.modelsCache!.models[0] = { ...account.modelsCache!.models[0]!, upstreamModelId: `${modelUpstreamId}-changed` };
  saveRegistry(current);
}

it('rejects a bound account count_tokens request after current model identity drift and before account auth', async () => {
  assertIsolatedRoutingSession(sessionId);
  accountAuth.resolveProviderAccountAuth.mockClear();
  const upstream = await startUpstream();
  const { binding, proxy } = await createBoundProxy(upstream.baseURL);
  const certificates = ensureHttpProxyCertificates();

  try {
    changeCurrentAccountIdentity();
    const response = await sendBoundRequest(proxy, certificates.caCert, sessionId, binding.id, 'low', {}, {}, false,
      '/v1/messages/count_tokens');
    const restored = await resolveRoutingBinding({ sessionId, modelId: binding.id });

    expect(accountAuth.resolveProviderAccountAuth).not.toHaveBeenCalled();
    expect(upstream.calls).toHaveLength(0);
    expect(response.status).toContain('400');
    expect(response.body).toMatchObject({ error: { code: routingBindingErrors.identityMismatch } });
    expect(restored.identity).toEqual(binding.identity);
    expect(restored.decision).toEqual(binding.decision);
  } finally {
    await proxy.close();
    upstream.server.closeAllConnections();
    await new Promise<void>(resolve => upstream.server.close(() => resolve()));
  }
}, 20_000);

it('rejects a non-pool request when the current account output cap shrinks before credential access', async () => {
  const cacheCapSession = 'd2222222-2222-4222-8222-222222222222';
  assertIsolatedRoutingSession(cacheCapSession);
  const upstream = await startUpstream();
  const { binding, proxy, readCredentialCount } = await createBoundProxy(upstream.baseURL, cacheCapSession, 128);
  const credentialReadsBefore = readCredentialCount();
  const certificates = ensureHttpProxyCertificates();

  try {
    const current = loadRegistry();
    const account = current.providers[0]!.accounts![0]!;
    const model = account.modelsCache!.models[0]!;
    account.modelsCache!.models[0] = { ...model, outputTokenLimit: 64 };
    saveRegistry(current);

    const response = await sendBoundRequest(proxy, certificates.caCert, cacheCapSession, binding.id, 'low');
    const restored = await resolveRoutingBinding({ sessionId: cacheCapSession, modelId: binding.id });

    expect(readCredentialCount()).toBe(credentialReadsBefore);
    expect(upstream.calls).toHaveLength(0);
    expect(response.status).not.toContain('200');
    expect(restored.identity).toEqual(binding.identity);
    expect(restored.decision.target).toEqual(binding.decision.target);
  } finally {
    await proxy.close();
    upstream.server.closeAllConnections();
    await new Promise<void>(resolve => upstream.server.close(() => resolve()));
  }
}, 20_000);
