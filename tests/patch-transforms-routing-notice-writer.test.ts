import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { applyRoutingNoticeWriterTransform } from '../src/patch-transforms-routing-notice-writer.js';
import { noticeWriterSource } from './fixtures/claude-agent-2.1.314-notice-writer.js';

type WriterHandle = {
  flush(): void;
  restore(): void;
  isActive(): boolean;
  routingReady(): boolean;
  queuedBytes(): number;
  barrier(expected: typeof Function.prototype, signal: AbortSignal, deadline: number): Promise<void>;
  writeTracked(data: string | Buffer, signal: AbortSignal, deadline: number,
    onComplete: () => void, onFailure: () => void): void;
};

const sourceModule = '\n//#__leverframe_claude_module__:/$bunfs/root/chunk-w2wf6pm6.js\n';

function noticeWriterSourceFixture(): string {
  return sourceModule + noticeWriterSource;
}

function evaluateTransformedWriter(source: string, writeSyncStub: (fd: number, buffer: Buffer) => number = (_fd, buffer) => buffer.length) {
  const transformed = applyRoutingNoticeWriterTransform(source, { enabled: true });
  expect(transformed.content).not.toBe(source);
  const accepted: Buffer[] = [];
  const originalWrites: Buffer[] = [];
  const originalCallbacks: Array<(error?: Error) => void> = [];
  const startedAt = Date.now();
  const clock = { now: startedAt, startedAt };
  const queueLimit = 32;
  const timerQueue: Array<{ active: boolean; due: number; run: () => void; unref: () => void }> = [];
  const stdout = Object.assign(new EventEmitter(), { isTTY: true, destroyed: false }) as EventEmitter & {
    isTTY: boolean; destroyed: boolean;
    write: (chunk: string | Buffer, encodingOrCallback?: unknown, callback?: unknown) => boolean;
  };
  const originalWrite = (chunk: string | Buffer, encodingOrCallback?: unknown, callback?: unknown): boolean => {
    originalWrites.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
    const completion = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (typeof completion === 'function') originalCallbacks.push(completion as (error?: Error) => void);
    return true;
  };
  stdout.write = originalWrite;
  const processHarness = { stdout, on: () => {}, off: () => {} };
  const setTimeoutStub = (callback: (...args: unknown[]) => void, _delay: number, ...args: unknown[]) => {
    const timer = { active: true, due: clock.now + _delay, run: () => callback(...args), unref: () => {} };
    timerQueue.push(timer);
    return timer;
  };
  const clearTimeoutStub = (timer: { active: boolean } | undefined) => { if (timer) timer.active = false; };
  const sandbox: Record<string, unknown> = {
    Buffer, Date: class extends Date { static override now() { return clock.now; } },
    process: processHarness, d: new WeakMap(), b: new Set(),
    XCo: () => ({ fd: 17 }), F: (fd: number, buffer: Buffer) => {
      const count = writeSyncStub(fd, Buffer.from(buffer));
      if (count > 0) accepted.push(Buffer.from(buffer.subarray(0, count)));
      return count;
    },
    k: (error: unknown) => error && typeof error === 'object' && 'code' in error ? error.code : undefined,
    t: () => {}, S: () => {}, l: () => {}, ir: () => undefined, N: () => {}, Q: queueLimit, L: 1, I: Buffer.from('reset'),
    performance: { now: () => clock.now - clock.startedAt }, setTimeout: setTimeoutStub, clearTimeout: clearTimeoutStub,
  };
  runInNewContext(`${transformed.content}\nglobalThis.__makeWriter = ANs;`, sandbox);
  const makeWriter = sandbox['__makeWriter'] as (onEpisodeEnd: () => void) => WriterHandle;
  return {
    stdout,
    replaceProcessStdout: (replacement: typeof stdout) => { processHarness.stdout = replacement; },
    originalWrite,
    queueLimit,
    createWriter: () => makeWriter(() => {}),
    acceptedBytes: () => Buffer.concat(accepted),
    originalBytes: () => Buffer.concat(originalWrites),
    completeOriginalWrite: (error?: Error) => originalCallbacks.shift()?.(error),
    runNextTimer: () => {
      const timer = timerQueue.filter(candidate => candidate.active).sort((left, right) => left.due - right.due)[0];
      if (timer) { timer.active = false; clock.now = Math.max(clock.now, timer.due); timer.run(); }
    },
    activeTimerCount: () => timerQueue.filter(timer => timer.active).length,
    deadline: (delay = 5_000) => clock.now + delay,
  };
}

