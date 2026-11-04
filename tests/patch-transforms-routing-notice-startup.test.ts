import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { ROUTING_ACTIVE_VALUE, ROUTING_NOTICE_ACTIVE_ENV } from '../src/constants.js';
import { applyRoutingNoticeStartupTransform } from '../src/patch-transforms-routing-notice-startup.js';
import { ROUTING_NOTICE_TRUST_SOURCE } from '../src/patch-transforms-routing-notice-trust.js';
import { noticeStartupSource } from './fixtures/claude-agent-2.1.314-notice-startup.js';

function createNoticeStartupHarness() {
  const stdout = Object.assign(new EventEmitter(), {
    fd: 1, isTTY: true, destroyed: false, writableEnded: false, errored: null, columns: 80, rows: 24,
    write: vi.fn((_data: string | Buffer) => true),
  });
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, isRaw: false, pause: vi.fn(), unref: vi.fn() });
  const processHarness = { stdout, stdin, env: { [ROUTING_NOTICE_ACTIVE_ENV]: ROUTING_ACTIVE_VALUE } };
  const trustRequests: Array<{ signal: AbortSignal; resolve: (writer?: typeof stdout.write) => void }> = [];
  const barriers: Array<() => void> = [];
  const writers: Array<{ active: boolean; ready: boolean; isActive: () => boolean; routingReady: () => boolean;
    barrier: (original: typeof stdout.write, signal: AbortSignal, deadline: number) => Promise<void>;
    flush: () => void; restore: () => void }> = [];
  const fakeTrust = (_out: typeof stdout, signal: AbortSignal, _deadline: number) =>
    new Promise<typeof stdout.write | undefined>(resolve => trustRequests.push({ signal, resolve }));
  const makeWriter = () => {
    let trustedWrite: typeof stdout.write | undefined;
    const writer = {
      active: true,
      ready: false,
      isActive: () => writer.active,
      routingReady: () => writer.ready && processHarness.stdout === stdout && stdout.write === trustedWrite,
      barrier: (original: typeof stdout.write, _signal: AbortSignal, _deadline: number) => new Promise<void>(resolve => {
        trustedWrite = original;
        barriers.push(() => { writer.ready = true; resolve(); });
      }),
      flush: () => { writer.active = false; writer.ready = false; },
      restore: () => { writer.active = false; writer.ready = false; },
    };
    writers.push(writer);
    return writer;
  };
  const sandbox: Record<string, unknown> = { Buffer, Date, AbortController, clearTimeout, setTimeout, queueMicrotask,
    process: processHarness, __lfInjectedTrust: fakeTrust, ANs: makeWriter, jWn: () => false, RNs: () => false,
    __lfForceRedraw: vi.fn(), v: () => false, i: { CLAUDE_BG_BACKEND: 'fixture' }, Yle: '\u001b[r', FF: '', Pv: () => {}, Yne: () => '',
    Cv: () => {}, So: () => {}, Ks: () => false, t: () => {},
    _t: { flushSyncFromReconciler: () => {}, updateContainerSync: () => {}, flushSyncWork: () => {} },
    ai: () => ({ treeRoots: new Map(), get: () => undefined, delete: () => {} }), yAr: () => {}, Nyo: () => {}, ff: () => [] };
  return { sandbox, stdout, trustRequests, barriers, writers };
}

function evaluateTransformedNoticeStartup(source: string) {
  const harness = createNoticeStartupHarness();
  const transformed = applyRoutingNoticeStartupTransform(source, { enabled: true });
  const testSource = transformed.content.replace(ROUTING_NOTICE_TRUST_SOURCE,
    'async function __lfTrustedOriginal(out,signal,deadline){return __lfInjectedTrust(out,signal,deadline)}');
  runInNewContext(`${testSource}\nglobalThis.__makeStartupRenderer=s7e;`, harness.sandbox);
  const Renderer = harness.sandbox['__makeStartupRenderer'] as new (options: Record<string, unknown>) => {
    __lfEnsureOutput: () => Promise<boolean>;
    pause: () => void;
    resume: () => void;
    handoffAltScreen: () => void;
    handoffRawMode: () => void;
    detachForShutdown: () => void;
    unmount: (error?: Error) => void;
    nonBlockingStdout: unknown;
    forceRedraw: ReturnType<typeof vi.fn>;
  };
  const renderer = new Renderer({ stdout: harness.stdout, stderr: new EventEmitter(), stdin: harness.sandbox['process']
    && (harness.sandbox['process'] as { stdin: EventEmitter }).stdin, patchConsole: true, isScreenReaderEnabled: false });
  return { ...harness, renderer, replaceProcessStdout: (replacement: typeof harness.stdout) => {
    (harness.sandbox['process'] as { stdout: typeof harness.stdout }).stdout = replacement;
  } };
}

