import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { ROUTING_NOTICE_FORMAT_SOURCE } from '../src/patch-transforms-routing-notice-format.js';
import { ROUTING_NOTICE_COORDINATOR_SOURCE } from '../src/patch-transforms-routing-notice-coordinator.js';
import { advanceRoutingFallback, awaitRoutingNotice, createRoutingBinding, listRoutingNotices, resolveRoutingBinding,
  withRoutingLease, type RoutingFallbackNotice } from '../src/routing-bindings.js';
import { nativeRoutingContext, acknowledgment, assertIsolatedRoutingSession, readNotice, registerConsumer, requestJson,
  startNativeService } from './fixtures/model-routing-proxy.js';
import type { ConnectedNoticeStream, NoticeStream } from './fixtures/model-routing-proxy.js';

type CoordinatorBridge = {
  ensure(sessionId: string, signal: AbortSignal, deadline: number): Promise<boolean>;
  close(): void;
};

type CoordinatorFrame = { text: string; signal: AbortSignal; deadline: number; complete(): void; fail(): void };

type PublishedNotice = { key: string; kind: string; priority: string; pinned: boolean; wrap: boolean; text: string };
type CoordinatorRequest = { method: string; path: string; authenticated: boolean; body?: Record<string, unknown>;
  responseStatus?: number };

type CoordinatorHarness = {
  sessionId: string;
  bridge: CoordinatorBridge;
  frameShown: Promise<CoordinatorFrame>;
  requests: CoordinatorRequest[];
  setSession(sessionId: string): void;
  releaseOutput(): void;
  setWriterReady(ready: boolean): void;
  releaseReadyResponse(): void;
  readyRequestStarted: Promise<void>;
  acknowledgmentResponse: Promise<number>;
  corruptNextAck(): void;
  replaceConsumer(): Promise<Record<string, unknown>>;
  pendingNotice: RoutingFallbackNotice;
  dispatch: Promise<void>;
  abortDispatch(): void;
  close(): Promise<void>;
};