it('leaves the source unchanged when tracked output is disabled', () => {
  const source = noticeWriterSourceFixture();
  const transformed = applyRoutingNoticeWriterTransform(source, { enabled: false });

  expect(transformed.content).toBe(source);
});

it('waits for the captured original stdout write callback before resolving the barrier', async () => {
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture());
  const handle = harness.createWriter();
  const controller = new AbortController();
  let resolved = false;
  const barrier = handle.barrier(harness.originalWrite, controller.signal, harness.deadline()).then(() => { resolved = true; });

  expect(resolved).toBe(false);
  harness.completeOriginalWrite();
  await barrier;

  expect(resolved).toBe(true);
});

it('reports routing readiness only after the original stdout barrier completes', async () => {
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture());
  const handle = harness.createWriter();
  const controller = new AbortController();
  const barrier = handle.barrier(harness.originalWrite, controller.signal, harness.deadline());

  expect(handle.routingReady()).toBe(false);
  harness.completeOriginalWrite();
  await barrier;

  expect(handle.routingReady()).toBe(true);
});

it('clears routing readiness when stdout is flushed', async () => {
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture());
  const handle = harness.createWriter();
  const controller = new AbortController();
  const barrier = handle.barrier(harness.originalWrite, controller.signal, harness.deadline());
  harness.completeOriginalWrite();
  await barrier;

  handle.flush();

  expect(handle.routingReady()).toBe(false);
});

it('clears routing readiness when stdout is restored', async () => {
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture());
  const handle = harness.createWriter();
  const controller = new AbortController();
  const barrier = handle.barrier(harness.originalWrite, controller.signal, harness.deadline());
  harness.completeOriginalWrite();
  await barrier;

  handle.restore();

  expect(handle.routingReady()).toBe(false);
});

it('clears routing readiness when queued output is dropped', async () => {
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture(), () => 0);
  const handle = harness.createWriter();
  const controller = new AbortController();
  const barrier = handle.barrier(harness.originalWrite, controller.signal, harness.deadline());
  harness.completeOriginalWrite();
  await barrier;
  const failure = vi.fn();

  handle.writeTracked(Buffer.alloc(harness.queueLimit, 65), controller.signal, harness.deadline(), vi.fn(), failure);
  harness.stdout.write('overflow');

  expect(handle.routingReady()).toBe(false);
  expect(failure).toHaveBeenCalledOnce();
});

it('clears routing readiness when the installed writer loses ownership', async () => {
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture());
  const handle = harness.createWriter();
  const controller = new AbortController();
  const barrier = handle.barrier(harness.originalWrite, controller.signal, harness.deadline());
  harness.completeOriginalWrite();
  await barrier;
  harness.stdout.write = () => true;

  expect(handle.routingReady()).toBe(false);
});

it('clears routing readiness when stdout is replaced by an object with a copied writer', async () => {
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture());
  const handle = harness.createWriter();
  const controller = new AbortController();
  const barrier = handle.barrier(harness.originalWrite, controller.signal, harness.deadline());
  harness.completeOriginalWrite();
  await barrier;
  const copiedWriter = harness.stdout.write;
  const replacement = Object.assign(new EventEmitter(), { isTTY: true, destroyed: false, write: copiedWriter });
  harness.replaceProcessStdout(replacement as typeof harness.stdout);

  expect(handle.routingReady()).toBe(false);
});

it('rejects the barrier when the earlier original stdout write fails', async () => {
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture());
  const handle = harness.createWriter();
  const controller = new AbortController();
  const barrier = handle.barrier(harness.originalWrite, controller.signal, harness.deadline());
  harness.completeOriginalWrite(new Error('fixture stream failure'));

  await expect(barrier).rejects.toHaveProperty('message');
});

it('rejects the barrier when the caller supplies an unknown original writer', async () => {
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture());
  const handle = harness.createWriter();
  const controller = new AbortController();

  await expect(handle.barrier(() => {}, controller.signal, harness.deadline())).rejects.toHaveProperty('message');
});

