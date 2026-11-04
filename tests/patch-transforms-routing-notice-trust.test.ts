import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { ROUTING_NOTICE_TRUST_SOURCE } from '../src/patch-transforms-routing-notice-trust.js';

type TrustOptions = {
  autoClose?: boolean;
  openThrows?: boolean;
  streamThrows?: boolean;
  streamFd?: number;
  streamIsTTY?: boolean;
  matchingIdentity?: boolean;
  sameWriter?: boolean;
  originalTTY?: boolean;
};

class FakeTtyWriteStream extends EventEmitter {
  readonly fd: number;
  readonly isTTY: boolean;
  readonly destroyed = false;
  readonly writableEnded = false;
  readonly errored = null;
  readonly write: (data: string | Buffer) => boolean;
  destroyCalls = 0;
  closed = false;
  private readonly autoClose: boolean;

  constructor(fd: number, options: { isTTY?: boolean; autoClose?: boolean; write?: (data: string | Buffer) => boolean } = {}) {
    super();
    this.fd = fd;
    this.isTTY = options.isTTY ?? true;
    this.autoClose = options.autoClose ?? false;
    this.write = options.write ?? (() => true);
  }

  destroy(): void {
    this.destroyCalls++;
    if (this.autoClose) queueMicrotask(() => this.emitClose());
  }

  emitClose(): void {
    this.closed = true;
    this.emit('close');
  }
}

function createTrustedWriterHarness(options: TrustOptions = {}) {
  const originalWrite = vi.fn((_data: string | Buffer) => true);
  const duplicateStreams: FakeTtyWriteStream[] = [];
  const transferredFd = 9;
  const closedFds: number[] = [];
  const statsMatch = options.matchingIdentity !== false;
  const controller = new AbortController();
  const signal = controller.signal;
  let abortListenerAdds = 0;
  let abortListenerRemoves = 0;
  const addAbortListener = signal.addEventListener.bind(signal);
  const removeAbortListener = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: 'abort', listener: EventListenerOrEventListenerObject, settings?: boolean | AddEventListenerOptions) => {
    if (type === 'abort') abortListenerAdds++;
    return addAbortListener(type, listener, settings);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: 'abort', listener: EventListenerOrEventListenerObject, settings?: boolean | EventListenerOptions) => {
    if (type === 'abort') abortListenerRemoves++;
    return removeAbortListener(type, listener, settings);
  }) as typeof signal.removeEventListener;

  const fs = {
    constants: { O_WRONLY: 1, O_NOCTTY: 2 },
    openSync: () => {
      if (options.openThrows) throw new Error('open failed');
      return transferredFd;
    },
    fstatSync: (fd: number) => ({ dev: 1, ino: statsMatch ? 2 : fd, rdev: 3, mode: 4 }),
    closeSync: (fd: number) => { closedFds.push(fd); },
  };
  const tty = {
    isatty: () => true,
    WriteStream: class extends FakeTtyWriteStream {
      constructor(fd: number) {
        if (fd !== 1 && options.streamThrows) throw new Error('stream creation failed');
        super(fd === 1 ? fd : options.streamFd ?? fd, {
          isTTY: fd === 1 ? true : options.streamIsTTY,
          autoClose: fd === 1 ? false : options.autoClose,
          write: fd === 1 || options.sameWriter !== false ? originalWrite : vi.fn(() => true),
        });
        if (fd !== 1) duplicateStreams.push(this);
      }
    },
  };
  const out = options.originalTTY === false
    ? Object.assign(new EventEmitter(), { fd: 1, isTTY: true, destroyed: false, writableEnded: false,
      errored: null, write: originalWrite })
    : new tty.WriteStream(1);
  const streamModule = { Writable: FakeTtyWriteStream };
  const modules = new Map<string, unknown>([['node:fs', fs], ['node:tty', tty], ['node:stream', streamModule]]);
  const processHarness = { stdout: out };
  const invoke = (deadline = Date.now() + 1_000) => runInNewContext(
    `${ROUTING_NOTICE_TRUST_SOURCE}\n__lfTrustedOriginal(process.stdout, signal, deadline)`,
    { require: (specifier: string) => modules.get(specifier), process: processHarness, signal, deadline,
      AbortSignal, Date, setTimeout, clearTimeout, queueMicrotask },
  ) as Promise<((data: string | Buffer) => boolean) | undefined>;

  return { invoke, out, originalWrite, get duplicate() { return duplicateStreams[0]!; }, closedFds, transferredFd, controller,
    get abortListenerAdds() { return abortListenerAdds; }, get abortListenerRemoves() { return abortListenerRemoves; } };
}

