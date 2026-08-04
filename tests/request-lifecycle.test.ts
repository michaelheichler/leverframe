import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_REPLAY_MAX_RETRIES_ENV,
  DEFAULT_AUTO_REPLAY_MAX_RETRIES,
  IllegalLifecycleTransitionError,
  RequestLifecycle,
  autoReplayMaxRetries,
} from '../src/request-lifecycle.js';

function makeLifecycle(overrides: Partial<ConstructorParameters<typeof RequestLifecycle>[0]> = {}) {
  return new RequestLifecycle({
    requestId: 'req-1',
    ...overrides,
  });
}

describe('autoReplayMaxRetries', () => {
  it('uses the default when the environment variable is missing', () => {
    expect(autoReplayMaxRetries({})).toBe(DEFAULT_AUTO_REPLAY_MAX_RETRIES);
  });

  it('uses the default for malformed values', () => {
    expect(autoReplayMaxRetries({ [AUTO_REPLAY_MAX_RETRIES_ENV]: '-1' })).toBe(DEFAULT_AUTO_REPLAY_MAX_RETRIES);
    expect(autoReplayMaxRetries({ [AUTO_REPLAY_MAX_RETRIES_ENV]: 'invalid' })).toBe(DEFAULT_AUTO_REPLAY_MAX_RETRIES);
  });

  it('accepts valid non-negative integers', () => {
    expect(autoReplayMaxRetries({ [AUTO_REPLAY_MAX_RETRIES_ENV]: '0' })).toBe(0);
    expect(autoReplayMaxRetries({ [AUTO_REPLAY_MAX_RETRIES_ENV]: '4' })).toBe(4);
  });

  it('clamps excessive values', () => {
    expect(autoReplayMaxRetries({ [AUTO_REPLAY_MAX_RETRIES_ENV]: '99' })).toBe(10);
  });
});

describe('deadline environment parsing', () => {
  it.each([
    ['42', 42],
    [' 42 ', 42],
    ['10abc', 30_000],
    ['0x10', 30_000],
    ['-5', 30_000],
    ['', 30_000],
  ])('uses %s as a connect deadline input', async (raw, expected) => {
    const previous = process.env.LEVERFRAME_CONNECT_TIMEOUT_MS;
    process.env.LEVERFRAME_CONNECT_TIMEOUT_MS = raw;
    vi.resetModules();
    const module = await import('../src/request-lifecycle.js');
    expect(module.DEFAULT_LIFECYCLE_DEADLINES.connectMs).toBe(expected);
    if (previous === undefined) delete process.env.LEVERFRAME_CONNECT_TIMEOUT_MS;
    else process.env.LEVERFRAME_CONNECT_TIMEOUT_MS = previous;
  });
});

describe('RequestLifecycle transitions', () => {
  it('starts accepted and walks the happy path to completed', () => {
    const lifecycle = makeLifecycle();
    expect(lifecycle.state).toBe('accepted');

    lifecycle.transition('resolving');
    lifecycle.transition('connecting');
    lifecycle.transition('headers');
    lifecycle.transition('streaming');
    lifecycle.markOutputEmitted();
    lifecycle.transition('tool-call-emitted');
    lifecycle.transition('streaming');
    lifecycle.complete();

    expect(lifecycle.state).toBe('completed');
    expect(lifecycle.isTerminal).toBe(true);
    expect(lifecycle.hasEmittedOutput).toBe(true);
    expect(lifecycle.hasEmittedToolCall).toBe(true);
    expect(lifecycle.terminalOutcome?.state).toBe('completed');
    expect(lifecycle.terminalOutcome?.reason).toBeUndefined();
    expect(lifecycle.history.map(t => t.state)).toEqual([
      'accepted', 'resolving', 'connecting', 'headers', 'streaming',
      'tool-call-emitted', 'streaming', 'completed',
    ]);
  });

  it('allows completing directly from headers (no body)', () => {
    const lifecycle = makeLifecycle();
    lifecycle.transition('resolving');
    lifecycle.transition('connecting');
    lifecycle.transition('headers');
    lifecycle.complete();
    expect(lifecycle.state).toBe('completed');
  });

  it('rejects illegal transitions', () => {
    const lifecycle = makeLifecycle();
    expect(() => lifecycle.transition('streaming')).toThrow(IllegalLifecycleTransitionError);
  });

  it('rejects any transition once terminal', () => {
    const lifecycle = makeLifecycle();
    lifecycle.fail(new Error('boom'));
    expect(lifecycle.isTerminal).toBe(true);
    expect(() => lifecycle.transition('resolving')).toThrow(IllegalLifecycleTransitionError);
  });

  it('allows failing or cancelling from any non-terminal state and records why', () => {
    const lifecycle = makeLifecycle();
    lifecycle.transition('resolving');
    lifecycle.cancel('local');
    expect(lifecycle.state).toBe('cancelled');
    expect(lifecycle.terminalOutcome?.reason).toEqual({ kind: 'cancelled', origin: 'local' });
    expect(lifecycle.terminalOutcome?.priorState).toBe('resolving');
  });

  it('fail() records the raw error as the reason', () => {
    const lifecycle = makeLifecycle();
    const boom = new Error('boom');
    lifecycle.fail(boom);
    expect(lifecycle.terminalOutcome?.reason).toEqual({ kind: 'error', error: boom });
  });

  it('canAutoReplay is true only before output or tool-call emission', () => {
    const lifecycle = makeLifecycle();
    expect(lifecycle.canAutoReplay).toBe(true);
    lifecycle.transition('resolving');
    lifecycle.transition('connecting');
    lifecycle.transition('headers');
    lifecycle.transition('streaming');
    expect(lifecycle.canAutoReplay).toBe(true);
    lifecycle.markOutputEmitted();
    expect(lifecycle.canAutoReplay).toBe(false);
  });

  it('canAutoReplay is false after a tool call is emitted even with no output', () => {
    const lifecycle = makeLifecycle();
    lifecycle.transition('resolving');
    lifecycle.transition('connecting');
    lifecycle.transition('headers');
    lifecycle.transition('streaming');
    lifecycle.transition('tool-call-emitted');
    expect(lifecycle.canAutoReplay).toBe(false);
  });
});