it('deduplicates concurrent initialization until trust and the original-write barrier complete', async () => {
  const harness = evaluateTransformedNoticeStartup(noticeStartupSource);
  const first = harness.renderer.__lfEnsureOutput();
  const concurrent = harness.renderer.__lfEnsureOutput();
  let settled = false;
  void first.then(() => { settled = true; });

  expect(harness.trustRequests).toHaveLength(1);
  expect(harness.writers).toHaveLength(0);
  harness.trustRequests[0]!.resolve(harness.stdout.write);
  await new Promise(resolve => setImmediate(resolve));

  expect(harness.writers).toHaveLength(1);
  expect(harness.barriers).toHaveLength(1);
  expect(settled).toBe(false);
  harness.barriers[0]!();

  expect(await first).toBe(true);
  expect(await concurrent).toBe(true);
  expect(harness.writers).toHaveLength(1);
  expect(harness.renderer.forceRedraw).toHaveBeenCalledOnce();
});

it('does not create the notice writer when terminal trust fails', async () => {
  const harness = evaluateTransformedNoticeStartup(noticeStartupSource);
  const initialization = harness.renderer.__lfEnsureOutput();

  harness.trustRequests[0]!.resolve(undefined);

  expect(await initialization).toBe(false);
  expect(harness.writers).toHaveLength(0);
  expect(harness.renderer.forceRedraw).not.toHaveBeenCalled();
});

it('does not resolve readiness before the original stdout barrier completes', async () => {
  const harness = evaluateTransformedNoticeStartup(noticeStartupSource);
  const initialization = harness.renderer.__lfEnsureOutput();
  let settled = false;
  void initialization.then(() => { settled = true; });
  harness.trustRequests[0]!.resolve(harness.stdout.write);
  await new Promise(resolve => setImmediate(resolve));

  expect(harness.writers[0]?.routingReady()).toBe(false);
  expect(settled).toBe(false);
  harness.barriers[0]!();

  expect(await initialization).toBe(true);
  expect(harness.writers[0]?.routingReady()).toBe(true);
});

it.each([
  { lifecycle: 'pause', stop: (renderer: { pause: () => void }) => renderer.pause() },
  { lifecycle: 'alternate-screen handoff', stop: (renderer: { handoffAltScreen: () => void }) => renderer.handoffAltScreen() },
  { lifecycle: 'raw-mode handoff', stop: (renderer: { handoffRawMode: () => void }) => renderer.handoffRawMode() },
  { lifecycle: 'shutdown detach', stop: (renderer: { detachForShutdown: () => void }) => renderer.detachForShutdown() },
  { lifecycle: 'unmount', stop: (renderer: { unmount: () => void }) => renderer.unmount() },
])('cancels pending writer startup during $lifecycle', async ({ stop }) => {
  const harness = evaluateTransformedNoticeStartup(noticeStartupSource);
  const initialization = harness.renderer.__lfEnsureOutput();
  const trust = harness.trustRequests[0]!;

  stop(harness.renderer);
  expect(trust.signal.aborted).toBe(true);
  trust.resolve(harness.stdout.write);

  expect(await initialization).toBe(false);
  expect(harness.writers).toHaveLength(0);
  expect(harness.renderer.forceRedraw).not.toHaveBeenCalled();
});

