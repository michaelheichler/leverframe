import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import type { RequestExecutionObserver } from './request-execution-context.js';
import { sanitizeCredential } from './server/auth.js';
import { CLAUDE_CODE_USER_AGENT } from './oauth/claude-identity.js';
import { createSseHeartbeat } from './sse-heartbeat.js';
import { anthropicErrorType } from './upstream-error.js';

function createBoundaryTransform(onWrite: (chunk: Buffer) => void): Transform {
  return new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.push(buffer);
      onWrite(buffer);
      callback();
    },
  });
}


export function anthropicUpstreamHeaders(
  apiKey: string,
  stream = false,
  inboundBeta?: string,
  authType?: 'api' | 'oauth',
  claudeCodeSessionId?: string,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  const key = sanitizeCredential(apiKey) ?? apiKey.trim();
  const isOAuth = authType === 'oauth';
  const headers: Record<string, string> = {
    ...extraHeaders,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    Authorization: `Bearer ${key}`,
    ...(isOAuth ? {} : { 'x-api-key': key }),
    ...(isOAuth ? { 'User-Agent': CLAUDE_CODE_USER_AGENT, 'x-app': 'cli' } : {}),
    ...(isOAuth && claudeCodeSessionId ? { 'X-Claude-Code-Session-Id': claudeCodeSessionId } : {}),
    ...(stream ? { Accept: 'text/event-stream' } : {}),
  };
  if (inboundBeta) {
    headers['anthropic-beta'] = inboundBeta;
  }
  return headers;
}

