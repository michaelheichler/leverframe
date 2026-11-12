import { afterAll, afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  resolveProviderAccountAuth: vi.fn(async (providerId: string, account: { id: string }) => {
    if (providerId.startsWith('fixture-mixed-') && account.id === 'missing') return { apiKey: '' };
    if (providerId.startsWith('fixture-mixed-') && ['default', 'usable'].includes(account.id)) return { apiKey: 'fixture-mixed-dummy-api-key' };
    throw new Error('Unexpected mixed transport credential lookup.');
  }),
}));
import { resolveProviderAccountAuth } from '../src/env.js';
import { DEFAULT_LIFECYCLE_DEADLINES } from '../src/request-lifecycle.js';
import { savePreferences } from '../src/config.js';
import { resolveRoutingBinding } from '../src/routing-bindings.js';
import { blockNonLoopbackFetch, isolatedSessionId, noticeOrResponse, safeResponseSummary, sendBoundRequest,
  startNativeService } from './fixtures/model-routing-proxy.js';
import type { ConnectedNoticeStream, NoticeStream } from './fixtures/model-routing-proxy.js';
import { acknowledgeRoutingNotice, agentTool, cachedSystem, deferredNativeAuth, downstreamStreamProbe,
  expectInitialMixedFallbackPending, expectLeaseHeldByInFlight, expectNativeAuthAbandoned,
  expectNativeFallbackFulfilled, expectNativePoolFallbackFulfilled, expectNoticeAcknowledged, expectPendingLease,
  expectPoolFallbackPending, expectRegistryFallbackServed, mixedTransportContext, noticeStreamFrom, registryAnthropicRoute,
  startInitialRoutingBinding, startMixedTransportUpstream, startNoticeGatedMixedRequest,
  startSdkNativeFallbackService } from './model-routing-mixed-transport-fixtures.js';

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

function expectPoolAccountsTried(providerId: string, accountIds: string[]): void {
  expect(vi.mocked(resolveProviderAccountAuth).mock.calls.map(([calledProviderId, account]) => [calledProviderId, account.id]))
    .toEqual(accountIds.map(accountId => [providerId, accountId]));
}

function bindingQueries(sessionId: string, notice: NoticeStream) {
  return { sessionId, modelId: String(notice.notice.modelId) };
}

