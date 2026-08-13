import type { ConnectionEntry, JsonObject, RequestContext } from './responses-websocket-types.js';
import { deleteEntry } from './responses-websocket-connection-pool.js';
import { emitContextDiagnostic, emitResponseErrorDiagnostic } from './responses-websocket-diagnostics.js';
import {
  errorContext,
  flushPending,
  resetContextForRetry,
  settleHandshakeSuccess,
} from './responses-websocket-context.js';
import { ProviderTransportError } from '../provider-error.js';

export const RETRYABLE_UPGRADE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const DEFAULT_THROTTLE_RETRY_AFTER_MS = 5_000;
const MAX_THROTTLE_RETRY_AFTER_MS = 60_000;

export function boundedThrottleRetryAfterMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_THROTTLE_RETRY_AFTER_MS;
  }
  return Math.min(Math.round(value), MAX_THROTTLE_RETRY_AFTER_MS);
}

export function numericRetryAfterMs(value: string | undefined): number | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined;
  const seconds = Number(value.trim());
  return Number.isSafeInteger(seconds) && seconds <= Number.MAX_SAFE_INTEGER / 1_000
    ? seconds * 1_000
    : undefined;
}

export function responseRetryAfterMs(event: unknown): number | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as JsonObject;
  const response = record.response && typeof record.response === 'object'
    ? record.response as JsonObject
    : undefined;
  for (const candidate of [record, record.error, response?.error]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const error = candidate as JsonObject;
    const value = error.retry_after_seconds ?? error.retry_after;
    if (typeof value === 'number' && Number.isFinite(value)) return value * 1_000;
    if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
      return Number(value) * 1_000;
    }
  }
  return undefined;
}

export const RETRYABLE_SOCKET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
]);
export const RETRYABLE_CLOSE_CODES = new Set([1006, 1011, 1012, 1013, 1014]);

export function socketFailureIsRetryable(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code && RETRYABLE_SOCKET_CODES.has(code)) return true;
  return /connection reset|socket hang up|timed? ?out|network unreachable|handshake.*timed out/i
    .test(error.message);
}

function transportErrorWithAttempt(
  error: ProviderTransportError,
  attemptCount: number,
  retriesExhausted: boolean,
  outputEmitted: boolean,
): ProviderTransportError {
  return new ProviderTransportError({
    provider: error.provider,
    model: error.model,
    phase: error.phase,
    // Keep the original category so a reclassified error (e.g. bodyless 403 mapped to rate_limit) does not re-collapse to permission below.
    category: error.category,
    httpStatus: error.httpStatus,
    providerRequestId: error.providerRequestId,
    retryAfterMs: error.retryAfterMs,
    retryable: error.retryable,
    retriesExhausted,
    outputEmitted,
    cause: error.cause,
    safeMessage: error.safeMessage,
    responseHeaders: error.responseHeaders,
    attemptCount,
  });
}

function retryBudgetExhausted(
  entry: ConnectionEntry,
  ctx: RequestContext,
  error: ProviderTransportError,
): boolean {
  return ctx.transportRetryCount >= entry.options.maxTransportRetries
    || (error.retryAfterMs !== undefined && error.retryAfterMs > entry.options.retryMaxDelayMs);
}

function retryDelayMs(entry: ConnectionEntry, ctx: RequestContext, error: ProviderTransportError): number {
  const exponent = Math.max(0, ctx.transportRetryCount);
  const jitter = 0.5 + Math.max(0, Math.min(1, entry.options.random()));
  const backoff = Math.min(
    entry.options.retryMaxDelayMs,
    Math.round(entry.options.retryBaseDelayMs * (2 ** exponent) * jitter),
  );
  return Math.max(backoff, error.retryAfterMs ?? 0);
}

