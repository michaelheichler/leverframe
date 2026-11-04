import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { dirname, relative, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildRoutingCatalog } from '../src/model-routing.js';
import { startHttpProxy } from '../src/http-proxy/server.js';
import { httpProxyModelId } from '../src/http-proxy/routes.js';
import { savePreferences } from '../src/config.js';
import { getInferenceRequestLogPath, resetTraceLog } from '../src/log-paths.js';
import { getAppHome, getProvidersPath } from '../src/paths.js';
import { saveRegistry } from '../src/registry/io.js';
import type { ProxyRoute } from '../src/proxy.js';
import type { RoutingControlContext } from '../src/proxy-routing-control.js';
import { decideRouting } from '../src/routing-policy.js';
import { ROUTING_SIGNATURE_VERSION, routingSelectorCandidateVersion } from '../src/routing-selector-versions.js';
import { resolveRoutingBinding, routingBindingEvents, routingBindingStatePath } from '../src/routing-bindings.js';
import type { SelectorPayload } from '../src/routing-selector.js';
import type { ModelRef } from '../src/model-routing.js';
import { input, nativeProviderWithRoutingMetadata, observation, provider } from './model-routing-fixtures.js';
import { prepareAndLaunch } from './fixtures/model-routing-handoff-control.js';
import { readNoticeSequence, registerConsumer, requestJson } from './fixtures/model-routing-proxy.js';

const pool = [
  { providerId: 'selector-pool-a', modelId: 'selector-model-a' },
  { providerId: 'selector-pool-b', modelId: 'selector-model-b' },
];
const selectorTarget = { providerId: 'selector-provider', modelId: 'selector-model' };
const proxyToken = 'selector-control-fixture-token';
const testHome = process.env['LEVERFRAME_TEST_HOME'];
const loopbackFetch = globalThis.fetch.bind(globalThis);

afterEach(() => vi.unstubAllGlobals());

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function modelProvider(ref: typeof selectorTarget, price: number) {
  return provider({
    id: ref.providerId,
    templateId: 'fixture',
    billing: { kind: 'metered', source: 'fixture-billing', observedAt: '2026-10-01T00:00:00.000Z' },
    modelsCache: {
      fetchedAt: '2026-10-01T00:00:00.000Z', source: 'account', models: [{
        id: ref.modelId,
        name: ref.modelId,
        upstreamModelId: `upstream-${ref.modelId}`,
        modelFormat: 'anthropic',
        contextWindow: 70_000,
        outputTokenLimit: 8_192,
        supportedParameters: ['tools'],
        supportedReasoningEfforts: ['low'],
        pricing: { input: price, output: price, source: 'fixture-pricing' },
      }],
    },
  });
}

function selectorContext(withEvaluation: boolean): RoutingControlContext {
  const providers = [modelProvider(pool[0]!, 10), modelProvider(pool[1]!, 10), modelProvider(selectorTarget, 0.01)];
  const snapshot = input(providers, {
    credentials: providers.map(item => observation(item.id)),
    discovery: providers.map(item => ({ providerId: item.id, status: 'live' as const, cacheFetchedAt: '2026-10-01T00:00:00.000Z' })),
  });
  const catalog = buildRoutingCatalog(snapshot);
  const config: RoutingControlContext['config'] = {
    enabled: true,
    cheapFallback: pool[0],
    pool,
    categories: { implementation: { effort: 'low' } },
    selector: {
      enabled: true,
      target: selectorTarget,
      maxExtraCallsPerTask: 1,
      maxOutputTokens: 24,
      ...(withEvaluation ? { evaluationEvidence: [] } : {}),
    },
  };
  if (withEvaluation) {
    const decision = decideRouting({ config, catalog, role: 'specialist', category: 'implementation', effort: 'low',
      workload: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 } });
    config.selector!.evaluationEvidence = [{
      category: 'implementation',
      effort: 'low',
      candidateSetVersion: routingSelectorCandidateVersion({ decision, catalog, category: 'implementation', effort: 'low' }),
      signatureVersion: ROUTING_SIGNATURE_VERSION,
      sampleSize: 3,
      sourceEvaluationId: 'fixture-evaluation',
      measuredAt: '2026-10-01T00:00:00.000Z',
      expiresAt: '2027-10-01T00:00:00.000Z',
      avoidedTokens: { input: 500, output: 100 },
    }];
  }
  return {
    proxyToken,
    config,
    catalog,
    workload: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
  };
}