it('rejects readiness and removes listeners from the old stdout when process.stdout changes', async () => {
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture());
  const handle = harness.createWriter();
  const oldStdout = harness.stdout;
  const controller = new AbortController();
  const barrier = handle.barrier(harness.originalWrite, controller.signal, harness.deadline());
  const replacement = Object.assign(new EventEmitter(), { isTTY: true, destroyed: false, write: () => true });
  harness.replaceProcessStdout(replacement as typeof harness.stdout);
  harness.completeOriginalWrite();
  await expect(barrier).rejects.toHaveProperty('message');
  const complete = vi.fn();
  const failure = vi.fn();

  handle.writeTracked(Buffer.from('notice'), controller.signal, harness.deadline(), complete, failure);

  expect(oldStdout.listenerCount('error')).toBe(0);
  expect(oldStdout.listenerCount('close')).toBe(0);
  expect(complete).not.toHaveBeenCalled();
  expect(failure).toHaveBeenCalledOnce();
});

it('completes an immediate tracked write only after the full notice bytes reach the fd', async () => {
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture());
  const handle = harness.createWriter();
  const controller = new AbortController();
  const barrier = handle.barrier(harness.originalWrite, controller.signal, harness.deadline());
  harness.completeOriginalWrite();
  await barrier;
  const complete = vi.fn();
  const failure = vi.fn();

  handle.writeTracked(Buffer.from('notice-frame'), controller.signal, harness.deadline(), complete, failure);

  expect(harness.acceptedBytes()).toEqual(Buffer.from('notice-frame'));
  expect(complete).toHaveBeenCalledOnce();
  expect(failure).not.toHaveBeenCalled();
});

it('waits for partial tracked bytes to drain before completing the notice', async () => {
  const writes = [2, 0, 1, 2];
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture(), (_fd, _buffer) => writes.shift() ?? 0);
  const handle = harness.createWriter();
  const controller = new AbortController();
  const barrier = handle.barrier(harness.originalWrite, controller.signal, harness.deadline());
  harness.completeOriginalWrite();
  await barrier;
  const complete = vi.fn();
  const failure = vi.fn();

  handle.writeTracked(Buffer.from('frame'), controller.signal, harness.deadline(), complete, failure);
  expect(complete).not.toHaveBeenCalled();
  harness.runNextTimer();
  expect(complete).not.toHaveBeenCalled();
  harness.runNextTimer();

  expect(harness.acceptedBytes()).toEqual(Buffer.from('frame'));
  expect(complete).toHaveBeenCalledOnce();
  expect(failure).not.toHaveBeenCalled();
});

it('rejects a tracked write when an ordinary stdout write intervenes', async () => {
  const writes = [1, 0, 64];
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture(), (_fd, _buffer) => writes.shift() ?? 0);
  const handle = harness.createWriter();
  const controller = new AbortController();
  const barrier = handle.barrier(harness.originalWrite, controller.signal, harness.deadline());
  harness.completeOriginalWrite();
  await barrier;
  const complete = vi.fn();
  const failure = vi.fn();

  handle.writeTracked(Buffer.from('notice'), controller.signal, harness.deadline(), complete, failure);
  harness.stdout.write('ordinary output');
  harness.runNextTimer();

  expect(complete).not.toHaveBeenCalled();
  expect(failure).toHaveBeenCalledOnce();
});

it('rejects a tracked write when the nonblocking queue drops its bytes', async () => {
  const writes = [0];
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture(), (_fd, _buffer) => writes.shift() ?? 0);
  const handle = harness.createWriter();
  const controller = new AbortController();
  const barrier = handle.barrier(harness.originalWrite, controller.signal, harness.deadline());
  harness.completeOriginalWrite();
  await barrier;
  const complete = vi.fn();
  const failure = vi.fn();

  handle.writeTracked(Buffer.alloc(32, 65), controller.signal, harness.deadline(), complete, failure);
  harness.stdout.write('x');

  expect(complete).not.toHaveBeenCalled();
  expect(failure).toHaveBeenCalledOnce();
});

