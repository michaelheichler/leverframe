import { describe, it, expect } from 'vitest';
import {
  createRequestExecutionContext,
  cancelAllActiveRequestExecutions,
  activeRequestExecutionCountForTests,
} from '../src/request-execution-context.js';

function makeContext(overrides: Partial<Parameters<typeof createRequestExecutionContext>[0]> = {}) {
  return createRequestExecutionContext({
    requestId: 'req-1',
    provider: 'test-provider',
    model: 'test-model',
    ...overrides,
  });
}

describe('RequestExecutionContext encapsulation', () => {
  it('does not expose the underlying RequestLifecycle instance', () => {
    const context = makeContext();
    expect((context as unknown as { lifecycle?: unknown }).lifecycle).toBeUndefined();
    context.dispose();
  });

  it('drives phase transitions only through its narrow observer surface', () => {
    const context = makeContext();
    expect(context.getSnapshot().state).toBe('accepted');
    context.startResolving();
    context.startConnecting();
    context.markHeadersReceived();
    context.markStreamActivity();
    expect(context.getSnapshot().state).toBe('streaming');
    context.markOutputEmitted();
    expect(context.getSnapshot().outputEmitted).toBe(true);
    expect(context.canReplay()).toBe(false);
    context.complete();
    expect(context.getSnapshot().isTerminal).toBe(true);
    context.dispose();
  });

  it('canReplay() is true only before any output/tool-call has been emitted and before termination', () => {
    const context = makeContext();
    expect(context.canReplay()).toBe(true);
    context.startResolving();
    context.startConnecting();
    context.markHeadersReceived();
    context.markStreamActivity();
    context.markToolCallEmitted();
    expect(context.canReplay()).toBe(false);
    context.dispose();
  });
});

describe('RequestExecutionContext.finish()', () => {
  it('returns undefined before the lifecycle has reached a terminal state', () => {
    const context = makeContext();
    expect(context.finish()).toBeUndefined();
    context.dispose();
  });

  it('returns undefined for a clean completed outcome', () => {
    const context = makeContext();
    context.startResolving();
    context.startConnecting();
    context.markHeadersReceived();
    context.markStreamActivity();
    context.complete();
    expect(context.finish()).toBeUndefined();
  });

  it('maps a failed outcome to a ProviderTransportError carrying the given provider/model/attemptCount', () => {
    const context = makeContext({ provider: 'acme', model: 'acme-large' });
    const cause = new Error('boom');
    context.fail(cause);
    const mapped = context.finish(3);
    expect(mapped).toBeDefined();
    expect(mapped?.provider).toBe('acme');
    expect(mapped?.model).toBe('acme-large');
    expect(mapped?.attemptCount).toBe(3);
  });

  it('maps a local cancellation to a non-retryable local_shutdown category', () => {
    const context = makeContext();
    context.cancel('local');
    const mapped = context.finish();
    expect(mapped?.category).toBe('local_shutdown');
    expect(mapped?.retryable).toBe(false);
  });
});

describe('RequestExecutionContext local-shutdown registry', () => {
  it('cancelAllActiveRequestExecutions() settles every in-flight context to a cancelled terminal outcome', () => {
    const a = makeContext({ requestId: 'req-a' });
    const b = makeContext({ requestId: 'req-b' });
    expect(activeRequestExecutionCountForTests()).toBeGreaterThanOrEqual(2);

    cancelAllActiveRequestExecutions();

    expect(a.getSnapshot().isTerminal).toBe(true);
    expect(b.getSnapshot().isTerminal).toBe(true);
    expect(a.finish()?.category).toBe('local_shutdown');
    expect(b.finish()?.category).toBe('local_shutdown');
    a.dispose();
    b.dispose();
  });

  it('untracks a context once it completes, so a later shutdown sweep leaves it alone', () => {
    const countBefore = activeRequestExecutionCountForTests();
    const context = makeContext({ requestId: 'req-complete' });
    expect(activeRequestExecutionCountForTests()).toBe(countBefore + 1);
    context.startResolving();
    context.startConnecting();
    context.markHeadersReceived();
    context.markStreamActivity();
    context.complete();
    expect(activeRequestExecutionCountForTests()).toBe(countBefore);

    // A shutdown sweep after completion must not throw or alter the already
    // clean terminal outcome (RequestLifecycle's terminal states never
    // transition again).
    cancelAllActiveRequestExecutions();
    expect(context.finish()).toBeUndefined();
  });

  it('dispose() releases timers without forcing a terminal state', () => {
    const context = makeContext({ requestId: 'req-dispose' });
    context.dispose();
    expect(context.getSnapshot().isTerminal).toBe(false);
  });
});

describe('RequestExecutionContext downstream-disconnect signal', () => {
  it('an external abort signal cancels the lifecycle with origin "local"', () => {
    const controller = new AbortController();
    const context = makeContext({ signal: controller.signal });
    controller.abort();
    expect(context.getSnapshot().isTerminal).toBe(true);
    expect(context.finish()?.category).toBe('local_shutdown');
  });
});