async function startControl(context: RoutingControlContext) {
  const { proxyToken: _token, ...routing } = context;
  const proxy = await startHttpProxy({ routes: [], routing, proxyAuthToken: proxyToken });
  return { proxy, endpoint: `http://${proxy.host}:${proxy.port}/v1/leverframe/routing-launch`, context };
}

async function startSelectorControl(context: RoutingControlContext,
  responseForRequest?: (attempt: number) => { status: number; body: Record<string, unknown>;
    headers?: Record<string, string> } | undefined,
  options: { routeNpm?: string } = {}) {
  const upstreamBodies: Record<string, unknown>[] = [];
  const upstreamHeaderNames: string[][] = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    await once(req, 'end');
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
    upstreamHeaderNames.push(Object.keys(req.headers).map(name => name.toLowerCase()));
    const response = responseForRequest?.(upstreamBodies.length);
    if (response) {
      res.writeHead(response.status, { ...response.headers, 'content-type': 'application/json' });
      res.end(JSON.stringify(response.body));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'fixture-selector-completion', object: 'chat.completion', created: 1,
      model: 'fixture-selector-upstream', choices: [{ index: 0,
        message: { role: 'assistant', content: JSON.stringify(pool[1]) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('selector provider fixture did not bind');
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  const route: ProxyRoute = {
    aliasId: httpProxyModelId(selectorTarget.providerId, selectorTarget.modelId),
    realModelId: 'fixture-selector-upstream', displayName: 'Fixture selector model', upstreamUrl: baseURL,
    baseURL, apiKey: 'fixture-selector-provider-key', modelFormat: 'openai',
    npm: options.routeNpm ?? '@ai-sdk/openai-compatible', providerId: selectorTarget.providerId,
  };
  const { proxyToken: _token, ...routing } = context;
  const proxy = await startHttpProxy({ routes: [route], routing, proxyAuthToken: proxyToken,
    resolveClaudeCodeAuth: async () => { throw new Error('native credentials are not part of this SDK selector fixture'); } });
  return {
    proxy,
    endpoint: `http://${proxy.host}:${proxy.port}/v1/leverframe/routing-launch`,
    context,
    upstreamBodies,
    upstreamHeaderNames,
    close: async () => {
      await proxy.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    },
  };
}

async function startNativeSelectorReadinessFixture() {
  const { native } = nativeProviderWithRoutingMetadata();
  const account = native.accounts![0]!;
  const nativeTarget = { providerId: native.id, modelId: account.modelsCache!.models[0]!.id };
  const providers = [modelProvider(pool[0]!, 10), modelProvider(pool[1]!, 10), native];
  const catalog = buildRoutingCatalog(input(providers, {
    credentials: [observation(pool[0]!.providerId), observation(pool[1]!.providerId),
      observation(native.id, 'oauth'), { ...observation(native.id, 'oauth'), accountId: account.id }],
    discovery: [{ providerId: pool[0]!.providerId, status: 'live', cacheFetchedAt: '2026-10-01T00:00:00.000Z' },
      { providerId: pool[1]!.providerId, status: 'live', cacheFetchedAt: '2026-10-01T00:00:00.000Z' },
      { providerId: native.id, status: 'live', cacheFetchedAt: native.modelsCache!.fetchedAt },
      { providerId: native.id, accountId: account.id, status: 'live', cacheFetchedAt: account.modelsCache!.fetchedAt }],
  }));
  const context = Object.assign(selectorContext(true), { selectorRequiresNotice: true });
  context.catalog = catalog;
  context.config.selector!.target = nativeTarget;
  const decision = decideRouting({ config: context.config, catalog, role: 'specialist', category: 'implementation',
    effort: 'low', workload: context.workload });
  context.config.selector!.evaluationEvidence = [{ category: 'implementation', effort: 'low',
    candidateSetVersion: routingSelectorCandidateVersion({ decision, catalog, category: 'implementation', effort: 'low' }),
    signatureVersion: ROUTING_SIGNATURE_VERSION, sampleSize: 3, sourceEvaluationId: 'fixture-native-selector-evaluation',
    measuredAt: '2026-10-01T00:00:00.000Z', expiresAt: '2027-10-01T00:00:00.000Z',
    avoidedTokens: { input: 500, output: 100 } }];

  const selectorRequests: Array<Record<string, unknown>> = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    await once(req, 'end');
    selectorRequests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(pool[1]) }],
      usage: { input_tokens: 5, output_tokens: 2 } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('native selector readiness fixture did not bind');
  const localOrigin = `http://127.0.0.1:${address.port}`;
  const nativeRoutingFetch: typeof fetch = async (request, init) => {
    const requested = request instanceof Request ? new URL(request.url) : new URL(String(request));
    if (requested.origin !== 'https://api.anthropic.com') throw new Error('Native selector requires the canonical origin.');
    const loopback = new URL(`${requested.pathname}${requested.search}`, localOrigin);
    if (loopback.hostname !== '127.0.0.1') throw new Error('Native selector test transport is loopback-only.');
    return loopbackFetch(loopback, init);
  };
  let resolveAuthStarted!: () => void;
  const authStarted = new Promise<void>(resolve => { resolveAuthStarted = resolve; });
  let releaseAuth!: () => void;
  const authGate = new Promise<void>(resolve => { releaseAuth = resolve; });
  let authReads = 0;
  const { proxyToken, ...routing } = context;
  const proxy = await startHttpProxy({ routes: [], routing, proxyAuthToken: proxyToken,
    nativeRoutingFetch,
    resolveClaudeCodeAuth: async () => {
      authReads++;
      resolveAuthStarted();
      await authGate;
      return { kind: 'oauth', token: 'fixture-native-selector-token' };
    } });
  return { context, proxy, selectorRequests, authStarted, releaseAuth, authReads: () => authReads,
    endpoint: `http://${proxy.host}:${proxy.port}/v1/leverframe/routing-launch`,
    close: async () => {
      releaseAuth();
      await proxy.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    } };
}

async function launch(endpoint: string, context: RoutingControlContext, selectorEvidence?: unknown, sessionId = 'selector-control-session') {
  return prepareAndLaunch(endpoint, context, {
    sessionId, launchId: randomUUID(), agentType: 'reviewer', category: 'implementation',
    effort: 'low', task: 'Review a fixture', selectorEvidence,
  });
}

const validEvidence = {
  features: { size: 'small', turns: 'few', tools: 'none', recentFailures: 0 },
  workload: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
  selectorWorkload: { input: 500, output: 24, cacheRead: 0, cacheWrite: 0 },
};

it('skips paid selector dispatch and records unavailable metadata when the launch has no selector evidence', async () => {
  const call = vi.fn(async () => pool[1]!);
  const { proxy, endpoint, context } = await startControl({ ...selectorContext(false), selectorTransport: call });

  try {
    const { preparation, launch: response } = await launch(endpoint, context);
    const result = response.body as { modelId: string };
    const binding = await resolveRoutingBinding({ sessionId: 'selector-control-session', modelId: result.modelId });

    expect(preparation.status).toBe(200);
    expect(response.status).toBe(200);
    expect(call).not.toHaveBeenCalled();
    expect(binding.decision.events).toContainEqual({ reason: routingBindingEvents.selectorMetadataUnavailable });
  } finally {
    await proxy.close();
  }
});

it.each([
  { label: 'negative cache usage', evidence: { ...validEvidence, workload: { ...validEvidence.workload, cacheRead: -1 } } },
  { label: 'unsupported cache TTL metadata', evidence: { ...validEvidence, workload: { ...validEvidence.workload, cacheWrites: 1 } } },
])('rejects $label before dispatching a paid call', async ({ evidence }) => {
  const call = vi.fn(async () => pool[1]!);
  const { proxy, endpoint, context } = await startControl({ ...selectorContext(true), selectorTransport: call });

  try {
    const { preparation, launch: response } = await launch(endpoint, context, evidence);

    expect(preparation.status).toBe(200);
    expect(response.status).toBe(400);
    expect(call).not.toHaveBeenCalled();
  } finally {
    await proxy.close();
  }
});

it('uses host-owned selector versions and bounded evidence to select an eligible pool model', async () => {
  const call = vi.fn(async (_target: ModelRef, _payload: SelectorPayload, _signal: AbortSignal) => pool[1]!);
  const { proxy, endpoint, context } = await startControl({ ...selectorContext(true), selectorTransport: call });

  try {
    const { preparation, launch: response } = await launch(endpoint, context, { ...validEvidence, candidateSetVersion: 'client-version', signatureVersion: 'client-signature' });
    const result = response.body as { modelId: string; policyModelId: string };
    const payload = call.mock.calls[0]?.[1];

    expect(preparation.status).toBe(200);
    expect(response.status).toBe(200);
    expect(call).toHaveBeenCalledTimes(1);
    expect(result.policyModelId).toContain(pool[1]!.modelId);
    expect(result.modelId).not.toBe(result.policyModelId);
    expect(payload).toMatchObject({ category: 'implementation', effort: 'low', maxOutputTokens: 24 });
    expect(payload?.taskSignature).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(payload)).not.toContain('Review a fixture');
  } finally {
    await proxy.close();
  }
});

it('does not dispatch or reserve selector inference without a connected notice consumer', async () => {
  const context = Object.assign(selectorContext(true), { selectorRequiresNotice: true });
  const inferenceLogPath = getInferenceRequestLogPath();
  expect(testHome).toBeTruthy();
  expect(isInside(testHome!, dirname(inferenceLogPath))).toBe(true);
  resetTraceLog(inferenceLogPath);
  writeFileSync(inferenceLogPath, '', { mode: 0o600 });
  const expected = decideRouting({ config: context.config, catalog: context.catalog, role: 'specialist',
    category: 'implementation', effort: 'low', workload: context.workload });
  const service = await startSelectorControl(context);
  const sessionId = randomUUID();

  try {
    const { preparation, launch: response } = await launch(service.endpoint, context, validEvidence, sessionId);
    const result = response.body as { modelId: string };
    const binding = await resolveRoutingBinding({ sessionId, modelId: result.modelId });

    expect(preparation.status).toBe(200);
    expect(response.status).toBe(200);
    expect(service.upstreamBodies).toEqual([]);
    expect(binding.selectorCalls).toBe(0);
    expect(binding.decision.target).toEqual(expected.target);
    const selectorLogs = readFileSync(inferenceLogPath, 'utf8').split('\n').filter(line => line.length > 0)
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(entry => typeof entry.event === 'string' && entry.event.startsWith('routing_selector_'));
    expect(selectorLogs.find(entry => entry.event === 'routing_selector_outcome')).toMatchObject({
      event: 'routing_selector_outcome', reason: 'selector_notice_unavailable',
    });
    expect(selectorLogs.filter(entry => entry.event === 'routing_selector_send')).toEqual([]);
  } finally {
    await service.close();
    resetTraceLog(inferenceLogPath);
  }
}, 10_000);

it('rejects selector inference after its consumer reconnects during delayed native credential preparation', async () => {
  const service = await startNativeSelectorReadinessFixture();
  const sessionId = randomUUID();
  let firstReader: ReturnType<typeof readNoticeSequence> | undefined;
  let secondReader: ReturnType<typeof readNoticeSequence> | undefined;
  let launchRequest: ReturnType<typeof prepareAndLaunch> | undefined;

  try {
    const registered = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    expect(registered.status).toBe(200);
    const consumerId = String(registered.body.consumerId);
    firstReader = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    const firstConnection = await firstReader.connected;
    expect(firstConnection.status).toBe(200);
    launchRequest = prepareAndLaunch(service.endpoint, service.context, {
      sessionId, launchId: randomUUID(), agentType: 'reviewer', category: 'implementation', effort: 'low',
      task: 'Review the controlled selector fixture.', selectorEvidence: validEvidence,
    });
    const progress = await Promise.race([
      service.authStarted.then(() => ({ kind: 'auth-started', eventReasons: [] as string[] })),
      launchRequest.then(async result => {
        return { kind: 'launch-finished', status: result.launch.status,
          responseKeys: Object.keys(result.launch.body), error: result.launch.body['error'] };
      }),
    ]);
    expect(progress.kind, JSON.stringify(progress)).toBe('auth-started');
    firstConnection.close();
    await firstConnection.closed;

    const renewal = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ready', service.proxy.token,
      { sessionId, protocolVersion: 1, consumerId });
    expect(renewal).toMatchObject({ status: 200, body: { consumerId } });
    secondReader = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    expect((await secondReader.connected).status).toBe(200);
    service.releaseAuth();
    const launched = await launchRequest;
    const result = launched.launch.body as { modelId: string };
    const binding = await resolveRoutingBinding({ sessionId, modelId: result.modelId });

    expect(launched.preparation.status).toBe(200);
    expect(launched.launch.status).toBe(200);
    expect(service.selectorRequests).toEqual([]);
    expect(binding.decision.target).toEqual(pool[0]);
  } finally {
    service.releaseAuth();
    firstReader?.close();
    secondReader?.close();
    await Promise.allSettled([launchRequest ?? Promise.resolve({
      preparation: { status: 0, body: {} }, launch: { status: 0, body: {} },
    })]);
    await service.close();
  }
}, 20_000);

