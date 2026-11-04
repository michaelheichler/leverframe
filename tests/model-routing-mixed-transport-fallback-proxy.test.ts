import { once } from 'node:events';
import * as http from 'node:http';
import { dirname, relative, sep } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  resolveProviderAccountAuth: vi.fn(async (providerId: string, account: { id: string }) => {
    if (providerId.startsWith('fixture-mixed-') && account.id === 'missing') return { apiKey: '' };
    if (providerId.startsWith('fixture-mixed-') && ['default', 'usable'].includes(account.id)) return { apiKey: 'fixture-mixed-api-key' };
    throw new Error('Unexpected mixed transport credential lookup.');
  }),
}));
import { resolveProviderAccountAuth } from '../src/env.js';
import { buildRoutingCatalog, type ModelRef, type RoutingConfig } from '../src/model-routing.js';
import { createRoutingBinding, resolveRoutingBinding } from '../src/routing-bindings.js';
import { DEFAULT_LIFECYCLE_DEADLINES } from '../src/request-lifecycle.js';
import { getAppHome, getProvidersPath } from '../src/paths.js';
import { savePreferences } from '../src/config.js';
import { saveRegistry } from '../src/registry/io.js';
import { httpProxyModelId } from '../src/http-proxy/routes.js';
import type { ProxyRoute } from '../src/proxy.js';
import { input, observation, provider } from './model-routing-fixtures.js';
import { acknowledgment, acknowledgeLaunchNotice, blockNonLoopbackFetch, isolatedSessionId, noticeOrResponse, readNoticeSequence,
  registerConsumer, requestJson, safeResponseSummary, sendBoundRequest, startNativeService, startSdkService } from './fixtures/model-routing-proxy.js';
import type { ConnectedNoticeStream, NoticeStream } from './fixtures/model-routing-proxy.js';

const testHome = process.env['LEVERFRAME_TEST_HOME'];
const agentTool = { name: 'Agent', description: 'Delegate a reviewed task.', input_schema: { type: 'object' } };
const originalTotalTimeout = vi.hoisted(() => {
  const value = process.env['LEVERFRAME_TOTAL_TIMEOUT_MS'];
  process.env['LEVERFRAME_TOTAL_TIMEOUT_MS'] = '2000';
  return value;
});

afterAll(() => {
  if (originalTotalTimeout === undefined) delete process.env['LEVERFRAME_TOTAL_TIMEOUT_MS'];
  else process.env['LEVERFRAME_TOTAL_TIMEOUT_MS'] = originalTotalTimeout;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(resolveProviderAccountAuth).mockClear();
});

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function mixedTransportContext(endpoint: string, namespace: string, initial: 'native' | 'registry', apiFormat: 'openai' | 'anthropic',
  poolAccountIds?: string[]) {
  const fetchedAt = '2026-10-01T00:00:00.000Z';
  const nativeRef = { providerId: 'anthropic', modelId: `${namespace}-native-model` };
  const registryRef = { providerId: `fixture-mixed-${namespace}-registry`, modelId: `${namespace}-registry-model` };
  const nativeUpstreamModel = `${namespace}-native-upstream`;
  const registryUpstreamModel = `${namespace}-registry-upstream`;
  const nativeCache = { fetchedAt, source: 'harness' as const, models: [{
    id: nativeRef.modelId, name: nativeRef.modelId, upstreamModelId: nativeUpstreamModel,
    modelFormat: 'anthropic' as const, contextWindow: 70_000, outputTokenLimit: 12_000,
    supportedReasoningEfforts: ['low'], supportedParameters: ['tools'], supportsPromptCacheBreakpoints: true,
    pricing: { input: 2, output: 8, source: 'fixture-pricing' },
  }] };
  const registryModel = {
    id: registryRef.modelId, name: registryRef.modelId, upstreamModelId: registryUpstreamModel,
    modelFormat: apiFormat, npm: apiFormat === 'openai' ? '@ai-sdk/openai-compatible' : '@ai-sdk/anthropic',
    apiUrl: endpoint, contextWindow: 70_000, outputTokenLimit: 12_000,
    supportedReasoningEfforts: ['low'], supportedParameters: ['tools'],
    ...(apiFormat === 'anthropic' ? { supportsPromptCacheBreakpoints: true } : {}),
    pricing: { input: 2, output: 8, source: 'fixture-pricing' },
  };
  const registryCache = { fetchedAt, source: 'account' as const, models: [registryModel] };
  const nativeProvider = provider({ id: nativeRef.providerId, templateId: 'anthropic', credentialSource: 'claude-code',
    authType: 'oauth', billing: { kind: 'subscription', source: 'fixture-plan', observedAt: fetchedAt }, modelsCache: nativeCache });
  const registryProvider = provider({ id: registryRef.providerId, templateId: 'fixture', authType: 'api',
    api: { url: endpoint, npm: registryModel.npm }, modelsCache: registryCache,
    accounts: (poolAccountIds ?? ['default']).map(accountId => ({ id: accountId,
      authRef: poolAccountIds ? `keyring:provider:${registryRef.providerId}:${accountId}`
        : `keyring:provider:${registryRef.providerId}`, enabled: true, modelsCache: registryCache })) });
  const catalog = buildRoutingCatalog(input([nativeProvider, registryProvider], {
    credentials: [observation(nativeRef.providerId, 'oauth'), ...(poolAccountIds ?? ['default']).map(accountId => ({
      ...observation(registryRef.providerId, 'api_key'), accountId,
    }))],
    discovery: [{ providerId: nativeRef.providerId, status: 'live', cacheFetchedAt: fetchedAt },
      ...(poolAccountIds ?? ['default']).map(accountId => ({ providerId: registryRef.providerId, accountId,
        status: 'live' as const, cacheFetchedAt: fetchedAt }))],
  }));
  const initialRef = initial === 'native' ? nativeRef : registryRef;
  const fallbackRef = initial === 'native' ? registryRef : nativeRef;
  const config: RoutingConfig = { enabled: true, visibleModelId: 'auto', cheapFallback: initialRef,
    routerFallbacks: [fallbackRef], pool: [initialRef, fallbackRef] };
  const context = { proxyToken: 'fixture-mixed-proxy-token', routerTarget: initialRef, config, catalog,
    workload: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 } };
  if (!testHome) throw new Error('Isolated test home is required.');
  expect(isInside(testHome, getAppHome())).toBe(true);
  expect(isInside(testHome, dirname(getProvidersPath()))).toBe(true);
  saveRegistry({ schemaVersion: 1, providers: [registryProvider] });
  return { context, nativeRef, registryRef, nativeUpstreamModel, registryUpstreamModel };
}