describe('RequestLifecycle deadlines', () => {
  it('fires the connect deadline and aborts the signal', async () => {
    vi.useFakeTimers();
    const lifecycle = makeLifecycle({ deadlines: { connectMs: 10 } });
    const abortSpy = vi.fn();
    lifecycle.abortSignal.addEventListener('abort', abortSpy);

    vi.advanceTimersByTime(11);

    expect(lifecycle.state).toBe('failed');
    expect(lifecycle.terminalOutcome?.reason).toEqual({ kind: 'deadline', deadline: 'connect' });
    expect(abortSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('fires the idle deadline only after streaming starts and resets per chunk', () => {
    vi.useFakeTimers();
    const lifecycle = makeLifecycle({ deadlines: { idleMs: 20 } });
    lifecycle.transition('resolving');
    lifecycle.transition('connecting');
    lifecycle.transition('headers');
    lifecycle.transition('streaming');

    vi.advanceTimersByTime(10);
    lifecycle.resetIdleDeadline();
    vi.advanceTimersByTime(10);
    expect(lifecycle.state).toBe('streaming');

    vi.advanceTimersByTime(15);
    expect(lifecycle.state).toBe('failed');
    expect(lifecycle.terminalOutcome?.reason).toEqual({ kind: 'deadline', deadline: 'idle' });
    vi.useRealTimers();
  });

  it('fires the total deadline regardless of state', () => {
    vi.useFakeTimers();
    const lifecycle = makeLifecycle({ deadlines: { totalMs: 5 } });
    vi.advanceTimersByTime(6);
    expect(lifecycle.state).toBe('failed');
    expect(lifecycle.terminalOutcome?.reason).toEqual({ kind: 'deadline', deadline: 'total' });
    vi.useRealTimers();
  });

  it('does not fire a deadline after the lifecycle already completed', () => {
    vi.useFakeTimers();
    const lifecycle = makeLifecycle({ deadlines: { totalMs: 10 } });
    lifecycle.transition('resolving');
    lifecycle.transition('connecting');
    lifecycle.transition('headers');
    lifecycle.complete();
    vi.advanceTimersByTime(20);
    expect(lifecycle.state).toBe('completed');
    vi.useRealTimers();
  });
});

describe('RequestLifecycle cancellation and shutdown', () => {
  it('cancels when an external AbortSignal fires', async () => {
    const controller = new AbortController();
    const lifecycle = makeLifecycle({ signal: controller.signal });
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(lifecycle.state).toBe('cancelled');
  });

  it('is already cancelled shortly after construction if the signal was pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const lifecycle = makeLifecycle({ signal: controller.signal });
    await Promise.resolve();
    await Promise.resolve();
    expect(lifecycle.state).toBe('cancelled');
  });

  it('dispose() clears timers without changing a terminal state', () => {
    vi.useFakeTimers();
    const lifecycle = makeLifecycle({ deadlines: { totalMs: 10 } });
    lifecycle.transition('resolving');
    lifecycle.transition('connecting');
    lifecycle.transition('headers');
    lifecycle.complete();
    lifecycle.dispose();
    vi.advanceTimersByTime(20);
    expect(lifecycle.state).toBe('completed');
    vi.useRealTimers();
  });

  it('records retry attempts with timestamps', () => {
    const lifecycle = makeLifecycle();
    lifecycle.recordRetryAttempt({ attempt: 1, reason: 'overload' });
    expect(lifecycle.attempts).toHaveLength(1);
    expect(lifecycle.attempts[0]).toMatchObject({ attempt: 1, reason: 'overload' });
    expect(typeof lifecycle.attempts[0]!.atMs).toBe('number');
  });
});
