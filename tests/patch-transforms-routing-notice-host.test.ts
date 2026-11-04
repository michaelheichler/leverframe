import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { ROUTING_ACTIVE_ENV, ROUTING_ACTIVE_VALUE, ROUTING_NOTICE_ACTIVE_ENV } from '../src/constants.js';
import { applyRoutingNoticeHostTransform } from '../src/patch-transforms-routing-notice-host.js';
import { noticeHostSource, noticeRequestSource } from './fixtures/claude-agent-2.1.314-notice-host.js';

type HostRenderer = {
  __lfNoticeBridge?: { session: { id: string }; ensure(session: string, signal: AbortSignal, deadline: number): Promise<boolean>;
    close(): void; setPublisher(add: unknown, remove: unknown): void };
  __lfOutputAbort: AbortController;
  nonBlockingStdout: { routingReady(): boolean };
};

type HostHarness = {
  host(): void;
  request(signal: AbortSignal, requestContext?: Record<string, unknown>): AsyncGenerator<unknown, void, unknown>;
  renderer: HostRenderer;
  session: { id: string; subscribe(callback: () => void): () => boolean };
  cleanups: Array<() => void>;
  setOwner(owner: { current?: unknown }): void;
  setRenderer(renderer: HostRenderer | undefined): void;
  unsubscribed(): number;
  bodyReached(): boolean;
};

function evaluateNoticeHost(options: { routingActive?: boolean; noticeActive?: boolean; recovery?: unknown } = {}) {
  const transformed = applyRoutingNoticeHostTransform(noticeHostSource + noticeRequestSource, { enabled: true });
  if (transformed.results[0]?.status !== 'OK') throw new Error('The source-shaped host fixture was not transformed.');
  const hostBoundary = '\n//#__leverframe_claude_module__:/$bunfs/root/chunk-01y36vdn.js\n';
  const requestBoundary = '\n//#__leverframe_claude_module__:/$bunfs/root/chunk-sq7yspzm.js\n';
  const hostStart = transformed.content.indexOf(hostBoundary);
  const requestStart = transformed.content.indexOf(requestBoundary);
  const hostSource = transformed.content.slice(hostStart + hostBoundary.length, requestStart);
  const requestSource = transformed.content.slice(requestStart + requestBoundary.length)
    .replace(/import\{ai as __lfNoticeAi\}from"[^"]+";/, '');
  let owner: { current?: unknown } = { current: undefined };
  let currentRenderer: HostRenderer | undefined;
  let unsubscribeCount = 0;
  const cleanups: Array<() => void> = [];
  const sessionListeners = new Set<() => void>();
  const session = {
    id: 'host-session',
    subscribe(callback: () => void) {
      sessionListeners.add(callback);
      return () => { unsubscribeCount++; return sessionListeners.delete(callback); };
    },
  };
  const renderer: HostRenderer = {
    __lfOutputAbort: new AbortController(),
    nonBlockingStdout: { routingReady: () => true },
  };
  const processForVm = { env: {
    ...(options.routingActive ? { [ROUTING_ACTIVE_ENV]: ROUTING_ACTIVE_VALUE } : {}),
    ...(options.noticeActive ? { [ROUTING_NOTICE_ACTIVE_ENV]: ROUTING_ACTIVE_VALUE } : {}),
  }, stdout: {} };
  const vmGlobals = {
    process: processForVm,
    URL,
    AbortSignal,
    AbortController,
    TextDecoder,
    Date,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => 'fixture-uuid' },
    A: () => owner,
    no: () => session,
    G: () => undefined,
    dJo: {},
    js: () => undefined,
    Pr: () => undefined,
    ai: () => ({ get: () => currentRenderer }),
    __lfNoticeAi: () => ({ get: () => currentRenderer }),
    cs: { bindHost: () => undefined },
    tr: {},
    Ar: () => undefined,
    z: () => session.id,
    zt(callback: () => unknown, dependencies?: unknown[]) {
      if (dependencies === undefined) callback();
      else cleanups.push(callback() as () => void);
    },
    __lfRecoveryCurrent: () => options.recovery,
    __lfNoticeBodyReached: false,
  };
  const scope = runInNewContext(`${hostSource}\n${requestSource}\n({ host: __lfNoticeHostFixture, request: Fhn })`, vmGlobals);
  const evaluated = scope as { host: () => void; request: (...args: unknown[]) => AsyncGenerator<unknown, void, unknown> };
  currentRenderer = renderer;
  return {
    host: evaluated.host,
    request(signal: AbortSignal, requestContext: Record<string, unknown> = {}) {
      const requestOptions = { modelFacts: undefined, ...requestContext };
      return evaluated.request([], {}, {}, {}, signal, requestOptions);
    },
    renderer,
    session,
    cleanups,
    setOwner(nextOwner: { current?: unknown }) { owner = nextOwner; },
    setRenderer(nextRenderer: HostRenderer | undefined) { currentRenderer = nextRenderer; },
    unsubscribed: () => unsubscribeCount,
    bodyReached: () => vmGlobals.__lfNoticeBodyReached as boolean,
  } satisfies HostHarness;
}