function registryAnthropicRoute(endpoint: string, ref: ModelRef, upstreamModelId: string): ProxyRoute {
  return {
    aliasId: httpProxyModelId(ref.providerId, ref.modelId), realModelId: upstreamModelId,
    displayName: 'Fixture registry Anthropic model', upstreamUrl: endpoint, baseURL: endpoint,
    apiKey: 'fixture-mixed-api-key', modelFormat: 'anthropic', npm: '@ai-sdk/anthropic',
    providerId: ref.providerId, accountId: 'default', authType: 'api', contextWindow: 70_000,
    outputTokenLimit: 12_000, supportedParameters: ['tools'], supportsPromptCacheBreakpoints: true,
  };
}

async function startNoticeGatedMixedRequest(port: number, token: string, sessionId: string,
  createRequest: () => ReturnType<typeof sendBoundRequest>) {
  const consumer = await registerConsumer(port, sessionId, token);
  const consumerId = String(consumer.body.consumerId);
  const notices = readNoticeSequence(port, sessionId, consumerId, token);
  const connected = await notices.connected;
  expect(connected.status).toBe(200);
  const request = createRequest();
  await acknowledgeLaunchNotice(port, sessionId, consumerId, token, notices);
  return { consumerId, notices, connected, request };
}

function expectInitialMixedFallbackPending(input: {
  outcome: Awaited<ReturnType<typeof noticeOrResponse>>;
  notice: NoticeStream | undefined;
  sessionId: string;
  previous: ModelRef;
  target: ModelRef;
  primaryModel: string;
  upstreamBodies: Array<Record<string, unknown>>;
  nativeFetchCalls: number;
  downstreamEvents: Array<{ kind: 'headers' } | { kind: 'data' }>;
  system: Array<{ text: string }>;
}): void {
  expect(input.outcome.kind).toBe('notice');
  expect(input.notice?.notice).toMatchObject({ sessionId: input.sessionId, previous: input.previous,
    target: input.target, reason: 'credential_rejected', cacheReuse: 'unknown', acknowledged: false });
  expect(input.upstreamBodies).toHaveLength(1);
  expect(input.upstreamBodies[0]?.model).toBe(input.primaryModel);
  expect(input.nativeFetchCalls).toBe(0);
  expect(input.downstreamEvents).toEqual([]);
  expect(JSON.stringify(input.upstreamBodies[0])).toContain(input.system[0]!.text);
  expect(JSON.stringify(input.upstreamBodies[0])).toContain(input.system[1]!.text);
  expect(JSON.stringify(input.upstreamBodies[0]?.tools)).toContain(agentTool.name);
}