it('sends an authenticated measured selector call through the internal adapter and persists its choice', async () => {
  const sessionId = 'selector-control-adapter-session';
  expect(testHome).toBeTruthy();
  expect(isInside(testHome!, dirname(routingBindingStatePath(sessionId)))).toBe(true);
  const inferenceLogPath = getInferenceRequestLogPath();
  expect(isInside(testHome!, dirname(inferenceLogPath))).toBe(true);
  resetTraceLog(inferenceLogPath);
  writeFileSync(inferenceLogPath, '', { mode: 0o600 });
  const context = selectorContext(true);
  const service = await startSelectorControl(context);
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    expect(consumer.status).toBe(200);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const { preparation, launch: response } = await launch(service.endpoint, context, validEvidence, sessionId);
    const result = response.body as { modelId: string; policyModelId: string };
    const binding = await resolveRoutingBinding({ sessionId, modelId: result.modelId });
    const request = service.upstreamBodies[0];

    expect(preparation.status).toBe(200);
    expect(response.status).toBe(200);
    expect(result.policyModelId).toBe(httpProxyModelId(pool[1]!.providerId, pool[1]!.modelId));
    expect(result.modelId).not.toBe(result.policyModelId);
    expect(binding.decision.target).toEqual(pool[1]);
    expect(binding.selectorCalls).toBe(1);
    expect(request?.model).toBe('fixture-selector-upstream');
    expect(JSON.stringify(request)).toContain('taskSignature');
    expect(JSON.stringify(request)).not.toContain('Review a fixture');
    expect(service.upstreamHeaderNames[0]?.filter(name => name.startsWith('x-leverframe-'))).toEqual([]);
    expect(service.upstreamHeaderNames[0]).not.toContain('x-relay-request-id');
    const selectorLogs = readFileSync(inferenceLogPath, 'utf8').split('\n').filter(line => line.length > 0)
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(entry => typeof entry.event === 'string' && entry.event.startsWith('routing_selector_'));
    const attempt = selectorLogs.find(entry => entry.event === 'routing_selector_attempt');
    const sent = selectorLogs.find(entry => entry.event === 'routing_selector_send');
    const outcome = selectorLogs.find(entry => entry.event === 'routing_selector_outcome');
    const usage = selectorLogs.find(entry => entry.event === 'routing_selector_usage');

    expect(attempt).toMatchObject({ event: 'routing_selector_attempt', provider: selectorTarget.providerId,
      model: selectorTarget.modelId });
    expect(sent).toMatchObject({ event: 'routing_selector_send', transport: 'guarded_http_send_invoked', acceptance: 'unknown' });
    expect(sent?.requestId).toBe(attempt?.requestId);
    expect(outcome).toMatchObject({ event: 'routing_selector_outcome', reason: 'selector_selected',
      provider: pool[1]!.providerId, model: pool[1]!.modelId });
    expect(outcome?.sessionHash).toBe(attempt?.sessionHash);
    expect(outcome?.launchHash).toBe(attempt?.launchHash);
    expect(usage).toMatchObject({ event: 'routing_selector_usage', usageIsCumulative: true,
      actualBilling: 'unknown', subscriptionConsumption: 'unknown',
      measuredApiEquivalent: { currency: 'USD', basis: 'provider_usage' } });
  } finally {
    notices?.close();
    await service.close();
    resetTraceLog(inferenceLogPath);
  }
});

