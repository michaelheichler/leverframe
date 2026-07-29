import { describe, expect, it } from 'vitest';
import {
  classifyProviderErrorCategory,
  isProviderErrorCategory,
  LocalFailureError,
  ProviderTransportError,
  parseRetryAfter,
} from '../src/provider-error.js';

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-07-28T12:00:00Z');

  it.each([
    [undefined, undefined],
    ['', undefined],
    ['-1', undefined],
    ['1.5', undefined],
    ['1 second', undefined],
    ['not-a-date', undefined],
    [['1', '2'], undefined],
    ['0', 0],
    ['7', 7_000],
    ['Tue, 28 Jul 2026 12:00:10 GMT', 10_000],
    ['Tue, 28 Jul 2026 11:59:59 GMT', 0],
  ] as const)('parses %j as %j', (value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });
});

describe('ProviderTransportError', () => {
  it('rejects invalid delay metadata and forged failure phases', () => {
    const error = new ProviderTransportError({
      provider: 'openai',
      phase: 'connect',
      retryAfterMs: Number.NaN,
      retryable: true,
      outputEmitted: false,
      safeMessage: 'Connection failed.',
    });

    expect(error.retryAfterMs).toBeUndefined();
    expect(ProviderTransportError.isInstance({
      ...error,
      phase: 'unknown_phase',
    })).toBe(false);
  });

  it('defensively copies safe response headers', () => {
    const headers = { 'x-request-id': 'original' };
    const error = new ProviderTransportError({
      provider: 'openai',
      phase: 'headers',
      retryable: false,
      outputEmitted: false,
      safeMessage: 'Headers failed.',
      responseHeaders: headers,
    });
    headers['x-request-id'] = 'mutated';

    expect(error.responseHeaders).toEqual({ 'x-request-id': 'original' });
  });

  it('preserves safe transport metadata and the original cause', () => {
    const cause = new Error('socket reset');
    const error = new ProviderTransportError({
      provider: 'openai',
      model: 'gpt-test',
      phase: 'websocket_upgrade',
      httpStatus: 503,
      providerRequestId: 'req-safe',
      retryAfterMs: 2_000,
      retryable: true,
      outputEmitted: false,
      cause,
      safeMessage: 'Provider rejected the WebSocket upgrade.',
      responseHeaders: { 'retry-after': '2', 'x-request-id': 'req-safe' },
      attemptCount: 1,
    });

    expect(error).toMatchObject({
      name: 'ProviderTransportError',
      provider: 'openai',
      model: 'gpt-test',
      phase: 'websocket_upgrade',
      httpStatus: 503,
      providerRequestId: 'req-safe',
      retryAfterMs: 2_000,
      retryable: true,
      outputEmitted: false,
      safeMessage: 'Provider rejected the WebSocket upgrade.',
      attemptCount: 1,
    });
    expect(error.cause).toBe(cause);
    expect(error.responseHeaders).toEqual({
      'retry-after': '2',
      'x-request-id': 'req-safe',
    });
    expect(ProviderTransportError.isInstance(error)).toBe(true);
    expect(ProviderTransportError.isInstance(new Error('other'))).toBe(false);
  });
});

describe('classifyProviderErrorCategory', () => {
  it.each([
    [{ phase: 'connect' as const, httpStatus: 401 }, 'auth'],
    [{ phase: 'connect' as const, httpStatus: 403 }, 'permission'],
    [{ phase: 'stream' as const, httpStatus: 429 }, 'rate_limit'],
    [{ phase: 'headers' as const, httpStatus: 400 }, 'invalid_request'],
    [{ phase: 'headers' as const, httpStatus: 503 }, 'overload'],
    [{ phase: 'headers' as const, httpStatus: 500 }, 'upstream'],
    [{ phase: 'connect' as const, cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) }, 'dns'],
    [{ phase: 'connect' as const, cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }, 'connection'],
    [{ phase: 'connect' as const, cause: new Error('self signed certificate in chain') }, 'tls'],
    [{ phase: 'connect' as const, timeoutKind: 'connect' as const }, 'connect_timeout'],
    [{ phase: 'headers' as const, timeoutKind: 'header' as const }, 'header_timeout'],
    [{ phase: 'stream' as const, timeoutKind: 'idle' as const }, 'idle_timeout'],
    [{ phase: 'stream' as const, timeoutKind: 'total' as const }, 'total_timeout'],
    [{ phase: 'stream' as const, cancelled: 'local' as const }, 'local_shutdown'],
    [{ phase: 'stream' as const, cancelled: 'provider' as const }, 'cancellation'],
    [{ phase: 'stream' as const }, 'truncated_stream'],
    [{ phase: 'websocket_upgrade' as const }, 'protocol'],
    [{ phase: 'completion' as const }, 'unknown'],
  ])('classifies %j as %s', (input, expected) => {
    expect(classifyProviderErrorCategory(input)).toBe(expected);
  });

  it('isProviderErrorCategory rejects unknown strings', () => {
    expect(isProviderErrorCategory('rate_limit')).toBe(true);
    expect(isProviderErrorCategory('bogus')).toBe(false);
  });
});

describe('ProviderTransportError category', () => {
  it('infers a category when none is supplied', () => {
    const error = new ProviderTransportError({
      provider: 'anthropic',
      phase: 'headers',
      httpStatus: 429,
      retryable: true,
      outputEmitted: false,
      safeMessage: 'Rate limited.',
    });
    expect(error.category).toBe('rate_limit');
  });

  it('an explicit terminal category forces retryable to false even if the caller passed true', () => {
    const error = new ProviderTransportError({
      provider: 'anthropic',
      phase: 'headers',
      category: 'invalid_request',
      httpStatus: 400,
      retryable: true,
      outputEmitted: false,
      safeMessage: 'Bad request.',
    });
    expect(error.retryable).toBe(false);
  });

  it('preserves the OS error code from the cause', () => {
    const cause = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    const error = new ProviderTransportError({
      provider: 'anthropic',
      phase: 'connect',
      cause,
      retryable: true,
      outputEmitted: false,
      safeMessage: 'Connection reset.',
    });
    expect(error.osErrorCode).toBe('ECONNRESET');
    expect(error.category).toBe('connection');
  });
});

describe('LocalFailureError', () => {
  it('carries a local-only taxonomy category', () => {
    const error = new LocalFailureError({
      category: 'corrupt_checkpoint',
      safeMessage: 'Checkpoint could not be parsed.',
    });
    expect(error.category).toBe('corrupt_checkpoint');
    expect(LocalFailureError.isInstance(error)).toBe(true);
    expect(LocalFailureError.isInstance(new Error('other'))).toBe(false);
  });
});