async function startMixedTransportUpstream(responseForRequest?: (body: Record<string, unknown>) => {
  status: number; body: Record<string, unknown> } | undefined) {
  const requests: Array<Record<string, unknown>> = [];
  let responseToFinish: http.ServerResponse | undefined;
  let bodyToFinish: Record<string, unknown> | undefined;
  let announceRequest!: () => void;
  const requestArrived = new Promise<void>(resolve => { announceRequest = resolve; });
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodyToFinish = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    requests.push(bodyToFinish);
    const configuredResponse = responseForRequest?.(bodyToFinish);
    if (configuredResponse) {
      res.writeHead(configuredResponse.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(configuredResponse.body));
      announceRequest();
      return;
    }
    responseToFinish = res;
    announceRequest();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mixed transport fixture did not bind to loopback.');
  return {
    endpoint: `http://127.0.0.1:${address.port}`, requests, requestArrived,
    finishResponse: () => {
      if (!responseToFinish || !bodyToFinish) throw new Error('The registry fallback request has not arrived.');
      responseToFinish.writeHead(200, { 'content-type': 'application/json' });
      responseToFinish.end(JSON.stringify({ id: 'fixture-mixed-registry-response', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'Fixture registry answer' }], model: bodyToFinish.model,
        stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } }));
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function startSdkNativeFallbackService(outcome: 'rejected' | 'unknown' | 'pending' = 'rejected',
  namespace = 'fixture-sdk-native', nativeAuthReader?: () => Promise<{ kind: 'oauth'; token: string } | null>,
  requestDeadlines?: ProxyRoute['requestDeadlines'], poolAccountIds?: string[],
  rejection?: { status: 402 | 429; outcome: 'quota' | 'credit' }) {
  let fixture!: ReturnType<typeof mixedTransportContext>;
  const observation = { nativeFetchCalls: 0, nativeAuthCalls: 0 };
  let startResponse!: () => void;
  const responseStarted = new Promise<void>(resolve => { startResponse = resolve; });
  let startPrimaryPending!: () => void;
  const primaryPending = new Promise<void>(resolve => { startPrimaryPending = resolve; });
  let closePrimaryPending!: () => void;
  const primaryPendingClosed = new Promise<void>(resolve => { closePrimaryPending = resolve; });
  let finishResponse: (() => void) | undefined;
  const firstResponseChunk = [
    'event: message_start',
    `data: ${JSON.stringify({ type: 'message_start', message: { id: 'fixture-mixed-native-message', type: 'message', role: 'assistant',
      model: `${namespace}-native-upstream`, content: [], usage: { input_tokens: 5, output_tokens: 0 } } })}`,
    '', 'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '', 'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Fixture mixed native answer"}}',
    '', '',
  ].join('\n');
  const finalResponseChunk = [
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" continues"}}',
    '', 'event: content_block_stop', 'data: {"type":"content_block_stop","index":0}',
    '', 'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}',
    '', 'event: message_stop', 'data: {"type":"message_stop"}', '', '',
  ].join('\n');
  const service = await startSdkService(endpoint => {
    fixture = mixedTransportContext(endpoint, namespace, 'registry', 'openai', poolAccountIds);
    return fixture.context;
  }, [], { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', ...(requestDeadlines ? { requestDeadlines } : {}),
    ...(poolAccountIds ? { poolAccountIds } : {}) },
  body => body.model !== fixture.registryUpstreamModel ? undefined
    : outcome === 'unknown' ? { disconnect: true } : outcome === 'pending' ? undefined : rejection
      ? { status: rejection.status, body: { error: { type: rejection.outcome === 'quota' ? 'rate_limit_error' : 'billing_error',
        message: 'Fixture registry account pool rejected the request.' } } }
      : { status: 401, body: { error: { type: 'authentication_error', message: 'Fixture registry credential rejected.' } } },
  (body, response) => {
    if (outcome === 'pending' && body.model === fixture.registryUpstreamModel) {
      response.once('close', closePrimaryPending);
      startPrimaryPending();
      return true;
    }
    if (body.model !== fixture.nativeUpstreamModel || body.stream !== true) return false;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    finishResponse = () => response.end(finalResponseChunk);
    response.write(firstResponseChunk, startResponse);
    return true;
  }, {
    fetchForEndpoint: endpoint => async (input, init) => {
      observation.nativeFetchCalls++;
      const requested = input instanceof Request ? new URL(input.url) : new URL(String(input));
      if (requested.origin !== 'https://api.anthropic.com') throw new Error('Native test transport must use the Anthropic origin.');
      const local = new URL(`${requested.pathname}${requested.search}`, new URL(endpoint).origin);
      if (local.hostname !== '127.0.0.1') throw new Error('Native test transport must stay on loopback.');
      return fetch(local, init);
    },
    resolveClaudeCodeAuth: async () => {
      observation.nativeAuthCalls++;
      return nativeAuthReader ? nativeAuthReader() : { kind: 'oauth', token: 'fixture-native-token' };
    },
  });
  return { service, fixture, observation, responseStarted, primaryPending, primaryPendingClosed,
    finishResponse: () => finishResponse?.() };
}