async function createNoticeCoordinatorHarness(options: {
  delayOutput?: boolean;
  holdReadyResponse?: boolean;
} = {}): Promise<CoordinatorHarness> {
  const sessionId = randomUUID();
  assertIsolatedRoutingSession(sessionId);
  const context = nativeRoutingContext('auto');
  const current = context.catalog.models[0]!;
  const fallbackRef = { providerId: current.ref.providerId, modelId: 'coordinator-fallback-model' };
  const catalog = { ...context.catalog, models: [
    { ...current, maxOutputTokens: 12_000 },
    { ...current, ref: fallbackRef, upstreamModelId: 'coordinator-fallback-upstream', maxOutputTokens: 12_000 },
  ] };
  context.catalog = catalog;
  context.config = { ...context.config, routerFallbacks: [fallbackRef], pool: [current.ref, fallbackRef] };
  const service = await startNativeService(context);
  const launch = await createRoutingBinding({ sessionId, launchId: `launch-${sessionId}`, role: 'router',
    task: 'A bounded fixture request.', config: context.config, catalog, workload: { input: 50, output: 80 },
    requirements: { capabilities: [], contextTokens: 100 } });
  const dispatchAbort = new AbortController();
  let resolvePending!: (notice: RoutingFallbackNotice) => void;
  const pendingNoticeReady = new Promise<RoutingFallbackNotice>(resolve => { resolvePending = resolve; });
  const dispatch = withRoutingLease({ sessionId, modelId: launch.id }, async leased => {
    const updated = await advanceRoutingFallback({ sessionId, modelId: leased.id, leaseId: leased.lease!,
      revision: leased.revision,
      failure: { reason: 'quota_exhausted', acceptance: 'rejected', response: 'clear', output: 'none', tool: 'none' },
      catalog, requirements: { capabilities: [], contextTokens: 100 }, maxOutputTokens: 80,
      workload: { input: 50, output: 80 }, deadline: Date.now() + 15_000, signal: dispatchAbort.signal });
    const notice = updated.pendingNotice;
    if (!notice) throw new Error('A fixture fallback transition did not publish its notice.');
    resolvePending(notice);
    await awaitRoutingNotice({ sessionId, sequence: notice.sequence, modelId: notice.modelId,
      revision: notice.revision, leaseId: leased.lease!, deadline: Date.now() + 15_000, signal: dispatchAbort.signal });
  });
  const pendingNotice = await pendingNoticeReady;

  const requests: CoordinatorRequest[] = [];
  const originalFetch = globalThis.fetch.bind(globalThis);
  let resolveOutput!: () => void;
  const outputReady = options.delayOutput ? new Promise<boolean>(resolve => { resolveOutput = () => resolve(true); })
    : Promise.resolve(true);
  let writerReady = true;
  let corruptAck = false;
  let releaseReady!: () => void;
  const readyResponseGate = options.holdReadyResponse ? new Promise<void>(resolve => { releaseReady = resolve; })
    : Promise.resolve();
  let resolveReadyStarted!: () => void;
  const readyRequestStarted = new Promise<void>(resolve => { resolveReadyStarted = resolve; });
  let resolveAckResponse!: (status: number) => void;
  const acknowledgmentResponse = new Promise<number>(resolve => { resolveAckResponse = resolve; });
  let sessionValue: string = sessionId;
  const sessionListeners = new Set<() => void>();
  const session: { id: string; subscribe(callback: () => void): () => boolean } = {
    id: sessionId,
    subscribe(callback: () => void) { sessionListeners.add(callback); return () => sessionListeners.delete(callback); },
  };
  let resolveFrame!: (frame: CoordinatorFrame) => void;
  const frameShown = new Promise<CoordinatorFrame>(resolve => { resolveFrame = resolve; });
  const renderer: Record<string, any> = {
    __lfOutputAbort: new AbortController(),
    __lfEnsureOutput: () => outputReady,
    nonBlockingStdout: { routingReady: () => writerReady },
    forceRedraw: () => undefined,
  };
  const fetchLoopback = async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = request instanceof Request ? new URL(request.url) : new URL(String(request));
    if (url.hostname !== '127.0.0.1') throw new Error('Coordinator fixture permits loopback control traffic only.');
    const method = init?.method ?? (request instanceof Request ? request.method : 'GET');
    let body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    let outgoingInit = init;
    if (url.pathname.endsWith('/routing-notice-ack') && corruptAck && body) {
      corruptAck = false;
      body = { ...body, revision: Number(body.revision) + 1 };
      outgoingInit = { ...init, body: JSON.stringify(body) };
    }
    const headers = new Headers(init?.headers);
    const recorded: CoordinatorRequest = { method, path: url.pathname, authenticated: headers.has('authorization'),
      ...(body ? { body } : {}) };
    requests.push(recorded);
    if (url.pathname.endsWith('/routing-notice-ready')) {
      resolveReadyStarted();
      await readyResponseGate;
    }
    const response = await originalFetch(url, { ...outgoingInit, method, headers, redirect: 'error' });
    recorded.responseStatus = response.status;
    if (url.pathname.endsWith('/routing-notice-ack')) resolveAckResponse(response.status);
    return response;
  };
  const processForVm = { env: {
    LEVERFRAME_CONTEXT_SELECTION_BASE_URL: `http://127.0.0.1:${service.proxy.port}/`,
    LEVERFRAME_CONTEXT_SELECTION_TOKEN: service.proxy.token,
  }, stdout: { columns: 96 } };
  const bridgeFactory = runInNewContext(
    `${ROUTING_NOTICE_FORMAT_SOURCE}\n${ROUTING_NOTICE_COORDINATOR_SOURCE}\n({ create: __lfCreateNoticeBridge })`,
    { process: processForVm, fetch: fetchLoopback, AbortSignal, AbortController, TextDecoder, URL, crypto: { randomUUID },
      Date, setTimeout, clearTimeout });
  const bridge = (bridgeFactory as { create: (renderer: unknown, session: unknown, add: (item: any) => void,
    remove: (key: string) => void, current: () => string) => CoordinatorBridge }).create(renderer, session,
    (_item: PublishedNotice) => resolveFrame(renderer.__lfRoutingNotice as CoordinatorFrame),
    () => undefined, () => sessionValue);

  return {
    sessionId, bridge, frameShown, requests, pendingNotice, dispatch,
    setSession(nextSessionId) {
      session.id = nextSessionId;
      sessionValue = nextSessionId;
      for (const callback of sessionListeners) callback();
    },
    releaseOutput() { resolveOutput(); },
    setWriterReady(ready) { writerReady = ready; },
    releaseReadyResponse() { releaseReady(); },
    readyRequestStarted,
    acknowledgmentResponse,
    corruptNextAck() { corruptAck = true; },
    async replaceConsumer() {
      const response = await originalFetch(`http://127.0.0.1:${service.proxy.port}/v1/leverframe/routing-notice-ready`, {
        method: 'POST', headers: { Authorization: `Bearer ${service.proxy.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, protocolVersion: 1 }),
      });
      if (!response.ok) throw new Error('The loopback service did not replace the fixture notice consumer.');
      return await response.json() as Record<string, unknown>;
    },
    abortDispatch() { dispatchAbort.abort(); },
    async close() {
      bridge.close();
      dispatchAbort.abort();
      await Promise.allSettled([dispatch]);
      await service.close();
    },
  };
}

async function createReconnectNoticeHarness() {
  const sessionId = randomUUID();
  assertIsolatedRoutingSession(sessionId);
  const context = nativeRoutingContext('auto');
  const current = context.catalog.models[0]!;
  const firstRef = { providerId: current.ref.providerId, modelId: 'reconnect-first-fallback' };
  const secondRef = { providerId: current.ref.providerId, modelId: 'reconnect-second-fallback' };
  const catalog = { ...context.catalog, models: [
    { ...current, maxOutputTokens: 12_000 },
    { ...current, ref: firstRef, upstreamModelId: 'reconnect-first-upstream', maxOutputTokens: 12_000 },
    { ...current, ref: secondRef, upstreamModelId: 'reconnect-second-upstream', maxOutputTokens: 12_000 },
  ] };
  context.catalog = catalog;
  context.config = { ...context.config, routerFallbacks: [firstRef, secondRef], pool: [current.ref, firstRef, secondRef] };
  const service = await startNativeService(context);
  const launch = await createRoutingBinding({ sessionId, launchId: `reconnect-${sessionId}`, role: 'router', task: '',
    config: context.config, catalog, workload: { input: 50, output: 80 },
    requirements: { capabilities: [], contextTokens: 100 } });
  const registered = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
  if (registered.status !== 200) throw new Error('The fixture could not register a notice consumer.');
  return { sessionId, service, launch, catalog, consumerId: String(registered.body.consumerId) };
}

function beginReconnectNoticeDispatch(input: {
  sessionId: string;
  modelId: string;
  catalog: Parameters<typeof advanceRoutingFallback>[0]['catalog'];
  signal: AbortSignal;
}) {
  let resolveNotice!: (notice: RoutingFallbackNotice) => void;
  let rejectNotice!: (error: unknown) => void;
  const notice = new Promise<RoutingFallbackNotice>((resolve, reject) => {
    resolveNotice = resolve;
    rejectNotice = reject;
  });
  const dispatch = withRoutingLease({ sessionId: input.sessionId, modelId: input.modelId }, async leased => {
    const updated = await advanceRoutingFallback({ sessionId: input.sessionId, modelId: leased.id, leaseId: leased.lease!,
      revision: leased.revision,
      failure: { reason: 'quota_exhausted', acceptance: 'rejected', response: 'clear', output: 'none', tool: 'none' },
      catalog: input.catalog, requirements: { capabilities: [], contextTokens: 100 }, maxOutputTokens: 80,
      workload: { input: 50, output: 80 }, deadline: Date.now() + 15_000, signal: input.signal });
    const pendingNotice = updated.pendingNotice;
    if (!pendingNotice) throw new Error('The fixture transition did not create a pending notice.');
    resolveNotice(pendingNotice);
    await awaitRoutingNotice({ sessionId: input.sessionId, sequence: pendingNotice.sequence, modelId: pendingNotice.modelId,
      revision: pendingNotice.revision, leaseId: leased.lease!, deadline: Date.now() + 15_000, signal: input.signal });
  });
  void dispatch.catch(rejectNotice);
  return { notice, dispatch };
}

async function prepareReconnectNoticePair(harness: Awaited<ReturnType<typeof createReconnectNoticeHarness>>) {
  const firstAbort = new AbortController();
  const firstRead = readNotice(harness.service.proxy.port, harness.sessionId, harness.consumerId, harness.service.proxy.token);
  let firstConnection: ConnectedNoticeStream | undefined;
  let firstEvent: NoticeStream | undefined;
  let firstDispatch: Promise<void> = Promise.resolve();
  let firstNotice: RoutingFallbackNotice | undefined;
  let firstReceipt: Record<string, unknown> | undefined;
  try {
    firstConnection = await firstRead.connected;
    if (firstConnection.status !== 200) throw new Error('The first notice stream did not connect.');
    const firstWork = beginReconnectNoticeDispatch({ sessionId: harness.sessionId, modelId: harness.launch.id,
      catalog: harness.catalog, signal: firstAbort.signal });
    firstDispatch = firstWork.dispatch;
    firstNotice = await firstWork.notice;
    firstEvent = await firstRead.notice;
    firstReceipt = acknowledgment(firstEvent.notice, harness.consumerId);
    const ack = await requestJson(harness.service.proxy.port, '/v1/leverframe/routing-notice-ack', harness.service.proxy.token,
      firstReceipt);
    if (ack.status !== 200) throw new Error('The first fixture notice was not acknowledged.');
    await firstDispatch;
  } finally {
    firstAbort.abort();
    firstEvent?.close();
    firstConnection?.close();
    await Promise.allSettled([firstDispatch]);
  }

  const disconnectedReceipt = await vi.waitFor(async () => {
    const result = await requestJson(harness.service.proxy.port, '/v1/leverframe/routing-notice-ack', harness.service.proxy.token,
      firstReceipt!);
    expect(result.status).toBe(409);
    return result;
  }, { interval: 10, timeout: 1_000 });
  expect(disconnectedReceipt.status).toBe(409);

  const secondAbort = new AbortController();
  const secondWork = beginReconnectNoticeDispatch({ sessionId: harness.sessionId, modelId: harness.launch.id,
    catalog: harness.catalog, signal: secondAbort.signal });
  try {
    const secondNotice = await secondWork.notice;
    const prematureAck = await requestJson(harness.service.proxy.port, '/v1/leverframe/routing-notice-ack', harness.service.proxy.token,
      { sessionId: harness.sessionId, consumerId: harness.consumerId, sequence: secondNotice.sequence,
        modelId: secondNotice.modelId, revision: secondNotice.revision });
    const renewal = await requestJson(harness.service.proxy.port, '/v1/leverframe/routing-notice-ready', harness.service.proxy.token,
      { sessionId: harness.sessionId, protocolVersion: 1, consumerId: harness.consumerId });
    return { firstNotice: firstNotice!, firstReceipt: firstReceipt!, secondNotice,
      prematureAckStatus: prematureAck.status, renewalStatus: renewal.status, renewedConsumerId: renewal.body['consumerId'],
      abort: secondAbort, dispatch: secondWork.dispatch };
  } catch (error) {
    secondAbort.abort();
    await Promise.allSettled([secondWork.dispatch]);
    throw error;
  }
}

it('waits for completed notice output before acknowledging the exact pending transition', async () => {
  const harness = await createNoticeCoordinatorHarness();

  try {
    await harness.bridge.ensure(harness.sessionId, new AbortController().signal, Date.now() + 5_000);
    const frame = await harness.frameShown;
    const before = await resolveRoutingBinding({ sessionId: harness.sessionId, modelId: harness.pendingNotice.modelId });
    expect(before.pendingNotice?.acknowledged).toBe(false);

    frame.complete();
    await harness.dispatch;
    const after = await resolveRoutingBinding({ sessionId: harness.sessionId, modelId: harness.pendingNotice.modelId });
    const retainedReceipt = listRoutingNotices(harness.sessionId, 0)
      .find(notice => notice.sequence === harness.pendingNotice.sequence);
    const ack = harness.requests.find(request => request.path.endsWith('/routing-notice-ack'))?.body;
    expect(after.pendingNotice).toBeUndefined();
    expect(retainedReceipt).toMatchObject({ sequence: harness.pendingNotice.sequence, acknowledged: true });
    expect(after.decision.target).toEqual(harness.pendingNotice.target);
    expect(after.revision).toBe(harness.pendingNotice.revision);
    expect(ack).toMatchObject({ sessionId: harness.pendingNotice.sessionId,
      sequence: harness.pendingNotice.sequence, modelId: harness.pendingNotice.modelId,
      revision: harness.pendingNotice.revision });
    expect(harness.requests.every(request => request.authenticated)).toBe(true);
  } finally {
    await harness.close();
  }
}, 20_000);

it('deduplicates concurrent readiness calls into one authenticated consumer connection', async () => {
  const harness = await createNoticeCoordinatorHarness();

  try {
    const signal = new AbortController().signal;
    const deadline = Date.now() + 5_000;
    await Promise.all([harness.bridge.ensure(harness.sessionId, signal, deadline),
      harness.bridge.ensure(harness.sessionId, signal, deadline)]);

    expect(harness.requests.filter(request => request.path.endsWith('/routing-notice-ready'))).toHaveLength(1);
    expect(harness.requests.filter(request => request.path.endsWith('/routing-events'))).toHaveLength(1);
  } finally {
    await harness.close();
  }
}, 20_000);

it('does not register a consumer when the caller cancels during renderer startup', async () => {
  const harness = await createNoticeCoordinatorHarness({ delayOutput: true });
  const abort = new AbortController();
  const ensure = harness.bridge.ensure(harness.sessionId, abort.signal, Date.now() + 5_000);
  abort.abort();

  try {
    await expect(ensure).rejects.toThrow();
    expect(harness.requests).toHaveLength(0);
  } finally {
    harness.releaseOutput();
    await harness.close();
  }
}, 20_000);

it('rejects an expired caller deadline before readiness registration', async () => {
  const harness = await createNoticeCoordinatorHarness();

  try {
    await expect(harness.bridge.ensure(harness.sessionId, new AbortController().signal, Date.now() - 1)).rejects.toThrow();
    expect(harness.requests).toHaveLength(0);
  } finally {
    await harness.close();
  }
}, 20_000);

it('rejects a session ABA change during delayed renderer startup before registration', async () => {
  const harness = await createNoticeCoordinatorHarness({ delayOutput: true });
  const ensure = harness.bridge.ensure(harness.sessionId, new AbortController().signal, Date.now() + 5_000);

  try {
    harness.setSession('replacement-session');
    harness.setSession(harness.sessionId);
    harness.releaseOutput();

    await expect(ensure).rejects.toThrow();
    expect(harness.requests).toHaveLength(0);
  } finally {
    await harness.close();
  }
}, 20_000);

it('does not connect when the bridge closes during delayed renderer startup', async () => {
  const harness = await createNoticeCoordinatorHarness({ delayOutput: true });
  const ensure = harness.bridge.ensure(harness.sessionId, new AbortController().signal, Date.now() + 5_000);
  harness.bridge.close();
  harness.releaseOutput();

  try {
    await expect(ensure).rejects.toThrow();
    expect(harness.requests).toHaveLength(0);
  } finally {
    await harness.close();
  }
}, 20_000);

it('fails readiness if the trusted writer disappears while registration is in flight', async () => {
  const harness = await createNoticeCoordinatorHarness({ holdReadyResponse: true });
  const ensure = harness.bridge.ensure(harness.sessionId, new AbortController().signal, Date.now() + 5_000);

  try {
    await harness.readyRequestStarted;
    harness.setWriterReady(false);
    harness.releaseReadyResponse();
    await expect(ensure).rejects.toThrow();
    const current = await resolveRoutingBinding({ sessionId: harness.sessionId, modelId: harness.pendingNotice.modelId });
    expect(current.pendingNotice?.acknowledged).toBe(false);
    expect(harness.requests.some(request => request.path.endsWith('/routing-notice-ack'))).toBe(false);
  } finally {
    harness.releaseReadyResponse();
    await harness.close();
  }
}, 20_000);

it('leaves a transition unacknowledged when the connected notice stream is closed', async () => {
  const harness = await createNoticeCoordinatorHarness();

  try {
    await harness.bridge.ensure(harness.sessionId, new AbortController().signal, Date.now() + 5_000);
    await harness.frameShown;
    harness.bridge.close();

    expect((await harness.frameShown).signal.aborted).toBe(true);
    const current = await resolveRoutingBinding({ sessionId: harness.sessionId, modelId: harness.pendingNotice.modelId });
    expect(current.pendingNotice?.acknowledged).toBe(false);
    expect(harness.requests.some(request => request.path.endsWith('/routing-notice-ack'))).toBe(false);
  } finally {
    await harness.close();
  }
}, 20_000);

it('keeps the fallback pending when the authenticated service rejects a stale revision ACK', async () => {
  const harness = await createNoticeCoordinatorHarness();

  try {
    await harness.bridge.ensure(harness.sessionId, new AbortController().signal, Date.now() + 5_000);
    const frame = await harness.frameShown;
    harness.corruptNextAck();
    frame.complete();

    expect(await harness.acknowledgmentResponse).toBe(409);
    const current = await resolveRoutingBinding({ sessionId: harness.sessionId, modelId: harness.pendingNotice.modelId });
    expect(current.pendingNotice?.acknowledged).toBe(false);
  } finally {
    await harness.close();
  }
}, 20_000);

it('does not acknowledge a frame after the active consumer has been replaced', async () => {
  const harness = await createNoticeCoordinatorHarness();

  try {
    await harness.bridge.ensure(harness.sessionId, new AbortController().signal, Date.now() + 5_000);
    const frame = await harness.frameShown;
    await harness.replaceConsumer();
    frame.complete();

    expect(await harness.acknowledgmentResponse).toBe(409);
    const current = await resolveRoutingBinding({ sessionId: harness.sessionId, modelId: harness.pendingNotice.modelId });
    expect(current.pendingNotice?.acknowledged).toBe(false);
  } finally {
    await harness.close();
  }
}, 20_000);

it('a cursor at zero skips an acknowledged notice while replaying the pending journal transition', async () => {
  const harness = await createReconnectNoticeHarness();
  let pair: Awaited<ReturnType<typeof prepareReconnectNoticePair>> | undefined;
  let connection: ConnectedNoticeStream | undefined;
  let event: NoticeStream | undefined;

  try {
    pair = await prepareReconnectNoticePair(harness);
    expect(pair.prematureAckStatus).toBe(409);
    expect(pair.renewalStatus).toBe(200);
    expect(pair.renewedConsumerId).toBe(harness.consumerId);
    expect(pair.secondNotice.sequence).toBeGreaterThan(pair.firstNotice.sequence);
    const reconnectRead = readNotice(harness.service.proxy.port, harness.sessionId, harness.consumerId,
      harness.service.proxy.token, 0);
    connection = await reconnectRead.connected;
    expect(connection.status).toBe(200);
    event = await reconnectRead.notice;
    expect(event.notice).toMatchObject({ sequence: pair.secondNotice.sequence, revision: pair.secondNotice.revision,
      sessionId: harness.sessionId, modelId: harness.launch.id });
    const pending = await resolveRoutingBinding({ sessionId: harness.sessionId, modelId: harness.launch.id });
    expect(pending.pendingNotice).toMatchObject({ sequence: pair.secondNotice.sequence, acknowledged: false });
    const finalAck = await requestJson(harness.service.proxy.port, '/v1/leverframe/routing-notice-ack',
      harness.service.proxy.token, acknowledgment(event.notice, harness.consumerId));
    expect(finalAck.status).toBe(200);
    await pair.dispatch;
    const completed = await resolveRoutingBinding({ sessionId: harness.sessionId, modelId: harness.launch.id });
    const retainedReceipt = listRoutingNotices(harness.sessionId, 0)
      .find(notice => notice.sequence === pair!.secondNotice.sequence);
    expect(completed.pendingNotice).toBeUndefined();
    expect(retainedReceipt).toMatchObject({ sequence: pair.secondNotice.sequence, acknowledged: true });
    expect(completed.decision.target).toEqual(pair.secondNotice.target);
    expect(completed.revision).toBe(pair.secondNotice.revision);
  } finally {
    pair?.abort.abort();
    event?.close();
    connection?.close();
    await Promise.allSettled([pair?.dispatch ?? Promise.resolve()]);
    await harness.service.close();
  }
}, 20_000);

it('confirms an exact older receipt after reconnect without releasing the newer pending notice', async () => {
  const harness = await createReconnectNoticeHarness();
  let pair: Awaited<ReturnType<typeof prepareReconnectNoticePair>> | undefined;
  let connection: ConnectedNoticeStream | undefined;
  let event: NoticeStream | undefined;

  try {
    pair = await prepareReconnectNoticePair(harness);
    const reconnectRead = readNotice(harness.service.proxy.port, harness.sessionId, harness.consumerId,
      harness.service.proxy.token, pair.secondNotice.sequence);
    connection = await reconnectRead.connected;
    expect(connection.status).toBe(200);
    event = await reconnectRead.notice;
    expect(event.notice).toMatchObject({ sequence: pair.secondNotice.sequence, revision: pair.secondNotice.revision,
      sessionId: harness.sessionId, modelId: harness.launch.id });
    const beforeReceipt = await resolveRoutingBinding({ sessionId: harness.sessionId, modelId: harness.launch.id });
    expect(beforeReceipt.pendingNotice).toMatchObject({ sequence: pair.secondNotice.sequence, acknowledged: false });

    const oldReceiptAck = await requestJson(harness.service.proxy.port, '/v1/leverframe/routing-notice-ack',
      harness.service.proxy.token, pair.firstReceipt);
    expect(oldReceiptAck.status).toBe(200);
    const afterOldReceipt = await resolveRoutingBinding({ sessionId: harness.sessionId, modelId: harness.launch.id });
    expect(afterOldReceipt.pendingNotice).toMatchObject({ sequence: pair.secondNotice.sequence, acknowledged: false });
    const finalAck = await requestJson(harness.service.proxy.port, '/v1/leverframe/routing-notice-ack',
      harness.service.proxy.token, acknowledgment(event.notice, harness.consumerId));
    expect(finalAck.status).toBe(200);
    await pair.dispatch;
  } finally {
    pair?.abort.abort();
    event?.close();
    connection?.close();
    await Promise.allSettled([pair?.dispatch ?? Promise.resolve()]);
    await harness.service.close();
  }
}, 20_000);
