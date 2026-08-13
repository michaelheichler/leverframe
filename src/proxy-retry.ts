// src/proxy-retry.ts, transient-failure classification for the SDK auto-replay loop
import { sdkTranslationErrorSignature } from './sdk-adapter.js';
import { sdkUpstreamErrorDetails } from './upstream-error.js';

const TRANSIENT_CONNECTION_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** Nested SDK wrappers must not hide a transient transport cause or upstream 5xx. */
export function isTransientSdkStreamFailure(error: unknown): boolean {
  if (sdkTranslationErrorSignature(error) === 'reasoning_part_not_found') return true;

  const sdkStatusCode = sdkUpstreamErrorDetails(error)?.statusCode;
  if (sdkStatusCode !== undefined && sdkStatusCode >= 500 && sdkStatusCode <= 599) return true;

  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const value = pending.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const record = value as {
      cause?: unknown;
      code?: unknown;
      errors?: unknown[];
      lastError?: unknown;
      message?: unknown;
      statusCode?: unknown;
    };
    if (typeof record.statusCode === 'number' && record.statusCode >= 500 && record.statusCode <= 599) return true;
    if (typeof record.code === 'string' && TRANSIENT_CONNECTION_CODES.has(record.code)) return true;
    if (typeof record.message === 'string'
      && /connection reset|premature close|socket hang up|terminated/i.test(record.message)) {
      return true;
    }
    pending.push(record.cause, record.lastError);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
  }
  return false;
}