it('keeps one lease while a registry SDK request switches to native after an acknowledged rejection', async () => {
  blockNonLoopbackFetch();
  const session = isolatedSessionId();
  const system = [
    { type: 'text', text: 'First mixed cached system block', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'Second mixed cached system block', cache_control: { type: 'ephemeral' } },
  ];
  const { service, fixture, observation, responseStarted, finishResponse } = await startSdkNativeFallbackService();
  const initial = await createRoutingBinding({ sessionId: session, launchId: 'front-router', role: 'router', task: '',
    config: fixture.context.config, catalog: fixture.context.catalog, workload: fixture.context.workload });
  expect(initial.decision.target).toEqual(fixture.context.routerTarget);
  let stream: NoticeStream | undefined;
  let connectedStream: ConnectedNoticeStream | undefined;
  const downstreamEvents: Array<{ kind: 'headers' } | { kind: 'data' }> = [];
  let releaseDownstreamData!: () => void;
  const downstreamData = new Promise<void>(resolve => { releaseDownstreamData = resolve; });
  const downstreamEventCallbacks: Record<'headers' | 'data', () => void> = {
    headers: () => undefined,
    data: () => releaseDownstreamData(),
  };

  try {
    const started = await startNoticeGatedMixedRequest(service.proxy.port, service.proxy.token, session, () =>
      sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
      stream: true, output_config: {}, system, tools: [agentTool],
    }, false, '/v1/messages', item => {
      downstreamEvents.push(item);
      downstreamEventCallbacks[item.kind]();
    }));
    const { consumerId, notices, request } = started;
    connectedStream = started.connected;
    const observed = await noticeOrResponse(notices.nextNotice(), request);
    stream = observed.stream;

    expectInitialMixedFallbackPending({ outcome: observed, notice: stream, sessionId: session,
      previous: fixture.context.routerTarget!, target: fixture.nativeRef,
      primaryModel: fixture.registryUpstreamModel, upstreamBodies: service.upstreamBodies,
      nativeFetchCalls: observation.nativeFetchCalls, downstreamEvents, system });

    const pending = await resolveRoutingBinding({ sessionId: session, modelId: String(stream!.notice.modelId) });
    const lease = pending.lease;
    expect(lease).toBeTruthy();
    expect(pending.revision).toBe(stream!.notice.revision);
    const ack = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(stream!.notice, consumerId));
    await responseStarted;
    await downstreamData;
    expect(downstreamEvents).toContainEqual({ kind: 'data' });
    const inFlight = await resolveRoutingBinding({ sessionId: session, modelId: String(stream!.notice.modelId) });
    expect(inFlight.lease).toBe(lease);
    expect(inFlight.revision).toBe(pending.revision);
    expect(inFlight.decision.target).toEqual(fixture.nativeRef);
    finishResponse();
    const response = await request;

    expect(ack).toMatchObject({ status: 200, body: { acknowledged: true } });
    expect(observation.nativeFetchCalls).toBe(1);
    expect(service.upstreamBodies).toHaveLength(2);
    expect(service.upstreamBodies[1]?.model).toBe(fixture.nativeUpstreamModel);
    expect(service.upstreamBodies[1]?.system).toEqual(system);
    expect(service.upstreamBodies[1]?.tools).toEqual([agentTool]);
    expect(downstreamEvents).toContainEqual({ kind: 'headers' });
    expect(downstreamEvents).toContainEqual({ kind: 'data' });
    expect(response.status).toContain('200');
    expect(response.body.raw).toContain('Fixture mixed native answer');
    expect(response.body.raw).toContain('"model":"auto"');
  } finally {
    finishResponse();
    stream?.close();
    connectedStream?.close();
    await service.close();
  }
}, 20_000);

