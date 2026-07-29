import { describe, expect, it } from 'vitest';
import {
  ProviderTransportError,
  ToolResultImageError,
} from '../src/provider-error.js';
import {
  formatUpstreamError,
  sdkUpstreamErrorDetails,
  sdkUpstreamResponseHeaders,
  upstreamHttpStatus,
} from '../src/upstream-error.js';

describe('typed provider transport errors', () => {
  const error = new ProviderTransportError({
    provider: 'openai',
    model: 'gpt-test',
    phase: 'websocket_upgrade',
    httpStatus: 429,
    providerRequestId: 'provider-request-123',
    retryAfterMs: 2_500,
    retryable: true,
    outputEmitted: false,
    safeMessage: 'Provider WebSocket upgrade was rejected.',
    attemptCount: 2,
  });

  it('preserves status, retry, request, and phase metadata', () => {
    expect(sdkUpstreamErrorDetails(error)).toEqual({
      statusCode: 429,
      errorContent: 'Provider WebSocket upgrade was rejected.',
      isRetryable: true,
      retriesExhausted: false,
      attemptCount: 2,
      retryAfterMs: 2_500,
      providerRequestId: 'provider-request-123',
      failurePhase: 'websocket_upgrade',
    });
    expect(upstreamHttpStatus(error, '')).toBe(429);
    expect(formatUpstreamError(error)).toBe(
      'Provider WebSocket upgrade was rejected. (HTTP 429)',
    );
  });

  it('does not advertise another retry after the local budget is exhausted', () => {
    const exhausted = new ProviderTransportError({
      provider: 'openai',
      phase: 'connect',
      retryable: true,
      retriesExhausted: true,
      outputEmitted: false,
      safeMessage: 'Connection failed.',
      attemptCount: 2,
    });

    expect(sdkUpstreamErrorDetails(exhausted)).toMatchObject({
      isRetryable: false,
      retriesExhausted: true,
      attemptCount: 2,
    });
  });

  it('classifies invalid tool-result images as terminal client input errors', () => {
    const imageError = new ToolResultImageError('malformed_base64');

    expect(sdkUpstreamErrorDetails(imageError)).toEqual({
      statusCode: 400,
      errorContent: 'Tool-result image content is invalid or unsupported (malformed_base64).',
      isRetryable: false,
      attemptCount: 1,
    });
    expect(upstreamHttpStatus(imageError, formatUpstreamError(imageError))).toBe(400);
  });

  it('normalizes only safe provider response headers', () => {
    expect(sdkUpstreamResponseHeaders(sdkUpstreamErrorDetails(error))).toEqual({
      'Retry-After': '3',
      'X-Provider-Request-Id': 'provider-request-123',
    });
  });
});
