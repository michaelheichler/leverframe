import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

const SAFE_RESPONSE_HEADERS = [
  'retry-after',
  'x-request-id',
  'request-id',
  'openai-request-id',
  'x-openai-request-id',
] as const;
const MAX_REJECTED_BODY_PREFIX_BYTES = 4_096;
const MAX_REJECTED_BODY_BYTES = 64 * 1_024;

function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

export function safeResponseHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = headerValue(headers, name);
    if (value !== undefined) safe[name] = value;
  }
  return safe;
}

export function providerRequestId(headers: IncomingHttpHeaders): string | undefined {
  for (const name of SAFE_RESPONSE_HEADERS) {
    if (!name.includes('request-id')) continue;
    const value = headerValue(headers, name)?.trim();
    if (value) return value.slice(0, 256);
  }
  return undefined;
}

/** Drain a rejected WebSocket-upgrade response body for diagnostics without buffering it whole. */
export function observeRejectedResponseBody(
  response: IncomingMessage,
  emit: (summary: Record<string, unknown>) => void,
): void {
  let bytesObserved = 0;
  let prefixBytes = 0;
  let completed = false;
  let truncated = false;
  const hash = createHash('sha256');
  const finish = () => {
    if (completed) return;
    completed = true;
    emit({
      bodyBytesObserved: bytesObserved,
      bodyPrefixSha256: prefixBytes > 0 ? hash.digest('hex').slice(0, 16) : undefined,
      bodyTruncated: truncated,
    });
    response.destroy();
  };
  response.on('data', chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytesObserved += bytes.length;
    const remaining = MAX_REJECTED_BODY_PREFIX_BYTES - prefixBytes;
    if (remaining > 0) {
      const prefix = bytes.subarray(0, remaining);
      hash.update(prefix);
      prefixBytes += prefix.length;
    }
    if (bytesObserved > MAX_REJECTED_BODY_BYTES) {
      truncated = true;
      response.destroy();
    }
  });
  response.once('end', finish);
  response.once('close', finish);
  response.once('error', finish);
  response.resume();
}