it('keeps one lease while a native request switches to a registry Anthropic account after ACK', async () => {
  blockNonLoopbackFetch();
  const session = isolatedSessionId();
  const upstream = await startMixedTransportUpstream();
  const fixture = mixedTransportContext(upstream.endpoint, 'fixture-native-registry', 'native', 'anthropic');
  const initial = await createRoutingBinding({ sessionId: session, launchId: 'front-router', role: 'router', task: '',
    config: fixture.context.config, catalog: fixture.context.catalog, workload: fixture.context.workload });
  expect(initial.decision.target).toEqual(fixture.nativeRef);
  const route = registryAnthropicRoute(upstream.endpoint, fixture.registryRef, fixture.registryUpstreamModel);
  const service = await startNativeService(fixture.context, { injectNativeRoutingFetch: true, routes: [route],
    responseForRequest: body => body.model === fixture.nativeUpstreamModel ? { status: 401,
      body: { error: { type: 'authentication_error', message: 'Fixture native credential rejected.' } } } : undefined });
  const system = [
    { type: 'text', text: 'First native cached system block', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'Second native cached system block', cache_control: { type: 'ephemeral' } },
  ];
  let stream: NoticeStream | undefined;
  let connectedStream: ConnectedNoticeStream | undefined;
  const downstreamEvents: Array<{ kind: 'headers' } | { kind: 'data' }> = [];

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    const notices = readNoticeSequence(service.proxy.port, session, consumerId, service.proxy.token);
    connectedStream = await notices.connected;
    expect(connectedStream.status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
      output_config: {}, system, tools: [agentTool],
    }, false, '/v1/messages', item => downstreamEvents.push(item));
    await acknowledgeLaunchNotice(service.proxy.port, session, consumerId, service.proxy.token, notices);
    const observed = await noticeOrResponse(notices.nextNotice(), request);
    stream = observed.stream;

    const afterAttempt = await resolveRoutingBinding({ sessionId: session, modelId: initial.modelId });
    expect(observed.kind, JSON.stringify({ summary: safeResponseSummary(observed), original: initial.decision.target,
      saved: afterAttempt.decision.target, reasons: afterAttempt.decision.events.map(event => event.reason) })).toBe('notice');
    expect(stream?.notice).toMatchObject({ sessionId: session, previous: fixture.nativeRef,
      target: fixture.registryRef, reason: 'credential_rejected', acknowledged: false });
    expect(service.observation.requests).toHaveLength(1);
    expect(service.observation.requests[0]?.body.system).toEqual(system);
    expect(upstream.requests).toEqual([]);
    expect(downstreamEvents).toEqual([]);

    const pending = await resolveRoutingBinding({ sessionId: session, modelId: String(stream!.notice.modelId) });
    const lease = pending.lease;
    expect(lease).toBeTruthy();
    expect(pending.revision).toBe(stream!.notice.revision);
    const ack = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(stream!.notice, consumerId));
    await upstream.requestArrived;
    const inFlight = await resolveRoutingBinding({ sessionId: session, modelId: String(stream!.notice.modelId) });
    expect(inFlight.lease).toBe(lease);
    expect(inFlight.revision).toBe(pending.revision);
    expect(inFlight.decision.target).toEqual(fixture.registryRef);
    upstream.finishResponse();
    const response = await request;

    expect(ack).toMatchObject({ status: 200, body: { acknowledged: true } });
    expect(service.observation.requests).toHaveLength(1);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.model).toBe(fixture.registryUpstreamModel);
    expect(upstream.requests[0]?.system).toEqual(system);
    expect(upstream.requests[0]?.tools).toEqual([agentTool]);
    expect(downstreamEvents).toContainEqual({ kind: 'headers' });
    expect(downstreamEvents).toContainEqual({ kind: 'data' });
    expect(response.status).toContain('200');
    expect(response.body.model).toBe('auto');
  } finally {
    stream?.close();
    connectedStream?.close();
    await service.close();
    await upstream.close();
  }
}, 20_000);

