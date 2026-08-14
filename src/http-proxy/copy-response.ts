// Why: Claude --print retries HTTP 429 until timeout, so terminal usage
// ceilings must be remapped before the client sees the upstream status.

import type * as http from 'node:http';
import {
  clientFacingAnthropicStatus,
  isTerminalUsageLimitText,
} from '../upstream-error.js';

const MAX_ERROR_BODY_BYTES = 64 * 1024;

export interface CopyResponseOptions {
  onErrorResponse?: (statusCode: number, body: string) => void;
  onResponseUsage?: (usage: {
    usageStage: 'message_start' | 'message_delta';
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  }) => void;
  onResponseUsageComplete?: () => void;
  observeSuccessSseUsage?: (
    upstream: http.IncomingMessage,
    contentEncoding: string | string[] | undefined,
    hooks: {
      onUsage: NonNullable<CopyResponseOptions['onResponseUsage']>;
      onComplete: () => void;
    },
  ) => void;
}

function rebuildRawHeaders(
  rawHeaders: string[],
  options: { stripRetryAfter: boolean; contentLength: number },
): string[] {
  const out: string[] = [];
  let sawContentLength = false;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] ?? '';
    const value = rawHeaders[i + 1] ?? '';
    const lower = name.toLowerCase();
    if (lower === 'transfer-encoding') continue;
    if (options.stripRetryAfter && lower === 'retry-after') continue;
    if (lower === 'content-length') {
      sawContentLength = true;
      out.push(name, String(options.contentLength));
      continue;
    }
    out.push(name, value);
  }
  if (!sawContentLength) out.push('Content-Length', String(options.contentLength));
  return out;
}

/**
 * Copy an upstream response to the client. Error statuses are buffered so
 * terminal usage-limit 429s can become non-retryable 400s for Claude --print.
 */
export function copyResponse(
  upstream: http.IncomingMessage,
  res: http.ServerResponse,
  options: CopyResponseOptions = {},
): void {
  const upstreamStatus = upstream.statusCode ?? 502;
  const contentType = upstream.headers['content-type'];
  if (
    upstreamStatus < 400
    && options.onResponseUsage
    && typeof contentType === 'string'
    && contentType.includes('text/event-stream')
    && options.observeSuccessSseUsage
  ) {
    options.observeSuccessSseUsage(upstream, upstream.headers['content-encoding'], {
      onUsage: options.onResponseUsage,
      onComplete: options.onResponseUsageComplete ?? (() => {}),
    });
  } else {
    options.onResponseUsageComplete?.();
  }

  if (upstreamStatus < 400) {
    res.writeHead(upstreamStatus, upstream.statusMessage, upstream.rawHeaders);
    upstream.once('error', () => res.destroy());
    upstream.pipe(res);
    return;
  }

  const errorChunks: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;
  let settled = false;

  const finish = (suffix = '') => {
    if (settled || res.headersSent) return;
    settled = true;
    const body = Buffer.concat(errorChunks);
    const bodyText = `${body.toString('utf8')}${truncated ? ' [truncated]' : ''}${suffix}`;
    options.onErrorResponse?.(upstreamStatus, bodyText);
    const clientStatus = clientFacingAnthropicStatus(upstreamStatus, bodyText, bodyText);
    const stripRetryAfter = clientStatus !== upstreamStatus
      || isTerminalUsageLimitText(bodyText);
    const headers = rebuildRawHeaders(upstream.rawHeaders, {
      stripRetryAfter,
      contentLength: body.length,
    });
    res.writeHead(clientStatus, upstream.statusMessage, headers);
    res.end(body);
  };

  upstream.on('data', (chunk: Buffer) => {
    if (capturedBytes >= MAX_ERROR_BODY_BYTES) {
      truncated = true;
      return;
    }
    const available = MAX_ERROR_BODY_BYTES - capturedBytes;
    const captured = chunk.length > available ? chunk.subarray(0, available) : chunk;
    errorChunks.push(Buffer.from(captured));
    capturedBytes += captured.length;
    if (captured.length < chunk.length) truncated = true;
  });
  upstream.once('end', () => finish());
  upstream.once('error', err => {
    finish(` [stream error: ${err.message}]`);
    if (!res.writableEnded) res.destroy();
  });
}