it('reuses the owned writer while it remains active and ready', async () => {
  const harness = evaluateTransformedNoticeStartup(noticeStartupSource);
  const initialization = harness.renderer.__lfEnsureOutput();
  harness.trustRequests[0]!.resolve(harness.stdout.write);
  await new Promise(resolve => setImmediate(resolve));
  harness.barriers[0]!();
  expect(await initialization).toBe(true);

  const reused = await harness.renderer.__lfEnsureOutput();

  expect(reused).toBe(true);
  expect(harness.trustRequests).toHaveLength(1);
  expect(harness.writers).toHaveLength(1);
});

it('does not reinstall the owned writer after stdout is replaced even when the writer is copied', async () => {
  const harness = evaluateTransformedNoticeStartup(noticeStartupSource);
  const initialization = harness.renderer.__lfEnsureOutput();
  harness.trustRequests[0]!.resolve(harness.stdout.write);
  await new Promise(resolve => setImmediate(resolve));
  harness.barriers[0]!();
  expect(await initialization).toBe(true);
  harness.writers[0]!.active = false;
  const foreign = { isActive: vi.fn(() => true), routingReady: vi.fn(() => true),
    barrier: vi.fn(async () => {}), flush: vi.fn(), restore: vi.fn() };
  harness.renderer.nonBlockingStdout = foreign;
  const replacement = Object.assign(new EventEmitter(), { fd: 1, isTTY: true, destroyed: false,
    writableEnded: false, errored: null, columns: 80, rows: 24, write: harness.stdout.write });
  harness.replaceProcessStdout(replacement as typeof harness.stdout);

  const retry = harness.renderer.__lfEnsureOutput();

  expect(await retry).toBe(false);
  expect(foreign.barrier).not.toHaveBeenCalled();
  expect(harness.trustRequests).toHaveLength(1);
  expect(harness.writers).toHaveLength(1);
});

it('refuses readiness when the same stdout object gets a foreign write function', async () => {
  const harness = evaluateTransformedNoticeStartup(noticeStartupSource);
  const initialization = harness.renderer.__lfEnsureOutput();
  harness.trustRequests[0]!.resolve(harness.stdout.write);
  await new Promise(resolve => setImmediate(resolve));
  harness.barriers[0]!();
  expect(await initialization).toBe(true);
  harness.writers[0]!.active = false;
  harness.stdout.write = vi.fn(() => true);

  const retry = harness.renderer.__lfEnsureOutput();

  expect(await retry).toBe(false);
  expect(harness.trustRequests).toHaveLength(1);
  expect(harness.writers).toHaveLength(1);
});

it.each([
  { operation: 'flush', invalidate: (writer: { flush: () => void }) => writer.flush() },
  { operation: 'restore', invalidate: (writer: { restore: () => void }) => writer.restore() },
])('retries output readiness after a known writer $operation', async ({ invalidate }) => {
  const harness = evaluateTransformedNoticeStartup(noticeStartupSource);
  const initial = harness.renderer.__lfEnsureOutput();
  harness.trustRequests[0]!.resolve(harness.stdout.write);
  await new Promise(resolve => setImmediate(resolve));
  harness.barriers[0]!();
  expect(await initial).toBe(true);
  invalidate(harness.writers[0]!);

  const retry = harness.renderer.__lfEnsureOutput();

  expect(harness.trustRequests).toHaveLength(1);
  await new Promise(resolve => setImmediate(resolve));
  harness.barriers[1]!();

  expect(await retry).toBe(true);
  expect(harness.writers).toHaveLength(2);
});

it('ignores a trust callback from an earlier paused startup generation', async () => {
  const harness = evaluateTransformedNoticeStartup(noticeStartupSource);
  const stale = harness.renderer.__lfEnsureOutput();
  harness.renderer.pause();
  harness.renderer.resume();
  const current = harness.renderer.__lfEnsureOutput();

  expect(harness.trustRequests).toHaveLength(2);
  harness.trustRequests[0]!.resolve(harness.stdout.write);
  expect(await stale).toBe(false);
  expect(harness.writers).toHaveLength(0);
  harness.trustRequests[1]!.resolve(harness.stdout.write);
  await new Promise(resolve => setImmediate(resolve));
  harness.barriers[0]!();

  expect(await current).toBe(true);
  expect(harness.writers).toHaveLength(1);
  expect(harness.renderer.forceRedraw).toHaveBeenCalledOnce();
});