it.each([
  { status: 429 as const, outcome: 'quota' as const, reason: 'quota_exhausted' as const },
  { status: 402 as const, outcome: 'credit' as const, reason: 'credit_exhausted' as const },
])('advances a mixed SDK pool after a confirmed $status rejection and exact notice ACK', async rejection => {
  blockNonLoopbackFetch();
  savePreferences({ accountPoolBalancing: false, accountPoolFailover: true });
  const session = isolatedSessionId();
  const namespace = `fixture-sdk-mixed-pool-${rejection.status}`;
  const accountIds = ['missing', 'usable'];
  const { service, fixture, observation, responseStarted, finishResponse } = await startSdkNativeFallbackService(
    'rejected', namespace, undefined, undefined, accountIds, rejection);
  const downstreamEvents: Array<{ kind: 'headers' } | { kind: 'data' }> = [];
  let fallbackNotice: NoticeStream | undefined;
  let connectedStream: ConnectedNoticeStream | undefined;
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const started = await startNoticeGatedMixedRequest(service.proxy.port, service.proxy.token, session, () =>
      sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
        stream: true, output_config: {}, tools: [agentTool], system: [{ type: 'text', text: 'Mixed-pool SDK input' }],
      }, false, '/v1/messages', event => downstreamEvents.push(event)));
    notices = started.notices;
    connectedStream = started.connected;
    const observed = await noticeOrResponse(started.notices.nextNotice(), started.request);
    fallbackNotice = observed.stream;

    expect(service.upstreamBodies).toHaveLength(1);
    expect(service.upstreamBodies[0]?.model).toBe(fixture.registryUpstreamModel);
    expect(vi.mocked(resolveProviderAccountAuth).mock.calls.map(([providerId, account]) => [providerId, account.id]))
      .toEqual([[fixture.registryRef.providerId, 'missing'], [fixture.registryRef.providerId, 'usable']]);
    expect(observed.kind, JSON.stringify(safeResponseSummary(observed))).toBe('notice');
    expect(fallbackNotice?.notice).toMatchObject({ previous: fixture.context.routerTarget,
      target: fixture.nativeRef, reason: rejection.reason, acknowledged: false });
    expect(observation.nativeFetchCalls).toBe(0);
    expect(downstreamEvents).toEqual([]);

    const acknowledgmentResponse = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack',
      service.proxy.token, acknowledgment(fallbackNotice!.notice, started.consumerId));
    await responseStarted;
    finishResponse();
    const response = await started.request;

    expect(acknowledgmentResponse).toMatchObject({ status: 200, body: { acknowledged: true } });
    expect(observation.nativeFetchCalls).toBe(1);
    expect(service.upstreamBodies).toHaveLength(2);
    expect(service.upstreamBodies[1]?.model).toBe(fixture.nativeUpstreamModel);
    expect(response.status).toContain('200');
    expect(response.body.raw).toContain('"model":"auto"');
  } finally {
    finishResponse();
    fallbackNotice?.close();
    notices?.close();
    connectedStream?.close();
    await service.close();
  }
}, 20_000);

it.each([
  { status: 429 as const, reason: 'quota_exhausted' as const, type: 'rate_limit_error' },
  { status: 402 as const, reason: 'credit_exhausted' as const, type: 'billing_error' },
])('advances a mixed native pool after a confirmed $status rejection and exact notice ACK', async rejection => {
  blockNonLoopbackFetch();
  savePreferences({ accountPoolBalancing: false, accountPoolFailover: true });
  const session = isolatedSessionId();
  let fixture!: ReturnType<typeof mixedTransportContext>;
  const upstream = await startMixedTransportUpstream(body => body.model === fixture.registryUpstreamModel
    ? { status: rejection.status, body: { error: { type: rejection.type, message: 'Fixture pool rejection.' } } } : undefined);
  fixture = mixedTransportContext(upstream.endpoint, `fixture-native-mixed-pool-${rejection.status}`,
    'registry', 'anthropic', ['missing', 'usable']);
  const route = registryAnthropicRoute(upstream.endpoint, fixture.registryRef, fixture.registryUpstreamModel);
  delete route.accountId;
  const service = await startNativeService(fixture.context, { injectNativeRoutingFetch: true, routes: [route] });
  const downstreamEvents: Array<{ kind: 'headers' } | { kind: 'data' }> = [];
  let fallbackNotice: NoticeStream | undefined;
  let connectedStream: ConnectedNoticeStream | undefined;
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const started = await startNoticeGatedMixedRequest(service.proxy.port, service.proxy.token, session, () =>
      sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
        output_config: {}, tools: [agentTool], system: [{ type: 'text', text: 'Mixed-pool native input' }],
      }, false, '/v1/messages', event => downstreamEvents.push(event)));
    notices = started.notices;
    connectedStream = started.connected;
    const observed = await noticeOrResponse(started.notices.nextNotice(), started.request);
    fallbackNotice = observed.stream;

    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.model).toBe(fixture.registryUpstreamModel);
    expect(vi.mocked(resolveProviderAccountAuth).mock.calls.map(([providerId, account]) => [providerId, account.id]))
      .toEqual([[fixture.registryRef.providerId, 'missing'], [fixture.registryRef.providerId, 'usable']]);
    expect(observed.kind, JSON.stringify(safeResponseSummary(observed))).toBe('notice');
    expect(fallbackNotice?.notice).toMatchObject({ previous: fixture.registryRef,
      target: fixture.nativeRef, reason: rejection.reason, acknowledged: false });
    expect(service.observation.nativeFetchCalls).toBe(0);
    expect(service.observation.requests).toEqual([]);
    expect(downstreamEvents).toEqual([]);

    const acknowledgmentResponse = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack',
      service.proxy.token, acknowledgment(fallbackNotice!.notice, started.consumerId));
    const response = await started.request;

    expect(acknowledgmentResponse).toMatchObject({ status: 200, body: { acknowledged: true } });
    expect(upstream.requests).toHaveLength(1);
    expect(service.observation.nativeFetchCalls).toBe(1);
    expect(service.observation.requests).toHaveLength(1);
    expect(service.observation.requests[0]?.body.model).toBe(fixture.nativeUpstreamModel);
    expect(response.status).toContain('200');
    expect(response.body.model).toBe('auto');
  } finally {
    fallbackNotice?.close();
    notices?.close();
    connectedStream?.close();
    await service.close();
    await upstream.close();
  }
}, 20_000);