it.each([
  { operation: 'flush', apply: (handle: WriterHandle) => handle.flush() },
  { operation: 'restore', apply: (handle: WriterHandle) => handle.restore() },
])('rejects a pending tracked write when stdout is $operation', async ({ apply }) => {
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture(), () => 0);
  const handle = harness.createWriter();
  const controller = new AbortController();
  const barrier = handle.barrier(harness.originalWrite, controller.signal, harness.deadline());
  harness.completeOriginalWrite();
  await barrier;
  const complete = vi.fn();
  const failure = vi.fn();

  handle.writeTracked(Buffer.from('notice'), controller.signal, harness.deadline(), complete, failure);
  apply(handle);

  expect(complete).not.toHaveBeenCalled();
  expect(failure).toHaveBeenCalledOnce();
});

it('rejects a tracked write if another writer takes ownership before drain', async () => {
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture(), () => 0);
  const handle = harness.createWriter();
  const controller = new AbortController();
  const barrier = handle.barrier(harness.originalWrite, controller.signal, harness.deadline());
  harness.completeOriginalWrite();
  await barrier;
  const complete = vi.fn();
  const failure = vi.fn();

  handle.writeTracked(Buffer.from('notice'), controller.signal, harness.deadline(), complete, failure);
  harness.stdout.write = () => true;
  harness.runNextTimer();

  expect(complete).not.toHaveBeenCalled();
  expect(failure).toHaveBeenCalledOnce();
});

it.each([
  { event: 'error', error: new Error('fixture stdout failure') },
  { event: 'close', error: undefined },
])('rejects queued notice bytes after stdout emits $event', async ({ event, error }) => {
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture(), () => 0);
  const handle = harness.createWriter();
  const controller = new AbortController();
  const barrier = handle.barrier(harness.originalWrite, controller.signal, harness.deadline());
  harness.completeOriginalWrite();
  await barrier;
  const complete = vi.fn();
  const failure = vi.fn();

  handle.writeTracked(Buffer.from('notice'), controller.signal, harness.deadline(), complete, failure);
  harness.stdout.emit(event, error);

  expect(complete).not.toHaveBeenCalled();
  expect(failure).toHaveBeenCalledOnce();
});

it('rejects queued notice bytes when the request aborts before drain', async () => {
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture(), () => 0);
  const handle = harness.createWriter();
  const controller = new AbortController();
  const barrier = handle.barrier(harness.originalWrite, controller.signal, harness.deadline());
  harness.completeOriginalWrite();
  await barrier;
  const complete = vi.fn();
  const failure = vi.fn();

  handle.writeTracked(Buffer.from('notice'), controller.signal, harness.deadline(), complete, failure);
  controller.abort();

  expect(complete).not.toHaveBeenCalled();
  expect(failure).toHaveBeenCalledOnce();
});

it('rejects queued notice bytes when the deadline timer fires before drain', async () => {
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture(), () => 0);
  const handle = harness.createWriter();
  const controller = new AbortController();
  const barrier = handle.barrier(harness.originalWrite, controller.signal, harness.deadline());
  harness.completeOriginalWrite();
  await barrier;
  const complete = vi.fn();
  const failure = vi.fn();

  handle.writeTracked(Buffer.from('notice'), controller.signal, harness.deadline(1), complete, failure);
  harness.runNextTimer();

  expect(complete).not.toHaveBeenCalled();
  expect(failure).toHaveBeenCalledOnce();
});

it('removes stdout listeners and deadline timers after tracked output completes', async () => {
  const harness = evaluateTransformedWriter(noticeWriterSourceFixture());
  const handle = harness.createWriter();
  const controller = new AbortController();
  const barrier = handle.barrier(harness.originalWrite, controller.signal, harness.deadline());
  harness.completeOriginalWrite();
  await barrier;
  const complete = vi.fn();
  const failure = vi.fn();

  handle.writeTracked(Buffer.from('notice'), controller.signal, harness.deadline(), complete, failure);

  expect(harness.stdout.listenerCount('error')).toBe(0);
  expect(harness.stdout.listenerCount('close')).toBe(0);
  expect(harness.activeTimerCount()).toBe(0);
  expect(complete).toHaveBeenCalledOnce();
  expect(failure).not.toHaveBeenCalled();
});
