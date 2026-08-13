import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ConnectionEntry,
  JsonObject,
  RequestContext,
  ResponsesWebSocketDiagnosticContext,
  ResponsesWebSocketFetchOptions,
} from './responses-websocket-types.js';

const diagnosticContext = new AsyncLocalStorage<ResponsesWebSocketDiagnosticContext>();

/** Correlate a gateway/proxy request with the lower-level SDK WebSocket fetch. */
export function withResponsesWebSocketDiagnosticContext<T>(
  context: ResponsesWebSocketDiagnosticContext,
  fn: () => T,
): T {
  return diagnosticContext.run(context, fn);
}

export function currentDiagnosticContext(): ResponsesWebSocketDiagnosticContext | undefined {
  return diagnosticContext.getStore();
}

export function emitDiagnostic(
  options: ResponsesWebSocketFetchOptions,
  event: { event: string } & Record<string, unknown>,
  correlation = diagnosticContext.getStore(),
): void {
  if (!options.onDiagnostic) return;
  try {
    options.onDiagnostic({
      ...event,
      ...(correlation?.requestId ? { requestId: correlation.requestId } : {}),
      ...(correlation?.claudeSessionId ? { claudeSessionId: correlation.claudeSessionId } : {}),
    });
  } catch {
    // Diagnostics must never alter inference behavior.
  }
}

export function boundedDiagnosticIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && /^[a-zA-Z0-9_.:/-]+$/.test(normalized)
    ? normalized.slice(0, 128)
    : undefined;
}

export function diagnosticTextFingerprint(
  field: 'errorMessage' | 'closeReason',
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  return {
    [`${field}Bytes`]: Buffer.byteLength(value),
    [`${field}Hash`]: createHash('sha256').update(value).digest('hex').slice(0, 16),
  };
}

export function diagnosticItemIdHash(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? createHash('sha256').update(value).digest('hex').slice(0, 16)
    : undefined;
}

export function responseFailureDetails(event: unknown): Record<string, unknown> {
  if (!event || typeof event !== 'object') return {};
  const record = event as JsonObject;
  const response = record.response && typeof record.response === 'object'
    ? record.response as JsonObject
    : undefined;
  const error = record.error && typeof record.error === 'object'
    ? record.error as JsonObject
    : response?.error && typeof response.error === 'object'
      ? response.error as JsonObject
      : undefined;
  const incomplete = response?.incomplete_details && typeof response.incomplete_details === 'object'
    ? response.incomplete_details as JsonObject
    : undefined;
  const message = typeof error?.message === 'string'
    ? error.message
    : typeof record.message === 'string' ? record.message : undefined;
  return {
    errorType: boundedDiagnosticIdentifier(error?.type ?? record.type),
    errorCode: boundedDiagnosticIdentifier(error?.code ?? record.code),
    responseStatus: boundedDiagnosticIdentifier(response?.status),
    incompleteReason: boundedDiagnosticIdentifier(incomplete?.reason),
    ...diagnosticTextFingerprint('errorMessage', message),
  };
}

export function emitContextDiagnostic(
  entry: ConnectionEntry,
  ctx: RequestContext,
  details: { event: string } & Record<string, unknown>,
): void {
  ctx.emitDiagnostic?.({
    connectionId: entry.debugId,
    generation: entry.generation,
    continued: ctx.continued,
    retried: ctx.retried,
    frameCount: ctx.frameCount,
    emittedModelData: ctx.emittedModelData,
    responseIdReceived: Boolean(ctx.responseId),
    inFlightMs: entry.inFlightStartedAt === undefined
      ? undefined
      : Math.max(0, entry.options.now() - entry.inFlightStartedAt),
    ...details,
  });
}

export function emitResponseErrorDiagnostic(
  entry: ConnectionEntry,
  ctx: RequestContext,
  details: Record<string, unknown>,
): void {
  emitContextDiagnostic(entry, ctx, { event: 'ws_response_error', ...details });
}