it('does not cross from a registry SDK attempt to native after upstream acceptance is unknown', async () => {
  blockNonLoopbackFetch();
  const session = isolatedSessionId();
  const { service, fixture, observation } = await startSdkNativeFallbackService('unknown', 'fixture-sdk-native-unknown');
  const initial = await createRoutingBinding({ sessionId: session, launchId: 'front-router', role: 'router', task: '',
    config: fixture.context.config, catalog: fixture.context.catalog, workload: fixture.context.workload });
  expect(initial.decision.target).toEqual(fixture.context.routerTarget);
  let connectedStream: ConnectedNoticeStream | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    const notices = readNoticeSequence(service.proxy.port, session, consumerId, service.proxy.token);
    connectedStream = await notices.connected;
    expect(connectedStream.status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto');
    await acknowledgeLaunchNotice(service.proxy.port, session, consumerId, service.proxy.token, notices);
    const observed = await noticeOrResponse(notices.nextNotice(), request);
    const response = await request;

    expect(observed.kind, JSON.stringify({ summary: safeResponseSummary(observed),
      noticeReason: observed.stream?.notice.reason, upstreamModels: service.upstreamBodies.map(body => body.model),
      nativeFetchCalls: observation.nativeFetchCalls })).toBe('response');
    expect(response.status, JSON.stringify({ ...safeResponseSummary({ kind: 'response', response }),
      upstreamModels: service.upstreamBodies.map(body => body.model), nativeFetchCalls: observation.nativeFetchCalls,
      nativeAuthCalls: observation.nativeAuthCalls })).not.toContain('200');
    expect(service.upstreamBodies, JSON.stringify({ summary: safeResponseSummary(observed), target: initial.decision.target }))
      .toHaveLength(1);
    expect(service.upstreamBodies[0]?.model).toBe(fixture.registryUpstreamModel);
    expect(observation.nativeFetchCalls).toBe(0);
  } finally {
    connectedStream?.close();
    await service.close();
  }
}, 20_000);

it('does not send to native after the notice consumer disconnects during auth preparation', async () => {
  blockNonLoopbackFetch();
  const session = isolatedSessionId();
  let beginAuth!: () => void;
  let releaseAuth!: () => void;
  const authStarted = new Promise<void>(resolve => { beginAuth = resolve; });
  const authResult = new Promise<{ kind: 'oauth'; token: string }>(resolve => {
    releaseAuth = () => resolve({ kind: 'oauth', token: 'fixture-native-token' });
  });
  const { service, fixture, observation } = await startSdkNativeFallbackService('rejected',
    'fixture-sdk-native-auth-disconnect', () => { beginAuth(); return authResult; });
  let stream: NoticeStream | undefined;
  let connectedStream: ConnectedNoticeStream | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    const notices = readNoticeSequence(service.proxy.port, session, consumerId, service.proxy.token);
    connectedStream = await notices.connected;
    expect(connectedStream.status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
      stream: true, output_config: {}, tools: [agentTool],
    }, false, '/v1/messages');
    await acknowledgeLaunchNotice(service.proxy.port, session, consumerId, service.proxy.token, notices);
    const observed = await noticeOrResponse(notices.nextNotice(), request);
    stream = observed.stream;
    expect(observed.kind).toBe('notice');
    expect(service.upstreamBodies).toHaveLength(1);
    expect(service.upstreamBodies[0]?.model).toBe(fixture.registryUpstreamModel);
    const ack = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(stream!.notice, consumerId));
    await authStarted;
    stream!.close();
    await stream!.closed;
    const disconnectedAck = await vi.waitFor(async () => {
      const result = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
        acknowledgment(stream!.notice, consumerId));
      expect(result.status).toBe(409);
      return result;
    }, { interval: 10, timeout: 1_000 });
    releaseAuth();
    const response = await request;

    expect(ack).toMatchObject({ status: 200, body: { acknowledged: true } });
    expect(disconnectedAck.status).toBe(409);
    expect(response.status, JSON.stringify({ ...safeResponseSummary({ kind: 'response', response }),
      responseKeys: Object.keys(response.body), nativeFetchCalls: observation.nativeFetchCalls,
      upstreamModels: service.upstreamBodies.map(body => body.model) })).not.toContain('200');
    expect(response.body).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
    expect(observation.nativeAuthCalls).toBe(1);
    expect(observation.nativeFetchCalls).toBe(0);
    expect(service.upstreamBodies).toHaveLength(1);
  } finally {
    releaseAuth();
    stream?.close();
    connectedStream?.close();
    await service.close();
  }
}, 10_000);