it('keeps one lease while a registry SDK request switches to native after an acknowledged rejection', async () => {
  blockNonLoopbackFetch();
  const session = isolatedSessionId();
  const system = cachedSystem('mixed');
  const { service, fixture, observation, responseStarted, finishResponse } = await startSdkNativeFallbackService();
  await startInitialRoutingBinding(session, fixture, fixture.context.routerTarget);
  const downstream = downstreamStreamProbe();
  let stream: NoticeStream | undefined, connectedStream: ConnectedNoticeStream | undefined;

  try {
    const started = await startNoticeGatedMixedRequest(service.proxy, session, () =>
      sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
        stream: true, output_config: {}, system, tools: [agentTool],
      }, false, '/v1/messages', downstream.record));
    const { consumerId } = started;
    connectedStream = started.connected;
    const observed = await noticeOrResponse(started.notices.nextNotice(), started.request);
    stream = noticeStreamFrom(observed);
    expectInitialMixedFallbackPending({ outcome: observed, notice: stream, sessionId: session,
      previous: fixture.context.routerTarget, target: fixture.nativeRef,
      primaryModel: fixture.registryUpstreamModel, upstreamBodies: service.upstreamBodies,
      nativeFetchCalls: observation.nativeFetchCalls, downstreamEvents: downstream.events, system });

    const pending = await resolveRoutingBinding(bindingQueries(session, stream));
    expectPendingLease(pending, stream);
    const ack = await acknowledgeRoutingNotice(service.proxy, stream, consumerId);
    await responseStarted;
    await downstream.waitForData();
    const inFlight = await resolveRoutingBinding(bindingQueries(session, stream));
    expectLeaseHeldByInFlight(inFlight, { lease: pending.lease, revision: pending.revision, target: fixture.nativeRef });
    finishResponse();
    const response = await started.request;

    expectNativeFallbackFulfilled({ acknowledgment: ack, observation, upstreamBodies: service.upstreamBodies,
      nativeUpstreamModel: fixture.nativeUpstreamModel, response });
    expect(service.upstreamBodies[1]?.system).toEqual(system);
    expect(service.upstreamBodies[1]?.tools).toEqual([agentTool]);
    expect(downstream.events).toContainEqual({ kind: 'headers' });
    expect(downstream.events).toContainEqual({ kind: 'data' });
    expect(response.body.raw).toContain('Fixture mixed native answer');
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
  const fixture = mixedTransportContext({ endpoint: upstream.endpoint, namespace: 'fixture-native-registry',
    initial: 'native', apiFormat: 'anthropic' });
  const initial = await startInitialRoutingBinding(session, fixture, fixture.nativeRef);
  const route = registryAnthropicRoute(upstream.endpoint, fixture.registryRef, fixture.registryUpstreamModel);
  const service = await startNativeService(fixture.context, { injectNativeRoutingFetch: true, routes: [route],
    responseForRequest: body => body.model === fixture.nativeUpstreamModel ? { status: 401,
      body: { error: { type: 'authentication_error', message: 'Fixture native credential rejected.' } } } : undefined });
  const system = cachedSystem('native');
  const downstreamEvents: Array<{ kind: 'headers' } | { kind: 'data' }> = [];
  let stream: NoticeStream | undefined, connectedStream: ConnectedNoticeStream | undefined;
  try {
    const started = await startNoticeGatedMixedRequest(service.proxy, session, () =>
      sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
        output_config: {}, system, tools: [agentTool],
      }, false, '/v1/messages', item => downstreamEvents.push(item)));
    connectedStream = started.connected;
    const observed = await noticeOrResponse(started.notices.nextNotice(), started.request);
    stream = noticeStreamFrom(observed);
    const afterAttempt = await resolveRoutingBinding({ sessionId: session, modelId: initial.modelId });
    expect(observed.kind, JSON.stringify({ summary: safeResponseSummary(observed), original: initial.decision.target,
      saved: afterAttempt.decision.target, reasons: afterAttempt.decision.events.map(event => event.reason) })).toBe('notice');
    expect(stream?.notice).toMatchObject({ sessionId: session, previous: fixture.nativeRef,
      target: fixture.registryRef, reason: 'credential_rejected', acknowledged: false });
    expect(service.observation.requests).toHaveLength(1);
    expect(service.observation.requests[0]?.body.system).toEqual(system);
    expect(upstream.requests).toEqual([]);
    expect(downstreamEvents).toEqual([]);
    const pending = await resolveRoutingBinding(bindingQueries(session, stream));
    expectPendingLease(pending, stream);
    const ack = await acknowledgeRoutingNotice(service.proxy, stream, started.consumerId);
    await upstream.requestArrived;
    const inFlight = await resolveRoutingBinding(bindingQueries(session, stream));
    expectLeaseHeldByInFlight(inFlight, { lease: pending.lease, revision: pending.revision, target: fixture.registryRef });
    upstream.finishResponse();
    const response = await started.request;
    expectRegistryFallbackServed({ acknowledgment: ack, serviceRequests: service.observation.requests,
      upstreamRequests: upstream.requests, registryUpstreamModel: fixture.registryUpstreamModel, system,
      downstreamEvents, response });
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
  const { service, fixture, observation, responseStarted, finishResponse } = await startSdkNativeFallbackService({
    namespace, poolAccountIds: accountIds, rejection });
  const downstreamEvents: Array<{ kind: 'headers' } | { kind: 'data' }> = [];
  let fallbackNotice: NoticeStream | undefined;
  let connectedStream: ConnectedNoticeStream | undefined;
  let notices: Awaited<ReturnType<typeof startNoticeGatedMixedRequest>>['notices'] | undefined;

  try {
    const started = await startNoticeGatedMixedRequest(service.proxy, session, () =>
      sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
        stream: true, output_config: {}, tools: [agentTool], system: [{ type: 'text', text: 'Mixed-pool SDK input' }],
      }, false, '/v1/messages', event => downstreamEvents.push(event)));
    notices = started.notices;
    connectedStream = started.connected;
    const observed = await noticeOrResponse(started.notices.nextNotice(), started.request);
    fallbackNotice = noticeStreamFrom(observed);
    expect(service.upstreamBodies).toHaveLength(1);
    expect(service.upstreamBodies[0]?.model).toBe(fixture.registryUpstreamModel);
    expectPoolAccountsTried(fixture.registryRef.providerId, accountIds);
    expectPoolFallbackPending({ observed, notice: fallbackNotice, previous: fixture.context.routerTarget,
      target: fixture.nativeRef, reason: rejection.reason });
    expect(observation.nativeFetchCalls).toBe(0);
    expect(downstreamEvents).toEqual([]);

    const ack = await acknowledgeRoutingNotice(service.proxy, fallbackNotice, started.consumerId);
    await responseStarted;
    finishResponse();
    const response = await started.request;

    expectNativeFallbackFulfilled({ acknowledgment: ack, observation, upstreamBodies: service.upstreamBodies,
      nativeUpstreamModel: fixture.nativeUpstreamModel, response });
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
  const accountIds = ['missing', 'usable'];
  let registryUpstreamModel: string | undefined;
  const upstream = await startMixedTransportUpstream(body => body.model === registryUpstreamModel
    ? { status: rejection.status, body: { error: { type: rejection.type, message: 'Fixture pool rejection.' } } } : undefined);
  const fixture = mixedTransportContext({ endpoint: upstream.endpoint, namespace: `fixture-native-mixed-pool-${rejection.status}`,
    initial: 'registry', apiFormat: 'anthropic', poolAccountIds: accountIds });
  registryUpstreamModel = fixture.registryUpstreamModel;
  const route = registryAnthropicRoute(upstream.endpoint, fixture.registryRef, fixture.registryUpstreamModel);
  delete route.accountId;
  const service = await startNativeService(fixture.context, { injectNativeRoutingFetch: true, routes: [route] });
  const downstreamEvents: Array<{ kind: 'headers' } | { kind: 'data' }> = [];
  let fallbackNotice: NoticeStream | undefined;
  let connectedStream: ConnectedNoticeStream | undefined;
  let notices: Awaited<ReturnType<typeof startNoticeGatedMixedRequest>>['notices'] | undefined;

  try {
    const started = await startNoticeGatedMixedRequest(service.proxy, session, () =>
      sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
        output_config: {}, tools: [agentTool], system: [{ type: 'text', text: 'Mixed-pool native input' }],
      }, false, '/v1/messages', event => downstreamEvents.push(event)));
    notices = started.notices;
    connectedStream = started.connected;
    const observed = await noticeOrResponse(started.notices.nextNotice(), started.request);
    fallbackNotice = noticeStreamFrom(observed);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.model).toBe(fixture.registryUpstreamModel);
    expectPoolAccountsTried(fixture.registryRef.providerId, accountIds);
    expectPoolFallbackPending({ observed, notice: fallbackNotice, previous: fixture.registryRef,
      target: fixture.nativeRef, reason: rejection.reason });
    expect(service.observation.nativeFetchCalls).toBe(0);
    expect(service.observation.requests).toEqual([]);
    expect(downstreamEvents).toEqual([]);

    const ack = await acknowledgeRoutingNotice(service.proxy, fallbackNotice, started.consumerId);
    const response = await started.request;

    expectNativePoolFallbackFulfilled({ acknowledgment: ack, upstreamRequests: upstream.requests,
      observation: service.observation, nativeUpstreamModel: fixture.nativeUpstreamModel, response });
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
  const { service, fixture, observation } = await startSdkNativeFallbackService({ outcome: 'unknown',
    namespace: 'fixture-sdk-native-unknown' });
  const initial = await startInitialRoutingBinding(session, fixture, fixture.context.routerTarget);
  let connectedStream: ConnectedNoticeStream | undefined;

  try {
    const started = await startNoticeGatedMixedRequest(service.proxy, session, () =>
      sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto'));
    connectedStream = started.connected;
    const observed = await noticeOrResponse(started.notices.nextNotice(), started.request);
    const response = await started.request;

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
  const auth = deferredNativeAuth();
  const { service, fixture, observation } = await startSdkNativeFallbackService({ namespace: 'fixture-sdk-native-auth-disconnect',
    nativeAuthReader: auth.reader });
  let stream: NoticeStream | undefined;
  let connectedStream: ConnectedNoticeStream | undefined;

  try {
    const started = await startNoticeGatedMixedRequest(service.proxy, session, () =>
      sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
        stream: true, output_config: {}, tools: [agentTool],
      }, false, '/v1/messages'));
    const { consumerId } = started;
    connectedStream = started.connected;
    const observed = await noticeOrResponse(started.notices.nextNotice(), started.request);
    stream = noticeStreamFrom(observed);
    const notice = stream;
    expect(observed.kind).toBe('notice');
    expect(service.upstreamBodies).toHaveLength(1);
    expect(service.upstreamBodies[0]?.model).toBe(fixture.registryUpstreamModel);
    const ack = await acknowledgeRoutingNotice(service.proxy, notice, consumerId);
    await auth.started;
    notice.close();
    await notice.closed;
    const disconnectedAck = await vi.waitFor(async () => {
      const result = await acknowledgeRoutingNotice(service.proxy, notice, consumerId);
      expect(result.status).toBe(409);
      return result;
    }, { interval: 10, timeout: 1_000 });
    auth.release();
    const response = await started.request;

    expectNativeAuthAbandoned({ acknowledgment: ack, disconnectedAck, response, observation,
      upstreamBodies: service.upstreamBodies });
  } finally {
    auth.release();
    stream?.close();
    connectedStream?.close();
    await service.close();
  }
}, 10_000);

