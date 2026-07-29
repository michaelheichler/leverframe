import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import type { RequestExecutionObserver } from './request-execution-context.js';
import { sanitizeCredential } from './server/auth.js';
import { CLAUDE_CODE_USER_AGENT } from './oauth/claude-identity.js';

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

function createAnthropicModelEchoTransform(responseModelId: string): Transform {
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      buffered += decoder.write(chunk);
      const completeEnd = buffered.lastIndexOf('\n');
      if (completeEnd >= 0) {
        const complete = buffered.slice(0, completeEnd + 1);
        buffered = buffered.slice(completeEnd + 1);
        this.push(rewriteAnthropicSseLines(complete, responseModelId));
      }
      callback();
    },
    flush(callback) {
      buffered += decoder.end();
      if (buffered) this.push(rewriteAnthropicSseLines(buffered, responseModelId));
      callback();
    },
  });
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
    // Every streamed chunk both resets the idle deadline and (once it
    // carries visible bytes) permanently closes the auto-replay barrier —
    // this listener runs whether or not a caller also observes the bytes
    // via `onObservedText`, so lifecycle ownership never depends on tracking
    // being wired up.
    upstream.on('data', (chunk: Buffer) => {
      lifecycle?.markStreamActivity();
      if (chunk.length > 0) lifecycle?.markOutputEmitted();
    });
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
    try {
      if (options.responseModelId) {
        // Invariant: emitted complete SSE lines echo responseModelId; buffered is only the incomplete final line.
        await pipeline(upstream, createAnthropicModelEchoTransform(options.responseModelId), res);
      } else {
        await pipeline(upstream, res);
      }
      lifecycle?.complete();
    } catch (err) {
      lifecycle?.fail(err);
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
