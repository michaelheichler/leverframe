import { describe, expect, it, vi } from 'vitest';
import { ProviderTransportError } from '../src/provider-error.js';
import { RequestLifecycle } from '../src/request-lifecycle.js';
import {
  phaseForLifecycleState,
  providerErrorForLifecycleOutcome,
} from '../src/request-lifecycle-error-mapping.js';

describe('phaseForLifecycleState', () => {
  it.each([
    ['accepted', 'connect'],
    ['resolving', 'connect'],
    ['connecting', 'connect'],
    ['headers', 'headers'],
    ['streaming', 'stream'],
    ['tool-call-emitted', 'stream'],
    ['completed', 'completion'],
    ['failed', 'completion'],
    ['cancelled', 'completion'],
  ] as const)('%s -> %s', (state, expected) => {
    expect(phaseForLifecycleState(state)).toBe(expected);
  });
});

describe('providerErrorForLifecycleOutcome', () => {
  it('returns undefined for a completed outcome', () => {
    const lifecycle = new RequestLifecycle({ requestId: 'r1' });
    lifecycle.transition('resolving');
    lifecycle.transition('connecting');
    lifecycle.transition('headers');
    lifecycle.complete();
    expect(providerErrorForLifecycleOutcome(lifecycle.terminalOutcome!, { provider: 'anthropic' })).toBeUndefined();
  });

  it('maps a deadline outcome to the matching category and phase', () => {
    vi.useFakeTimers();
    const lifecycle = new RequestLifecycle({ requestId: 'r2', deadlines: { headerMs: 10 } });
    lifecycle.transition('resolving');
    lifecycle.transition('connecting');
    vi.advanceTimersByTime(11);
    vi.useRealTimers();

    const error = providerErrorForLifecycleOutcome(lifecycle.terminalOutcome!, { provider: 'openai', model: 'gpt-x' });
    expect(error).toBeInstanceOf(ProviderTransportError);
    expect(error).toMatchObject({
      provider: 'openai',
      model: 'gpt-x',
      phase: 'connect',
      category: 'header_timeout',
      retryable: true,
    });
  });

  it('total deadline maps to a retryable total_timeout', () => {
    vi.useFakeTimers();
    const lifecycle = new RequestLifecycle({ requestId: 'r3', deadlines: { totalMs: 5 } });
    vi.advanceTimersByTime(6);
    vi.useRealTimers();

    const error = providerErrorForLifecycleOutcome(lifecycle.terminalOutcome!, { provider: 'anthropic' });
    expect(error).toMatchObject({ category: 'total_timeout', retryable: true });
  });

  it('maps a local cancellation to local_shutdown', () => {
    const lifecycle = new RequestLifecycle({ requestId: 'r4' });
    lifecycle.transition('resolving');
    lifecycle.cancel('local');
    const error = providerErrorForLifecycleOutcome(lifecycle.terminalOutcome!, { provider: 'anthropic' });
    expect(error).toMatchObject({ category: 'local_shutdown', retryable: false, phase: 'connect' });
  });

  it('maps a provider-originated cancellation to cancellation', () => {
    const lifecycle = new RequestLifecycle({ requestId: 'r5' });
    lifecycle.transition('resolving');
    lifecycle.transition('connecting');
    lifecycle.transition('headers');
    lifecycle.transition('streaming');
    lifecycle.cancel('provider');
    const error = providerErrorForLifecycleOutcome(lifecycle.terminalOutcome!, { provider: 'anthropic' });
    expect(error).toMatchObject({ category: 'cancellation', phase: 'stream' });
  });

  it('passes an already-typed ProviderTransportError through unchanged', () => {
    const lifecycle = new RequestLifecycle({ requestId: 'r6' });
    const original = new ProviderTransportError({
      provider: 'anthropic',
      phase: 'headers',
      category: 'rate_limit',
      retryable: true,
      outputEmitted: false,
      safeMessage: 'Rate limited.',
    });
    lifecycle.fail(original);
    const error = providerErrorForLifecycleOutcome(lifecycle.terminalOutcome!, { provider: 'anthropic' });
    expect(error).toBe(original);
  });

  it('wraps a generic error with classification derived from phase/cause', () => {
    const lifecycle = new RequestLifecycle({ requestId: 'r7' });
    const cause = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    lifecycle.fail(cause);
    const error = providerErrorForLifecycleOutcome(lifecycle.terminalOutcome!, { provider: 'anthropic' });
    expect(error).toMatchObject({ category: 'connection', phase: 'connect', retryable: false });
    expect(error?.cause).toBe(cause);
  });

  it('carries attemptCount from the mapping context', () => {
    const lifecycle = new RequestLifecycle({ requestId: 'r8' });
    lifecycle.fail(new Error('boom'));
    const error = providerErrorForLifecycleOutcome(lifecycle.terminalOutcome!, { provider: 'anthropic', attemptCount: 3 });
    expect(error?.attemptCount).toBe(3);
  });
});