it('reuses a managed selector cache result without another request or call reservation', async () => {
  const sessionId = randomUUID();
  const inferenceLogPath = getInferenceRequestLogPath();
  expect(testHome).toBeTruthy();
  expect(isInside(testHome!, dirname(inferenceLogPath))).toBe(true);
  resetTraceLog(inferenceLogPath);
  writeFileSync(inferenceLogPath, '', { mode: 0o600 });
  const context = selectorContext(true);
  const service = await startSelectorControl(context);
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    expect(consumer.status).toBe(200);
    notices = readNoticeSequence(service.proxy.port, sessionId, String(consumer.body.consumerId), service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const first = await launch(service.endpoint, context, validEvidence, sessionId);
    const firstBinding = await resolveRoutingBinding({ sessionId, modelId: String(first.launch.body['modelId']) });
    const second = await launch(service.endpoint, context, validEvidence, sessionId);
    const secondBinding = await resolveRoutingBinding({ sessionId, modelId: String(second.launch.body['modelId']) });
    const selectorLogs = readFileSync(inferenceLogPath, 'utf8').split('\n').filter(line => line.length > 0)
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(entry => typeof entry.event === 'string' && entry.event.startsWith('routing_selector_'));
    const sends = selectorLogs.filter(entry => entry.event === 'routing_selector_send');
    const cachedOutcome = selectorLogs.find(entry => entry.event === 'routing_selector_outcome'
      && entry.reason === 'selector_cache_hit');

    expect(first.preparation.status).toBe(200);
    expect(second.preparation.status).toBe(200);
    expect(first.launch.status).toBe(200);
    expect(second.launch.status).toBe(200);
    expect(second.launch.body['policyModelId']).toBe(first.launch.body['policyModelId']);
    expect(service.upstreamBodies).toHaveLength(1);
    expect(firstBinding.selectorCalls).toBe(1);
    expect(secondBinding.selectorCalls).toBe(0);
    expect(sends).toHaveLength(1);
    expect(cachedOutcome).toMatchObject({ event: 'routing_selector_outcome', inference: 'no_new_send' });
  } finally {
    notices?.close();
    await service.close();
    resetTraceLog(inferenceLogPath);
  }
});