function failContext(
  entry: ConnectionEntry,
  ctx: RequestContext,
  error: ProviderTransportError,
  diagnosticDetails: Record<string, unknown>,
): void {
  if (ctx.closed || ctx.entry !== entry) return;
  entry.debug(`fail: ${error.safeMessage}`);
  emitResponseErrorDiagnostic(entry, ctx, {
    ...diagnosticDetails,
    failurePhase: error.phase,
    httpStatusCode: diagnosticDetails['httpStatusCode'] ?? error.httpStatus,
    providerRequestId: error.providerRequestId,
    retryAfterMs: error.retryAfterMs,
    retryable: error.retryable,
    retriesExhausted: error.retriesExhausted,
    attemptCount: error.attemptCount,
    outputEmitted: error.outputEmitted,
  });
  flushPending(ctx);
  deleteEntry(entry);
  errorContext(ctx, error);
}

function retryTransportFailure(
  entry: ConnectionEntry,
  ctx: RequestContext,
  error: ProviderTransportError,
  diagnosticDetails: Record<string, unknown>,
  preOutputFrameAllowance = 0,
): boolean {
  if (
    ctx.closed
    || ctx.entry !== entry
    || !error.retryable
    || retryBudgetExhausted(entry, ctx, error)
    || ctx.frameCount > preOutputFrameAllowance
    || ctx.emittedModelData
    || ctx.signal?.aborted
  ) return false;

  const delayMs = retryDelayMs(entry, ctx, error);

  ctx.transportRetryCount += 1;
  ctx.transportRetryPending = true;
  entry.debug(`transport failed before output; retrying in ${delayMs}ms`);
  emitContextDiagnostic(entry, ctx, {
    event: 'ws_transport_retry',
    outcome: 'started',
    attemptNumber: ctx.transportRetryCount + 1,
    delayMs,
    failurePhase: error.phase,
    httpStatusCode: error.httpStatus,
    providerRequestId: error.providerRequestId,
    ...diagnosticDetails,
  });
  deleteEntry(entry);
  ctx.retryTimer = setTimeout(() => {
    ctx.retryTimer = undefined;
    if (ctx.closed || ctx.signal?.aborted) {
      ctx.transportRetryPending = false;
      emitContextDiagnostic(entry, ctx, {
        event: 'ws_transport_retry',
        outcome: 'cancelled',
        attemptNumber: ctx.transportRetryCount + 1,
      });
      return;
    }
    resetContextForRetry(ctx);
    let replacement: ConnectionEntry;
    try {
      replacement = ctx.createReplacement();
    } catch (cause) {
      const connectionError = new ProviderTransportError({
        provider: ctx.provider,
        model: ctx.model,
        phase: 'connect',
        retryable: false,
        outputEmitted: false,
        cause,
        safeMessage: 'Provider WebSocket connection could not be created.',
        attemptCount: ctx.transportRetryCount + 1,
      });
      ctx.transportRetryPending = false;
      failContext(entry, ctx, connectionError, { source: 'connection_constructor' });
      return;
    }
    if (ctx.closed || ctx.signal?.aborted) {
      ctx.transportRetryPending = false;
      deleteEntry(replacement);
      return;
    }
    ctx.redispatch(replacement);
    if (replacement.open) settleHandshakeSuccess(ctx);
  }, delayMs);
  ctx.retryTimer.unref?.();
  return true;
}

export function handleTransportFailure(
  entry: ConnectionEntry,
  ctx: RequestContext,
  error: ProviderTransportError,
  diagnosticDetails: Record<string, unknown>,
  preOutputFrameAllowance = 0,
): void {
  if (retryTransportFailure(entry, ctx, error, diagnosticDetails, preOutputFrameAllowance)) return;
  if (ctx.closed || ctx.entry !== entry) return;
  const retriesExhausted = error.retryable
    && ctx.frameCount <= preOutputFrameAllowance
    && !ctx.emittedModelData
    && retryBudgetExhausted(entry, ctx, error);
  const finalError = transportErrorWithAttempt(
    error,
    ctx.transportRetryCount + 1,
    retriesExhausted,
    ctx.emittedModelData,
  );
  if (ctx.transportRetryPending) {
    ctx.transportRetryPending = false;
    emitContextDiagnostic(entry, ctx, {
      event: 'ws_transport_retry',
      outcome: 'exhausted',
      attemptNumber: finalError.attemptCount,
      failurePhase: finalError.phase,
      httpStatusCode: finalError.httpStatus,
      ...diagnosticDetails,
    });
  }
  failContext(entry, ctx, finalError, diagnosticDetails);
}