export class UpstreamUnreachableError extends Error {
  constructor(cause: unknown) {
    super(`Upstream unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'UpstreamUnreachableError';
  }
}

export async function fetchWithOAuthRetry<TResponse extends { status: number }>(
  apiKey: string,
  request: (apiKey: string) => Promise<TResponse>,
  refreshToken?: (rejectedToken: string) => Promise<string | null>,
): Promise<{ response: TResponse; apiKey: string; refreshed: boolean }> {
  let response = await request(apiKey);
  if (response.status !== 401 || !refreshToken) {
    return { response, apiKey, refreshed: false };
  }

  const refreshed = await refreshToken(apiKey).catch(() => null);
  if (!refreshed || refreshed === apiKey) {
    return { response, apiKey, refreshed: false };
  }

  response = await request(refreshed);
  return { response, apiKey: refreshed, refreshed: true };
}

/** Relay an Anthropic /v1/messages response (JSON or SSE) to the client. */
export interface RelayAnthropicOptions {
  inboundBeta?: string;
  authType?: 'api' | 'oauth';
  log?: (message: string) => void;
  claudeCodeSessionId?: string;
  extraHeaders?: Record<string, string>;
  refreshToken?: (rejectedToken: string) => Promise<string | null>;
  onTokenRefreshed?: (token: string) => void | Promise<void>;
  onUpstreamError?: (statusCode: number, body: string) => void;
  signal?: AbortSignal;
  /** Optional provider-neutral lifecycle observer; receives native HTTP phase/output hooks. */
  lifecycle?: RequestExecutionObserver;
  responseModelId?: string;
  /**
   * Read-only observation hook: called with a copy of each streamed text
   * chunk (or, for a non-stream response, the full decoded body once) in the
   * exact bytes forwarded to the client. Never used to alter what is sent —
   * exists so callers can tee already-outbound bytes into execution
   * tracking without touching this function's byte-for-byte passthrough
   * behavior (stabilization plan §11.3 golden tests).
   */
  onObservedText?: (text: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rewriteAnthropicResponseModel(value: unknown, responseModelId: string): boolean {
  if (!isRecord(value)) return false;
  if (value['type'] === 'message' && typeof value['model'] === 'string') {
    value['model'] = responseModelId;
    return true;
  }
  const message = value['message'];
  if (value['type'] === 'message_start' && isRecord(message) && typeof message['model'] === 'string') {
    message['model'] = responseModelId;
    return true;
  }
  return false;
}

function rewriteAnthropicJsonPayload(payload: string, responseModelId: string): string {
  try {
    const value: unknown = JSON.parse(payload);
    return rewriteAnthropicResponseModel(value, responseModelId) ? JSON.stringify(value) : payload;
  } catch {
    return payload;
  }
}

function rewriteAnthropicSseLines(text: string, responseModelId: string): string {
  return text.replace(
    /^data:( ?)([^\r\n]*)(\r?\n|$)/gm,
    (_line, spacing: string, payload: string, ending: string) =>
      `data:${spacing}${rewriteAnthropicJsonPayload(payload, responseModelId)}${ending}`,
  );
}

function createAnthropicModelEchoTransform(
  responseModelId: string,
  onWrite: (chunk: Buffer) => void,
): Transform {
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      buffered += decoder.write(chunk);
      const completeEnd = buffered.lastIndexOf('\n');
      if (completeEnd >= 0) {
        const complete = buffered.slice(0, completeEnd + 1);
        buffered = buffered.slice(completeEnd + 1);
        const rewritten = Buffer.from(rewriteAnthropicSseLines(complete, responseModelId));
        this.push(rewritten);
        onWrite(rewritten);
      }
      callback();
    },
    flush(callback) {
      buffered += decoder.end();
      if (buffered) {
        const rewritten = Buffer.from(rewriteAnthropicSseLines(buffered, responseModelId));
        this.push(rewritten);
        onWrite(rewritten);
      }
      callback();
    },
  });
}

function updateEventBoundary(tail: string, chunk: Buffer): { tail: string; boundary: boolean } {
  const nextTail = (tail + chunk.toString('utf8')).slice(-4);
  return {
    tail: nextTail,
    boundary: nextTail.endsWith('\n\n') || nextTail.endsWith('\r\n\r\n'),
  };
}

export async function relayAnthropicMessages(
  res: ServerResponse,
  messagesUrl: string,
  body: Record<string, unknown>,
  apiKey: string,
  clientWantsStream: boolean,
  options: RelayAnthropicOptions = {},
): Promise<void> {
  const lifecycle = options.lifecycle;
  lifecycle?.startConnecting();
  const doFetch = (key: string) => fetch(messagesUrl, {
    method: 'POST',
    headers: anthropicUpstreamHeaders(
      key,
      clientWantsStream,
      options.inboundBeta,
      options.authType,
      options.claudeCodeSessionId,
      options.extraHeaders,
    ),
    body: JSON.stringify(body),
    signal: lifecycle?.abortSignal ?? options.signal,
  });

  let upstreamRes: Response;
  try {
    const retryResult = await fetchWithOAuthRetry(apiKey, doFetch, options.refreshToken);
    upstreamRes = retryResult.response;
    if (retryResult.refreshed) await options.onTokenRefreshed?.(retryResult.apiKey);
  } catch (err) {
    const unreachable = new UpstreamUnreachableError(err);
    lifecycle?.fail(unreachable);
    throw unreachable;
  }

  lifecycle?.markHeadersReceived();

  if (!upstreamRes.ok) {
    const errBody = await upstreamRes.text();
    options.log?.(`anthropic upstream ${upstreamRes.status}: ${errBody}`);
    options.onUpstreamError?.(upstreamRes.status, errBody);
    lifecycle?.fail(new Error(`Upstream returned HTTP ${upstreamRes.status}`));
    res.writeHead(upstreamRes.status, { 'Content-Type': upstreamRes.headers.get('content-type') || 'application/json' });
    res.end(errBody);
    return;
  }

  if (clientWantsStream && upstreamRes.body) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const upstream = Readable.fromWeb(upstreamRes.body as Parameters<typeof Readable.fromWeb>[0]);
    let outputTail = '';
    let atEventBoundary = true;
    const noteWrite = (chunk: Buffer) => {
      const state = updateEventBoundary(outputTail, chunk);
      outputTail = state.tail;
      atEventBoundary = state.boundary;
    };
    const heartbeat = createSseHeartbeat(
      () => res.write(': ping\n\n'),
      () => atEventBoundary && !res.writableEnded && !res.destroyed,
    );
    const clearHeartbeat = () => heartbeat.clear();
    options.signal?.addEventListener('abort', clearHeartbeat, { once: true });
    lifecycle?.abortSignal.addEventListener('abort', clearHeartbeat, { once: true });
    upstream.on('data', (chunk: Buffer) => {
      lifecycle?.markStreamActivity();
      if (chunk.length > 0) lifecycle?.markOutputEmitted();
      heartbeat.reset();
    });
    heartbeat.arm();
    if (options.onObservedText) {
      const observe = options.onObservedText;
      const decoder = new StringDecoder('utf8');
      // A second 'data' listener observes the same chunks the pipeline
      // consumes; it never reads from or mutates the stream, so the bytes
      // reaching `res` are unaffected.
      upstream.on('data', (chunk: Buffer) => observe(decoder.write(chunk)));
    }
    // `pipeline()` (rather than manual `.pipe()`) is what makes the terminal
    // outcome truthful: it resolves only once `res` has actually finished
    // writing, rejects on any failure anywhere in the chain (upstream error,
    // transform error, or the response socket going away), and — unlike
    // `.pipe()` — guarantees every stream in the chain is destroyed on
    // either path, so a torn-down connection can never leave the lifecycle
    // stuck non-terminal.
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        if (res.writableEnded || res.destroyed) {
          callback();
          return;
        }
        try {
          const accepted = res.write(chunk);
          if (accepted || !res.socket) {
            callback();
          } else {
            const done = () => {
              res.removeListener('drain', done);
              res.removeListener('close', done);
              callback();
            };
            res.once('drain', done);
            res.once('close', done);
          }
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });
    try {
      if (options.responseModelId) {
        await pipeline(
          upstream,
          createAnthropicModelEchoTransform(options.responseModelId, noteWrite),
          sink,
        );
      } else {
        await pipeline(upstream, createBoundaryTransform(noteWrite), sink);
      }
      res.end();
      lifecycle?.complete();
    } catch (err) {
      lifecycle?.fail(err);
      if (res.headersSent && !res.writableEnded && !res.destroyed) {
        res.write(`event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { type: anthropicErrorType(502), message: err instanceof Error ? err.message : String(err) },
        })}\n\n`);
        res.end();
      }
    } finally {
      heartbeat.clear();
      options.signal?.removeEventListener('abort', clearHeartbeat);
      lifecycle?.abortSignal.removeEventListener('abort', clearHeartbeat);
    }
    return;
  }

  if (!upstreamRes.body) {
    const err = new Error('Upstream returned empty response body');
    lifecycle?.fail(err);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Upstream returned empty response body' } }));
    return;
  }

  const text = await upstreamRes.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    lifecycle?.fail(err);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Upstream response was not valid JSON' } }));
    return;
  }
  const responseText = options.responseModelId && rewriteAnthropicResponseModel(parsed, options.responseModelId)
    ? JSON.stringify(parsed)
    : text;
  options.onObservedText?.(responseText);
  lifecycle?.markStreamActivity();
  if (responseText.length > 0) lifecycle?.markOutputEmitted();
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(responseText).toString(),
  });
  res.end(responseText);
  lifecycle?.complete();
}