it('bounds actual selector inference requests across a retryable upstream failure', async () => {
  const context = selectorContext(true);
  context.config.selector!.timeoutMs = 15_000;
  const failures = [{ status: 500, body: { error: { type: 'server_error', message: 'Local retryable fixture failure.' } } }];
  const service = await startSelectorControl(context, () => failures.shift());
  const sessionId = 'selector-control-attempt-cap-session';
  let notices: ReturnType<typeof readNoticeSequence> | undefined;
  vi.stubGlobal('fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = request instanceof Request ? new URL(request.url) : new URL(String(request));
    expect(url.hostname).toBe('127.0.0.1');
    return loopbackFetch(request, init);
  });

  try {
    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    expect(consumer.status).toBe(200);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const { preparation, launch: response } = await launch(service.endpoint, context, validEvidence, sessionId);
    const result = response.body as { modelId: string };
    const binding = await resolveRoutingBinding({ sessionId, modelId: result.modelId });

    expect(preparation.status).toBe(200);
    expect(response.status).toBe(200);
    expect(service.upstreamBodies).toHaveLength(1);
    expect(binding.selectorCalls).toBe(1);
    expect(binding.decision.target).toEqual(pool[0]);
  } finally {
    notices?.close();
    await service.close();
  }
}, 20_000);