it('continues the acknowledged native stream after its notice consumer disconnects following output', async () => {
  blockNonLoopbackFetch();
  const session = isolatedSessionId();
  const { service, fixture, observation, responseStarted, finishResponse } = await startSdkNativeFallbackService({
    namespace: 'fixture-sdk-native-output-disconnect' });
  let stream: NoticeStream | undefined;
  let connectedStream: ConnectedNoticeStream | undefined;

  try {
    const started = await startNoticeGatedMixedRequest(service.proxy, session, () =>
      sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
        stream: true, output_config: {}, tools: [agentTool],
      }, false, '/v1/messages'));
    connectedStream = started.connected;
    const observed = await noticeOrResponse(started.notices.nextNotice(), started.request);
    stream = noticeStreamFrom(observed);
    expect(observed.kind).toBe('notice');
    const ack = await acknowledgeRoutingNotice(service.proxy, stream, started.consumerId);
    await responseStarted;
    expect(service.upstreamBodies).toHaveLength(2);
    expect(service.upstreamBodies[1]?.model).toBe(fixture.nativeUpstreamModel);
    stream.close();
    await stream.closed;
    finishResponse();
    const response = await started.request;

    expectNoticeAcknowledged(ack);
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
  const { service, fixture, observation, primaryPending, primaryPendingClosed } = await startSdkNativeFallbackService({
    outcome: 'pending', namespace: 'fixture-sdk-native-child-deadline', requestDeadlines: { totalMs: childDeadlineMs } });
  let connectedStream: ConnectedNoticeStream | undefined;
  let parentTimer: NodeJS.Timeout | undefined;

  try {
    const firstDeadline = Promise.race([
      primaryPendingClosed.then(() => 'child-closed-upstream' as const),
      new Promise<'parent-deadline'>(resolve => {
        parentTimer = setTimeout(() => resolve('parent-deadline'), parentDeadlineMs);
      }),
    ]);
    const started = await startNoticeGatedMixedRequest(service.proxy, session, () =>
      sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto'));
    connectedStream = started.connected;
    const observedRequest = noticeOrResponse(started.notices.nextNotice(), started.request);
    await primaryPending;
    expect(service.upstreamBodies).toHaveLength(1);
    expect(service.upstreamBodies[0]?.model).toBe(fixture.registryUpstreamModel);
    await primaryPendingClosed;
    const observed = await observedRequest;
    const response = await started.request;

    expect(await firstDeadline).toBe('child-closed-upstream');
    expect(observed.kind, JSON.stringify(safeResponseSummary(observed))).toBe('response');
    expect(response.status).not.toContain('200');
    expect(observation.nativeFetchCalls).toBe(0);
    expect(service.upstreamBodies).toHaveLength(1);
  } finally {
    clearTimeout(parentTimer);
    connectedStream?.close();
    await service.close();
  }
}, 10_000);
