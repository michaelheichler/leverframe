import { describe, expect, it } from 'vitest';
import {
  ProviderTransportError,
  ToolResultImageError,
} from '../src/provider-error.js';
import {
  clientFacingAnthropicStatus,
  formatUpstreamError,
  isContextLengthExceededError,
  isTerminalUsageLimitText,
  messageFromErrorPayload,
  sdkUpstreamErrorDetails,
  sdkUpstreamResponseHeaders,
  upstreamHttpStatus,
} from '../src/upstream-error.js';
import { anthropicPromptTooLongMessage } from '../src/anthropic-endpoints.js';
import { APICallError, RetryError } from 'ai';

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

describe('terminal usage limit surfacing', () => {
  const goUsageBody = JSON.stringify({
    type: 'error',
    error: {
      type: 'GoUsageLimitError',
      message: 'Monthly usage limit reached. Resets in 13 days.',
    },
  });

  it('extracts error.message from OpenCode-style JSON bodies', () => {
    expect(messageFromErrorPayload(goUsageBody)).toBe(
      'Monthly usage limit reached. Resets in 13 days.',
    );
  });

  it('classifies GoUsageLimitError text as a terminal usage ceiling', () => {
    expect(isTerminalUsageLimitText(goUsageBody)).toBe(true);
    expect(isTerminalUsageLimitText('rate limit exceeded')).toBe(false);
  });

  it('remaps terminal usage ceilings to HTTP 400 for Anthropic clients', () => {
    expect(clientFacingAnthropicStatus(429, 'Monthly usage limit reached.', goUsageBody)).toBe(400);
    expect(clientFacingAnthropicStatus(429, 'rate limit exceeded')).toBe(429);
  });

  it('surfaces GoUsageLimitError text through RetryError wrappers', () => {
    const inner = new APICallError({
      message: 'Failed after 2 attempts',
      url: 'https://example.test',
      requestBodyValues: {},
      statusCode: 429,
      responseBody: goUsageBody,
      isRetryable: true,
    });
    const wrapped = new RetryError({
      message: 'Failed after 2 attempts. Last error: Failed after 2 attempts',
      reason: 'maxRetriesExceeded',
      errors: [inner],
    });
    expect(formatUpstreamError(wrapped)).toBe(
      'Monthly usage limit reached. Resets in 13 days. (HTTP 429)',
    );
  });
});

describe('isContextLengthExceededError', () => {
  it('classifies an OpenAI-style context_length_exceeded body as true', () => {
    const err = {
      message: 'Bad request',
      data: {
        error: {
          code: 'context_length_exceeded',
          type: 'invalid_request_error',
          message: 'This model\'s maximum context length is 128000 tokens.',
        },
      },
    };
    expect(isContextLengthExceededError(err)).toBe(true);
  });

  it('does not classify marketing-ish "context window" copy with no token numbers', () => {
    const err = { message: 'This model supports a large context window.' };
    expect(isContextLengthExceededError(err)).toBe(false);
  });

  it('classifies "context window" phrasing when it co-occurs with a token count', () => {
    const err = { message: 'Request exceeds the context window: 300000 tokens provided.' };
    expect(isContextLengthExceededError(err)).toBe(true);
  });

  it('round-trips leverframe\'s own synthesized prompt-too-long message as true', () => {
    const synthesized = anthropicPromptTooLongMessage(
      { messages: [{ role: 'user', content: 'hello' }] },
      10,
    );
    expect(isContextLengthExceededError({ message: synthesized })).toBe(true);
  });

  it('does not classify an unrelated 503 overload body', () => {
    const err = {
      message: 'Upstream overloaded',
      data: {
        error: {
          code: 'server_is_overloaded',
          type: 'overloaded_error',
          message: 'The server is temporarily overloaded, please retry.',
        },
      },
    };
    expect(isContextLengthExceededError(err)).toBe(false);
  });
});