it('counts a selector pool account failure against the one actual inference request budget', async () => {
  const context = selectorContext(true);
  const fetchedAt = '2026-10-01T00:00:00.000Z';
  const cachedModel = { id: selectorTarget.modelId, name: selectorTarget.modelId,
    upstreamModelId: 'fixture-selector-upstream', modelFormat: 'openai' as const,
    npm: '@ai-sdk/openai-compatible', apiUrl: 'https://routing-fixture.invalid/v1',
    contextWindow: 70_000, outputTokenLimit: 8_192, supportedReasoningEfforts: ['low'],
    pricing: { input: 0.01, output: 0.01, source: 'fixture-pricing' } };
  const accountCache = { fetchedAt, source: 'account' as const, models: [cachedModel] };
  const accountProvider = provider({ id: selectorTarget.providerId, templateId: 'fixture', authType: 'none',
    api: { npm: '@ai-sdk/openai-compatible', url: 'https://routing-fixture.invalid/v1' },
    modelsCache: { fetchedAt, models: [] },
    accounts: [
      { id: 'first-fixture-account', authRef: 'none:anonymous', enabled: true, modelsCache: accountCache },
      { id: 'second-fixture-account', authRef: 'none:anonymous', enabled: true, modelsCache: accountCache },
    ],
  });
  expect(testHome).toBeTruthy();
  expect(isInside(testHome!, getAppHome())).toBe(true);
  expect(isInside(testHome!, getProvidersPath())).toBe(true);
  saveRegistry({ schemaVersion: 1, providers: [accountProvider] });
  savePreferences({ accountPoolBalancing: false, accountPoolFailover: true });
  const service = await startSelectorControl(context, attempt => attempt === 1
    ? { status: 429, body: { error: { type: 'rate_limit_error', message: 'Local pool capacity fixture.' } } }
    : undefined);
  const sessionId = 'selector-pool-cap-session';
  let notices: ReturnType<typeof readNoticeSequence> | undefined;
  vi.stubGlobal('fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = request instanceof Request ? new URL(request.url) : new URL(String(request));
    if (url.hostname !== '127.0.0.1') throw new Error('Selector pool test permits loopback fetches only.');
    return loopbackFetch(request, init);
  });

  try {
    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    expect(consumer.status).toBe(200);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const { preparation, launch: response } = await launch(service.endpoint, context, validEvidence, sessionId);
    const result = response.body as { modelId: string };
    const binding = await resolveRoutingBinding({ sessionId, modelId: result.modelId });

    expect(preparation.status).toBe(200);
    expect(response.status).toBe(200);
    expect(service.upstreamBodies).toHaveLength(1);
    expect(binding.decision.target).toEqual(pool[0]);
  } finally {
    notices?.close();
    await service.close();
  }
}, 20_000);