function createNoticeHostHarness(options: { routingActive?: boolean; noticeActive?: boolean; recovery?: unknown } = {}): HostHarness {
  return evaluateNoticeHost(options);
}

it('reuses one bridge when the same owner renders again', () => {
  const harness = createNoticeHostHarness({ noticeActive: true });
  harness.host();
  const attached = harness.renderer.__lfNoticeBridge;
  harness.host();

  expect(harness.renderer.__lfNoticeBridge).toBe(attached);
  expect(harness.unsubscribed()).toBe(0);
});

it('replaces the attachment when a new owner uses the same renderer', () => {
  const harness = createNoticeHostHarness({ noticeActive: true });
  harness.host();
  const first = harness.renderer.__lfNoticeBridge;
  harness.setOwner({});
  harness.host();

  expect(harness.renderer.__lfNoticeBridge).not.toBe(first);
  expect(harness.unsubscribed()).toBe(1);
});

it('does not let an old owner cleanup detach the newer bridge', () => {
  const harness = createNoticeHostHarness({ noticeActive: true });
  harness.host();
  const oldCleanup = harness.cleanups[0]!;
  harness.setOwner({});
  harness.host();
  const current = harness.renderer.__lfNoticeBridge;
  oldCleanup();

  expect(harness.renderer.__lfNoticeBridge).toBe(current);
  expect(harness.unsubscribed()).toBe(1);
});

it('cleans up a renderer attached after the first owner render', () => {
  const harness = createNoticeHostHarness({ noticeActive: true });
  harness.setRenderer(undefined);
  harness.host();
  const lateOwnerCleanup = harness.cleanups[0]!;
  harness.setRenderer(harness.renderer);
  harness.host();
  expect(harness.renderer.__lfNoticeBridge).toBeDefined();

  lateOwnerCleanup();

  expect(harness.renderer.__lfNoticeBridge).toBeUndefined();
  expect(harness.unsubscribed()).toBe(1);
});

it('continues the native request path when routing is off and recovery is unbound', async () => {
  const harness = createNoticeHostHarness({ recovery: { kind: 'unbound' } });
  const iterator = harness.request(new AbortController().signal);
  await iterator.next();

  expect(harness.bodyReached()).toBe(true);
});

it('waits for the attached bridge before entering the transformed Fhn handler', async () => {
  const harness = createNoticeHostHarness({ routingActive: true, noticeActive: true });
  harness.host();
  let finishEnsure!: (ready: boolean) => void;
  const ensureStarted = new Promise<void>(resolve => {
    harness.renderer.__lfNoticeBridge!.ensure = () => {
      resolve();
      return new Promise<boolean>(finish => { finishEnsure = finish; });
    };
  });
  const iterator = harness.request(new AbortController().signal, { agentContext: { leverframeRoutingBinding: true } });
  const next = iterator.next();
  await ensureStarted;
  expect(harness.bodyReached()).toBe(false);

  finishEnsure(true);
  await next;

  expect(harness.bodyReached()).toBe(true);
});

it('rejects a request when the renderer changes while its notice gate is pending', async () => {
  const harness = createNoticeHostHarness({ routingActive: true, noticeActive: true });
  harness.host();
  let finishEnsure!: (ready: boolean) => void;
  const ensureStarted = new Promise<void>(resolve => {
    harness.renderer.__lfNoticeBridge!.ensure = () => {
      resolve();
      return new Promise<boolean>(finish => { finishEnsure = finish; });
    };
  });
  const iterator = harness.request(new AbortController().signal, { agentContext: { leverframeRoutingBinding: true } });
  const next = iterator.next();
  await ensureStarted;
  harness.setRenderer({ __lfOutputAbort: new AbortController(), nonBlockingStdout: { routingReady: () => true } });
  finishEnsure(true);

  await expect(next).rejects.toThrow();
  expect(harness.bodyReached()).toBe(false);
});