it('continues the acknowledged native stream after its notice consumer disconnects following output', async () => {
  blockNonLoopbackFetch();
  const session = isolatedSessionId();
  const { service, fixture, observation, responseStarted, finishResponse } = await startSdkNativeFallbackService(
    'rejected', 'fixture-sdk-native-output-disconnect');
  let stream: NoticeStream | undefined;
  let connectedStream: ConnectedNoticeStream | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    const notices = readNoticeSequence(service.proxy.port, session, consumerId, service.proxy.token);
    connectedStream = await notices.connected;
    expect(connectedStream.status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
      stream: true, output_config: {}, tools: [agentTool],
    }, false, '/v1/messages');
    await acknowledgeLaunchNotice(service.proxy.port, session, consumerId, service.proxy.token, notices);
    const observed = await noticeOrResponse(notices.nextNotice(), request);
    stream = observed.stream;
    expect(observed.kind).toBe('notice');
    const ack = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(stream!.notice, consumerId));
    await responseStarted;
    expect(service.upstreamBodies).toHaveLength(2);
    expect(service.upstreamBodies[1]?.model).toBe(fixture.nativeUpstreamModel);
    stream!.close();
    await stream!.closed;
    finishResponse();
    const response = await request;

    expect(ack).toMatchObject({ status: 200, body: { acknowledged: true } });
    expect(response.status).toContain('200');
    expect(response.body.raw).toContain('Fixture mixed native answer');
    expect(response.body.raw).toContain('continues');
    expect(observation.nativeFetchCalls).toBe(1);
    expect(service.upstreamBodies).toHaveLength(2);
  } finally {
    stream?.close();
    connectedStream?.close();
    finishResponse();
    await service.close();
  }
}, 10_000);

it('keeps an API child deadline from advancing to a native target under the parent deadline', async () => {
  blockNonLoopbackFetch();
  const session = isolatedSessionId();
  const parentDeadlineMs = DEFAULT_LIFECYCLE_DEADLINES.totalMs;
  const childDeadlineMs = Math.floor(parentDeadlineMs / 4);
  const { service, fixture, observation, primaryPending, primaryPendingClosed } = await startSdkNativeFallbackService(
    'pending', 'fixture-sdk-native-child-deadline', undefined, { totalMs: childDeadlineMs });
  let connectedStream: ConnectedNoticeStream | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    const notices = readNoticeSequence(service.proxy.port, session, consumerId, service.proxy.token);
    connectedStream = await notices.connected;
    expect(connectedStream.status).toBe(200);
    const started = performance.now();
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto');
    await acknowledgeLaunchNotice(service.proxy.port, session, consumerId, service.proxy.token, notices);
    const observedRequest = noticeOrResponse(notices.nextNotice(), request);
    await primaryPending;
    expect(service.upstreamBodies).toHaveLength(1);
    expect(service.upstreamBodies[0]?.model).toBe(fixture.registryUpstreamModel);
    await primaryPendingClosed;
    const observed = await observedRequest;
    const response = await request;

    expect(observed.kind, JSON.stringify(safeResponseSummary(observed))).toBe('response');
    expect(response.status).not.toContain('200');
    expect(performance.now() - started).toBeLessThan(parentDeadlineMs / 2);
    expect(observation.nativeFetchCalls).toBe(0);
    expect(service.upstreamBodies).toHaveLength(1);
  } finally {
    connectedStream?.close();
    await service.close();
  }
}, 10_000);