it('returns the original writer only after the owned duplicate stream closes', async () => {
  const harness = createTrustedWriterHarness();
  const result = harness.invoke();
  let settled = false;
  void result.then(() => { settled = true; });

  await Promise.resolve();

  expect(settled).toBe(false);
  expect(harness.duplicate.destroyCalls).toBe(1);
  harness.duplicate.emitClose();
  const writer = await result;

  expect(writer).toBe(harness.originalWrite);
  expect(harness.closedFds).toEqual([]);
  expect(harness.duplicate.listenerCount('close')).toBe(0);
  expect(harness.duplicate.listenerCount('error')).toBe(0);
  expect(harness.abortListenerRemoves).toBe(harness.abortListenerAdds);
});

it.each([
  { label: 'different device identity', options: { matchingIdentity: false }, closedFds: [9], destroyCalls: 0 },
  { label: 'different descriptor', options: { streamFd: 10 }, closedFds: [9], destroyCalls: 0 },
  { label: 'non-terminal duplicate', options: { streamIsTTY: false, autoClose: true }, closedFds: [], destroyCalls: 1 },
  { label: 'different write capability', options: { sameWriter: false, autoClose: true }, closedFds: [], destroyCalls: 1 },
  { label: 'unrecognized original writer', options: { originalTTY: false }, closedFds: [], destroyCalls: 0 },
])('fails closed for $label', async ({ options, closedFds, destroyCalls }) => {
  const harness = createTrustedWriterHarness(options);

  const writer = await harness.invoke();

  expect(writer).toBeUndefined();
  expect(harness.duplicate?.destroyCalls ?? 0).toBe(destroyCalls);
  expect(harness.closedFds).toEqual(closedFds);
});

it('aborts while waiting for close and removes the duplicate stream listeners', async () => {
  const harness = createTrustedWriterHarness();
  const result = harness.invoke();

  await Promise.resolve();
  harness.controller.abort();
  const writer = await result;
  harness.duplicate.emitClose();

  expect(writer).toBeUndefined();
  expect(harness.duplicate.listenerCount('close')).toBe(0);
  expect(harness.duplicate.listenerCount('error')).toBe(0);
  expect(harness.abortListenerRemoves).toBe(harness.abortListenerAdds);
});

it('fails closed on a duplicate stream error and cleans listeners after close', async () => {
  const harness = createTrustedWriterHarness();
  const result = harness.invoke();

  await Promise.resolve();
  harness.duplicate.emit('error', new Error('duplicate stream failed'));
  const writer = await result;
  harness.duplicate.emitClose();

  expect(writer).toBeUndefined();
  expect(harness.duplicate.listenerCount('close')).toBe(0);
  expect(harness.duplicate.listenerCount('error')).toBe(0);
  expect(harness.abortListenerRemoves).toBe(harness.abortListenerAdds);
});

it('stops waiting at its deadline and cleans listeners', async () => {
  const harness = createTrustedWriterHarness();

  const writer = await harness.invoke(Date.now() + 10);
  harness.duplicate.emitClose();

  expect(writer).toBeUndefined();
  expect(harness.duplicate.listenerCount('close')).toBe(0);
  expect(harness.duplicate.listenerCount('error')).toBe(0);
  expect(harness.abortListenerRemoves).toBe(harness.abortListenerAdds);
});

it.each([
  { label: 'opening the descriptor', options: { openThrows: true }, closedFds: [] },
  { label: 'creating the duplicate stream', options: { streamThrows: true }, closedFds: [9] },
])('fails closed if setup throws while $label', async ({ options, closedFds }) => {
  const harness = createTrustedWriterHarness(options);

  const writer = await harness.invoke();

  expect(writer).toBeUndefined();
  expect(harness.closedFds).toEqual(closedFds);
});