it('rejects a selector redirect before any external transport request', async () => {
  const context = selectorContext(true);
  const service = await startSelectorControl(context, () => ({ status: 302, body: { redirect: true },
    headers: { location: 'https://outside.invalid/selector-redirect' } }));
  const sessionId = 'selector-redirect-refusal-session';
  const unsafeRedirectModes: string[] = [];
  const externalTransportAttempts: string[] = [];
  let notices: ReturnType<typeof readNoticeSequence> | undefined;
  vi.stubGlobal('fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = request instanceof Request ? new URL(request.url) : new URL(String(request));
    if (url.pathname.endsWith('/v1/messages') && init?.redirect !== 'error') {
      unsafeRedirectModes.push(url.origin);
      throw new Error('Selector fixture requires redirect refusal at the fetch boundary.');
    }
    if (url.hostname !== '127.0.0.1') {
      externalTransportAttempts.push(url.origin);
      throw new Error('Selector tests allow loopback requests only.');
    }
    return loopbackFetch(request, init);
  });

  try {
    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    expect(consumer.status).toBe(200);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const { preparation, launch: response } = await launch(service.endpoint, context, validEvidence, sessionId);
    const result = response.body as { modelId: string };
    const binding = await resolveRoutingBinding({ sessionId, modelId: result.modelId });

    expect(preparation.status).toBe(200);
    expect(response.status).toBe(200);
    expect(service.upstreamBodies).toHaveLength(1);
    expect(unsafeRedirectModes).toHaveLength(0);
    expect(externalTransportAttempts).toHaveLength(0);
    expect(binding.decision.target).toEqual(pool[0]);
  } finally {
    notices?.close();
    await service.close();
  }
}, 20_000);

it('uses deterministic selector fallback without sending a model request to an unsupported factory', async () => {
  const context = selectorContext(true);
  const service = await startSelectorControl(context, undefined, { routeNpm: '@ai-sdk/google' });
  vi.stubGlobal('fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = request instanceof Request ? new URL(request.url) : new URL(String(request));
    if (url.hostname !== '127.0.0.1') throw new Error('Selector tests allow loopback requests only.');
    return loopbackFetch(request, init);
  });

  try {
    const sessionId = 'selector-unsupported-factory-session';
    const { preparation, launch: response } = await launch(service.endpoint, context, validEvidence, sessionId);
    const result = response.body as { modelId: string };
    const binding = await resolveRoutingBinding({ sessionId, modelId: result.modelId });

    expect(preparation.status).toBe(200);
    expect(response.status).toBe(200);
    expect(service.upstreamBodies).toHaveLength(0);
    expect(binding.decision.target).toEqual(pool[0]);
  } finally {
    await service.close();
  }
}, 20_000);
