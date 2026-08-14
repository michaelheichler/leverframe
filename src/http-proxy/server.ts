import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { ProxyHandle, ProxyRoute } from '../proxy.js';
import { startProxyCatalog } from '../proxy.js';
import { ensureHttpProxyCertificates } from './ca.js';
import { routeLookupIds } from '../context-model-id.js';
import type { ResolvedHttpProxyAlias } from './routes.js';
import { listenTcpServer } from '../listener-ready.js';
import { decideHttpProxyRoute } from './routing-decision.js';
import {
  writeInferenceResponseLifecycleLog,
  writeInferenceResponseErrorLog,
  type InferenceResponsePhase,
} from '../trace-log.js';
import { HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY } from '../env.js';
import {
  readClaudeCodeAuthMaterial,
  type ClaudeCodeCredentialReader,
} from '../claude-code-credentials.js';
import { rewriteUpstreamAuthHeaders } from './claude-passthrough-auth.js';
import { copyResponse as copyHttpProxyResponse } from './copy-response.js';

const ANTHROPIC_HOST = 'api.anthropic.com';

function headerValue(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/** Why: placeholder auth must not reach Anthropic (Claude retries 401 for minutes). */
function requestUsesHttpProxyPlaceholderKey(headers: http.IncomingHttpHeaders): boolean {
  const apiKey = headerValue(headers, 'x-api-key')?.trim();
  if (apiKey === HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY) return true;
  const authorization = headerValue(headers, 'authorization');
  if (!authorization) return false;
  const match = /^Bearer\s+(\S+)/i.exec(authorization.trim());
  return match?.[1] === HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY;
}

const MAX_BODY_BYTES = 50 * 1024 * 1024;
const MAX_USAGE_SSE_BLOCK_BYTES = 64 * 1024;

type ResponseUsage = {
  usageStage: 'message_start' | 'message_delta';
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
};

function numericUsage(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function responseUsageFromSseBlock(block: string): ResponseUsage | undefined {
  const lines = block.split('\n');
  const event = lines.find(line => line.startsWith('event:'))?.slice('event:'.length).trim();
  const data = lines
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trimStart())
    .join('\n');
  if (!data) return undefined;

  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const type = parsed.type;
    if (type !== 'message_start' && type !== 'message_delta') return undefined;
    if (event && event !== type) return undefined;
    const message = type === 'message_start'
      ? parsed.message as Record<string, unknown> | undefined
      : undefined;
    const usage = (type === 'message_start' ? message?.usage : parsed.usage) as Record<string, unknown> | undefined;
    if (!usage) return undefined;
    return {
      usageStage: type,
      inputTokens: numericUsage(usage.input_tokens),
      outputTokens: numericUsage(usage.output_tokens),
      cacheCreationInputTokens: numericUsage(usage.cache_creation_input_tokens),
      cacheReadInputTokens: numericUsage(usage.cache_read_input_tokens),
    };
  } catch {
    return undefined;
  }
}

type ResponseUsageCapture = {
  capture: (chunk: Buffer) => void;
  flush: () => void;
};

function createResponseUsageCapture(
  onUsage: (usage: ResponseUsage) => void,
): ResponseUsageCapture {
  let buffered = '';
  const processBuffer = (flush: boolean) => {
    let boundary: number;
    while ((boundary = buffered.indexOf('\n\n')) >= 0) {
      const block = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      if (Buffer.byteLength(block) > MAX_USAGE_SSE_BLOCK_BYTES) continue;
      const usage = responseUsageFromSseBlock(block);
      if (usage) onUsage(usage);
    }
    if (flush && buffered.length > 0) {
      const block = buffered;
      buffered = '';
      if (Buffer.byteLength(block) <= MAX_USAGE_SSE_BLOCK_BYTES) {
        const usage = responseUsageFromSseBlock(block);
        if (usage) onUsage(usage);
      }
    }
    if (Buffer.byteLength(buffered) > MAX_USAGE_SSE_BLOCK_BYTES) buffered = '';
  };

  return {
    capture: chunk => {
      buffered = (buffered + chunk.toString('utf8')).replace(/\r\n/g, '\n');
      processBuffer(false);
    },
    flush: () => processBuffer(true),
  };
}

function observeResponseUsage(
  upstream: http.IncomingMessage,
  contentEncoding: string | string[] | undefined,
  callbacks: { onUsage: (usage: ResponseUsage) => void; onComplete: () => void },
): void {
  const encoding = (Array.isArray(contentEncoding) ? contentEncoding[0] : contentEncoding)
    ?.trim()
    .toLowerCase();
  if (!encoding || encoding === 'identity') {
    const capture = createResponseUsageCapture(callbacks.onUsage);
    upstream.on('data', capture.capture);
    upstream.once('end', () => {
      capture.flush();
      upstream.off('data', capture.capture);
      callbacks.onComplete();
    });
    return;
  }

  const decoder = encoding === 'gzip'
    ? createGunzip()
    : encoding === 'br'
      ? createBrotliDecompress()
      : encoding === 'deflate'
        ? createInflate()
        : undefined;
  if (!decoder) {
    callbacks.onComplete();
    return;
  }

  const onCompressedData = (chunk: Buffer) => {
    if (!decoder.destroyed) decoder.write(chunk);
  };
  const onCompressedEnd = () => {
    if (!decoder.destroyed) decoder.end();
  };
  const cleanup = () => {
    upstream.off('data', onCompressedData);
    upstream.off('end', onCompressedEnd);
    decoder.destroy();
  };
  const capture = createResponseUsageCapture(callbacks.onUsage);
  decoder.on('data', capture.capture);
  decoder.once('error', () => {
    cleanup();
    callbacks.onComplete();
  });
  decoder.once('end', () => {
    capture.flush();
    cleanup();
    callbacks.onComplete();
  });
  upstream.on('data', onCompressedData);
  upstream.once('end', onCompressedEnd);
}

export interface HttpProxyOptions {
  host?: string;
  port?: number;
  routes: ProxyRoute[];
  /** Short incoming model names mapped to canonical adapter route ids. */
  modelAliases?: ResolvedHttpProxyAlias[];
  debug?: boolean;
  /** Per-process translated-adapter debug log used when debug is enabled. */
  debugLogPath?: string;
  /** Append privacy-minimal inference routing records as JSONL. */
  inferenceLogPath?: string;
  /** Opt-in request-envelope and WebSocket head-decision diagnostics. */
  webSocketDiagnosticsLogPath?: string;
  /** Test hook. Production always uses https://api.anthropic.com. */
  anthropicOrigin?: string;
  /** Test hook for a local self-signed Anthropic origin. */
  anthropicRejectUnauthorized?: boolean;
  /** Test hook for observing relay-route isolation without calling an AI provider. */
  adapterHandle?: ProxyHandle;
  /** Test hook for verifying adapter connection-pool ownership. */
  adapterRequest?: typeof http.request;
  /** Test hook. Production emits a progress record every 30 seconds. */
  responseProgressIntervalMs?: number;
  /**
   * Per-start Proxy-Authorization password the listener requires on every
   * plain-HTTP request and CONNECT tunnel. When omitted a fresh random
   * token is generated and returned on HttpProxyHandle.token.
   */
  proxyAuthToken?: string;
  /** Why: tests inject Claude auth without touching the real keychain. */
  resolveClaudeCodeAuth?: ClaudeCodeCredentialReader;
}

export interface HttpProxyHandle {
  host: string;
  port: number;
  caCertPath: string;
  /** Per-start Proxy-Authorization password clients must present. */
  token: string;
  modelIds: string[];
  inferenceLogPath?: string;
  webSocketDiagnosticsLogPath?: string;
  close: () => Promise<void>;
}

function authorityParts(authority: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(`http://${authority}`);
    return { host: parsed.hostname, port: Number(parsed.port || 443) };
  } catch {
    return null;
  }
}

export function shouldInterceptConnect(authority: string): boolean {
  const target = authorityParts(authority);
  return Boolean(target && target.port === 443 && target.host.replace(/\.$/, '').toLowerCase() === ANTHROPIC_HOST);
}

/** WWW-Authenticate header value returned on 407 Proxy Authentication Required. */
const PROXY_AUTHENTICATE_HEADER = 'Basic realm="leverframe"';

/** Constant-time string compare to avoid leaking token bytes via timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function extractProxyPassword(headers: http.IncomingHttpHeaders): string | null {
  const raw = headers['proxy-authorization'];
  if (!raw) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\r?\n/g, ' ').trim();
  const match = /^\s*Basic\s+([A-Za-z0-9+/]+={0,2})\s*$/i.exec(normalized);
  if (!match) return null;
  const b64 = match[1]!;
  if (!isCanonicalBase64(b64)) return null;
  const decoded = Buffer.from(b64, 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx === -1) return null;
  return decoded.slice(idx + 1);
}

/** Strict canonical Base64 (RFC 4648 §4): alphabet, padding, round-trip. */
function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  const padStart = value.indexOf('=');
  if (padStart !== -1) {
    if (padStart < value.length - 2) return false;
    for (let i = padStart + 1; i < value.length; i += 1) {
      if (value[i] !== '=') return false;
    }
    if (padStart % 4 === 0) return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

/** Send a 407 over a raw CONNECT socket. */
function sendConnectProxyAuthRequired(socket: { end: (data: string) => void }): void {
  const body = 'Proxy authentication required';
  socket.end(
    'HTTP/1.1 407 Proxy Authentication Required\r\n'
    + `Proxy-Authenticate: ${PROXY_AUTHENTICATE_HEADER}\r\n`
    + 'Content-Type: text/plain\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + 'Connection: close\r\n'
    + '\r\n'
    + body,
  );
}

/** Send a 407 over a plain-HTTP ServerResponse. */
function respondProxyAuthRequired(res: http.ServerResponse): void {
  const body = 'Proxy authentication required';
  res.writeHead(407, {
    'Proxy-Authenticate': PROXY_AUTHENTICATE_HEADER,
    'Content-Type': 'text/plain',
    'Content-Length': String(Buffer.byteLength(body)),
    'Connection': 'close',
  });
  res.end(body);
}

function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function copyResponse(
  upstream: http.IncomingMessage,
  res: http.ServerResponse,
  options: {
    onErrorResponse?: (statusCode: number, body: string) => void;
    onResponseUsage?: (usage: ResponseUsage) => void;
    onResponseUsageComplete?: () => void;
  } = {},
): void {
  copyHttpProxyResponse(upstream, res, {
    onErrorResponse: options.onErrorResponse,
    onResponseUsage: options.onResponseUsage,
    onResponseUsageComplete: options.onResponseUsageComplete,
    observeSuccessSseUsage: (message, contentEncoding, hooks) => {
      observeResponseUsage(message, contentEncoding, hooks);
    },
  });
}

function requestHeadersWithoutProxyHeaders(req: http.IncomingMessage): string[] {
  const headers: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    if (/^proxy-(authorization|connection)$/i.test(name)) continue;
    headers.push(name, req.rawHeaders[i + 1] ?? '');
  }
  return headers;
}

function forwardRawAnthropicRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawBody: Buffer,
  origin: URL,
  rejectUnauthorized: boolean,
  onErrorResponse?: (statusCode: number, body: string) => void,
  onResponseUsage?: (usage: ResponseUsage) => void,
  lifecycle?: {
    logPath: string;
    requestId: string;
    modelId: string;
    provider: string;
    progressIntervalMs: number;
  },
  upstreamHeaders?: string[],
): Promise<void> {
  return new Promise(resolve => {
    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    let headersReceived = false;
    let firstByteAt: number | undefined;
    let statusCode: number | undefined;
    let bytes = 0;
    let chunks = 0;
    let settled = false;
    let responseEnded = false;
    let failed = false;
    let clientDisconnected = false;
    let resolveResponseUsageComplete: (() => void) | undefined;
    const responseUsageComplete = lifecycle
      ? new Promise<void>(resolve => { resolveResponseUsageComplete = resolve; })
      : undefined;
    const writeLifecycle = (
      event: Parameters<typeof writeInferenceResponseLifecycleLog>[1]['event'],
      extra: Partial<Parameters<typeof writeInferenceResponseLifecycleLog>[1]> = {},
    ) => {
      if (!lifecycle) return;
      writeInferenceResponseLifecycleLog(lifecycle.logPath, {
        event,
        requestId: lifecycle.requestId,
        modelId: lifecycle.modelId,
        provider: lifecycle.provider,
        route: 'passthrough',
        ...extra,
      });
    };
    const responsePhase = (): InferenceResponsePhase => {
      if (!headersReceived) return 'waiting_for_headers';
      if (firstByteAt === undefined) return 'waiting_for_first_byte';
      return responseEnded ? 'delivering' : 'streaming';
    };
    const progressTimer = lifecycle
      ? setInterval(() => {
          const now = Date.now();
          writeLifecycle('response_progress', {
            statusCode,
            phase: responsePhase(),
            durationMs: now - startedAt,
            ...(firstByteAt !== undefined ? { timeToFirstByteMs: firstByteAt - startedAt } : {}),
            idleMs: now - lastActivityAt,
            bytes,
            chunks,
          });
        }, lifecycle.progressIntervalMs)
      : undefined;
    progressTimer?.unref();
    const stopProgress = () => {
      if (progressTimer) clearInterval(progressTimer);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const errorType = (err: Error): string => (err as NodeJS.ErrnoException).code ?? err.name;
    const upstream = https.request({
      protocol: 'https:',
      hostname: origin.hostname,
      port: origin.port || 443,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders ?? requestHeadersWithoutProxyHeaders(req),
      servername: net.isIP(origin.hostname) ? undefined : origin.hostname,
      rejectUnauthorized,
    }, upstreamRes => {
      headersReceived = true;
      statusCode = upstreamRes.statusCode ?? 502;
      lastActivityAt = Date.now();
      upstreamRes.on('data', (chunk: Buffer) => {
        const now = Date.now();
        if (firstByteAt === undefined) {
          firstByteAt = now;
          writeLifecycle('response_started', {
            statusCode,
            durationMs: now - startedAt,
            timeToFirstByteMs: now - startedAt,
          });
        }
        lastActivityAt = now;
        bytes += chunk.length;
        chunks += 1;
      });
      copyResponse(upstreamRes, res, {
        onErrorResponse,
        onResponseUsage,
        onResponseUsageComplete: lifecycle ? () => resolveResponseUsageComplete?.() : undefined,
      });
      upstreamRes.once('end', () => {
        responseEnded = true;
        lastActivityAt = Date.now();
        done();
      });
      upstreamRes.once('error', err => {
        if (clientDisconnected || failed) {
          done();
          return;
        }
        failed = true;
        stopProgress();
        const now = Date.now();
        writeLifecycle('response_failed', {
          statusCode,
          phase: responsePhase(),
          durationMs: now - startedAt,
          ...(firstByteAt !== undefined ? { timeToFirstByteMs: firstByteAt - startedAt } : {}),
          idleMs: now - lastActivityAt,
          bytes,
          chunks,
          errorType: errorType(err),
        });
        done();
      });
    });
    res.once('finish', () => {
      stopProgress();
      if (failed || clientDisconnected) return;
      const writeCompleted = () => {
        if (failed || clientDisconnected) return;
        const now = Date.now();
        writeLifecycle('response_completed', {
          statusCode,
          durationMs: now - startedAt,
          ...(firstByteAt !== undefined ? { timeToFirstByteMs: firstByteAt - startedAt } : {}),
          bytes,
          chunks,
        });
      };
      if (responseUsageComplete) void responseUsageComplete.then(writeCompleted);
      else writeCompleted();
    });
    res.once('close', () => {
      stopProgress();
      if (res.writableFinished || failed) return;
      clientDisconnected = true;
      const now = Date.now();
      writeLifecycle('response_client_disconnected', {
        statusCode,
        phase: responsePhase(),
        durationMs: now - startedAt,
        ...(firstByteAt !== undefined ? { timeToFirstByteMs: firstByteAt - startedAt } : {}),
        idleMs: now - lastActivityAt,
        bytes,
        chunks,
      });
      upstream.destroy(new Error('Client disconnected'));
      done();
    });
    upstream.once('error', err => {
      if (clientDisconnected) {
        done();
        return;
      }
      failed = true;
      stopProgress();
      const now = Date.now();
      writeLifecycle('response_failed', {
        statusCode: 502,
        phase: responsePhase(),
        durationMs: now - startedAt,
        idleMs: now - lastActivityAt,
        bytes,
        chunks,
        errorType: errorType(err),
      });
      onErrorResponse?.(502, `Anthropic upstream unreachable: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Anthropic upstream unreachable: ${err.message}`);
      done();
    });
    upstream.end(rawBody);
  });
}

function forwardToAdapter(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawBody: Buffer,
  adapter: ProxyHandle,
  adapterRequest: typeof http.request,
  adapterAgent: http.Agent,
  lifecycle?: {
    logPath: string;
    requestId: string;
    modelId: string;
    provider: string;
    progressIntervalMs: number;
  },
): Promise<void> {
  return new Promise(resolve => {
    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    let headersReceived = false;
    let firstByteAt: number | undefined;
    let statusCode: number | undefined;
    let bytes = 0;
    let chunks = 0;
    let adapterEnded = false;
    let failed = false;
    let clientDisconnected = false;
    let adapterResponse: http.IncomingMessage | undefined;
    let upstream: http.ClientRequest | undefined;
    let resolveResponseUsageComplete: (() => void) | undefined;
    const responseUsageComplete = lifecycle
      ? new Promise<void>(resolve => { resolveResponseUsageComplete = resolve; })
      : undefined;

    const writeLifecycle = (
      event: Parameters<typeof writeInferenceResponseLifecycleLog>[1]['event'],
      extra: Partial<Parameters<typeof writeInferenceResponseLifecycleLog>[1]> = {},
    ) => {
      if (!lifecycle) return;
      writeInferenceResponseLifecycleLog(lifecycle.logPath, {
        event,
        requestId: lifecycle.requestId,
        modelId: lifecycle.modelId,
        provider: lifecycle.provider,
        route: 'translated',
        ...extra,
      });
    };
    const responsePhase = (): InferenceResponsePhase => {
      if (!headersReceived) return 'waiting_for_headers';
      if (firstByteAt === undefined) return 'waiting_for_first_byte';
      return adapterEnded ? 'delivering' : 'streaming';
    };
    const progressTimer = lifecycle
      ? setInterval(() => {
          const now = Date.now();
          writeLifecycle('response_progress', {
            statusCode,
            phase: responsePhase(),
            durationMs: now - startedAt,
            ...(firstByteAt !== undefined ? { timeToFirstByteMs: firstByteAt - startedAt } : {}),
            idleMs: now - lastActivityAt,
            bytes,
            chunks,
          });
        }, lifecycle.progressIntervalMs)
      : undefined;
    progressTimer?.unref();
    const stopProgress = () => {
      if (progressTimer) clearInterval(progressTimer);
    };

    res.once('finish', () => {
      stopProgress();
      if (failed || clientDisconnected) return;
      const writeCompleted = () => {
        if (failed || clientDisconnected) return;
        const now = Date.now();
        writeLifecycle('response_completed', {
          statusCode,
          durationMs: now - startedAt,
          ...(firstByteAt !== undefined ? { timeToFirstByteMs: firstByteAt - startedAt } : {}),
          bytes,
          chunks,
        });
      };
      if (responseUsageComplete) void responseUsageComplete.then(writeCompleted);
      else writeCompleted();
    });
    res.once('close', () => {
      stopProgress();
      if (res.writableFinished || failed) return;
      clientDisconnected = true;
      const now = Date.now();
      writeLifecycle('response_client_disconnected', {
        statusCode,
        phase: responsePhase(),
        durationMs: now - startedAt,
        ...(firstByteAt !== undefined ? { timeToFirstByteMs: firstByteAt - startedAt } : {}),
        idleMs: now - lastActivityAt,
        bytes,
        chunks,
      });
      adapterResponse?.destroy(new Error('Client disconnected'));
      upstream?.destroy(new Error('Client disconnected'));
      resolve();
    });

    const failAdapterRequest = (err: Error) => {
      if (clientDisconnected) {
        resolve();
        return;
      }
      if (headersReceived || failed) return;
      failed = true;
      stopProgress();
      const now = Date.now();
      writeLifecycle('response_failed', {
        statusCode: 502,
        phase: responsePhase(),
        durationMs: now - startedAt,
        idleMs: now - lastActivityAt,
        bytes,
        chunks,
        errorType: err.name,
      });
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Relay adapter unreachable: ${err.message}`);
      resolve();
    };

    upstream = adapterRequest({
      hostname: '127.0.0.1',
      port: adapter.port,
      method: 'POST',
      path: req.url,
      agent: adapterAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(rawBody.length),
        'x-api-key': adapter.token,
        ...(typeof req.headers['x-claude-code-session-id'] === 'string'
          ? { 'x-claude-code-session-id': req.headers['x-claude-code-session-id'] }
          : {}),
        ...(lifecycle ? { 'x-relay-request-id': lifecycle.requestId } : {}),
      },
    }, upstreamRes => {
      adapterResponse = upstreamRes;
      headersReceived = true;
      statusCode = upstreamRes.statusCode ?? 502;
      lastActivityAt = Date.now();
      upstreamRes.on('data', (chunk: Buffer) => {
        const now = Date.now();
        if (firstByteAt === undefined) {
          firstByteAt = now;
          writeLifecycle('response_started', {
            statusCode,
            durationMs: now - startedAt,
            timeToFirstByteMs: now - startedAt,
          });
        }
        lastActivityAt = now;
        bytes += chunk.length;
        chunks += 1;
      });
      copyResponse(upstreamRes, res, {
        onResponseUsage: lifecycle ? usage => writeLifecycle('response_usage', usage) : undefined,
        onResponseUsageComplete: lifecycle ? () => resolveResponseUsageComplete?.() : undefined,
      });
      const failAdapterResponse = (err: Error) => {
        if (clientDisconnected) {
          resolve();
          return;
        }
        if (adapterEnded || failed) return;
        failed = true;
        stopProgress();
        const now = Date.now();
        writeLifecycle('response_failed', {
          statusCode,
          phase: responsePhase(),
          durationMs: now - startedAt,
          ...(firstByteAt !== undefined ? { timeToFirstByteMs: firstByteAt - startedAt } : {}),
          idleMs: now - lastActivityAt,
          bytes,
          chunks,
          errorType: err.name,
        });
        if (!res.writableEnded) res.destroy(err);
        resolve();
      };
      upstreamRes.once('end', () => {
        adapterEnded = true;
        lastActivityAt = Date.now();
        resolve();
      });
      upstreamRes.once('error', failAdapterResponse);
      upstreamRes.once('aborted', () => failAdapterResponse(new Error('Relay adapter response aborted')));
      upstreamRes.once('close', () => {
        if (!upstreamRes.complete) failAdapterResponse(new Error('Relay adapter response closed before completion'));
      });
    });
    upstream.once('error', failAdapterRequest);
    upstream.once('close', () => {
      if (!headersReceived && !failed) {
        failAdapterRequest(new Error('Relay adapter connection closed before a response'));
      }
    });
    upstream.end(rawBody);
  });
}

function forwardPlainHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
  let target: URL;
  try {
    target = new URL(req.url ?? '');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('HTTP proxy requests must use an absolute URL');
    return;
  }
  const transport = target.protocol === 'https:' ? https : http;
  const upstream = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    method: req.method,
    path: `${target.pathname}${target.search}`,
    headers: requestHeadersWithoutProxyHeaders(req),
  }, upstreamRes => copyResponse(upstreamRes, res));
  upstream.on('error', err => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Proxy upstream unreachable: ${err.message}`);
  });
  req.pipe(upstream);
}

/**
 * Positive allowlist of relay routes, keyed by every id a client may send.
 *
 * Precedence (highest first, later passes never override earlier keys):
 *   1. Canonical route aliasId (and its routeLookupIds variants).
 *   2. Saved model-alias names, resolved against the routeId they name.
 *   3. Bare realModelId. Claude Code's Agent tool spawns child sessions that send the
 *      bare upstream model id (e.g. "gpt-5.6-luna") instead of the canonical alias id;
 *      without this fallback those requests miss the route map, routing fails closed to
 *      Anthropic passthrough, and Anthropic 404s the unknown model.
 *
 * Mirrors the precedence contract documented on createGatewayModelCatalog in
 * src/server/models.ts.
 */
export function buildProxyRoutesById(
  routes: ProxyRoute[],
  modelAliases?: ResolvedHttpProxyAlias[],
): Map<string, ProxyRoute> {
  const routesById = new Map<string, ProxyRoute>();
  for (const route of routes) {
    for (const id of routeLookupIds(route.aliasId)) routesById.set(id, route);
  }
  for (const alias of modelAliases ?? []) {
    const route = routesById.get(alias.routeId);
    if (!route) continue;
    for (const id of routeLookupIds(alias.name)) routesById.set(id, route);
  }
  for (const route of routes) {
    for (const id of routeLookupIds(route.realModelId)) {
      if (!routesById.has(id)) routesById.set(id, route);
    }
  }
  return routesById;
}

export async function startHttpProxy(options: HttpProxyOptions): Promise<HttpProxyHandle> {
  const certificates = ensureHttpProxyCertificates();
  const proxyAuthToken = options.proxyAuthToken ?? randomBytes(32).toString('base64url');
  const routesById = buildProxyRoutesById(options.routes, options.modelAliases);
  const anthropicOrigin = new URL(options.anthropicOrigin ?? 'https://api.anthropic.com');
  let adapter: ProxyHandle | null = options.adapterHandle ?? null;
  if (options.routes.length > 0) {
    adapter ??= await startProxyCatalog(
      options.routes,
      options.routes[0]!.aliasId,
      options.debug,
      options.inferenceLogPath,
      options.debugLogPath,
      options.webSocketDiagnosticsLogPath,
      options.modelAliases,
    );
  }
  const adapterAgent = new http.Agent({ keepAlive: true });

  const mitmServer = https.createServer({
    key: certificates.serverKey,
    cert: certificates.serverCert,
    minVersion: 'TLSv1.2',
  }, async (req, res) => {
    let rawBody: Buffer;
    try {
      rawBody = await readRawBody(req);
    } catch (err) {
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end(err instanceof Error ? err.message : String(err));
      return;
    }

    const decision = decideHttpProxyRoute({
      method: req.method,
      url: req.url,
      headers: req.headers,
      rawBody,
      routesById,
      hasAdapter: adapter !== null,
      inferenceLogPath: options.inferenceLogPath,
      webSocketDiagnosticsLogPath: options.webSocketDiagnosticsLogPath,
      responseProgressIntervalMs: options.responseProgressIntervalMs,
    });

    switch (decision.action) {
      case 'translated': {
        if (!adapter) {
          // decideHttpProxyRoute only returns 'translated' when hasAdapter was true.
          throw new Error('HTTP proxy route decision selected an adapter that is no longer running');
        }
        // Adapter resolves aliases itself and must echo the request model id.
        await forwardToAdapter(
          req,
          res,
          rawBody,
          adapter,
          options.adapterRequest ?? http.request,
          adapterAgent,
          decision.lifecycle,
        );
        return;
      }
      case 'passthrough-messages': {
        const lifecycle = decision.lifecycle;
        let upstreamHeaders: string[] | undefined;
        if (requestUsesHttpProxyPlaceholderKey(req.headers)) {
          const resolveAuth = options.resolveClaudeCodeAuth ?? readClaudeCodeAuthMaterial;
          const auth = await resolveAuth();
          if (!auth) {
            const message =
              'Claude --bare placeholder cannot call Anthropic and no Claude Code '
              + 'OAuth/API credential was found. Run `claude /login` or set ANTHROPIC_API_KEY.';
            const errorBody = JSON.stringify({
              type: 'error',
              error: { type: 'invalid_request_error', message },
            });
            if (lifecycle) {
              writeInferenceResponseErrorLog(lifecycle.logPath, {
                requestId: decision.requestId,
                modelId: decision.modelId,
                provider: 'anthropic',
                route: 'passthrough',
                statusCode: 400,
                errorContent: errorBody,
              });
            }
            res.writeHead(400, {
              'Content-Type': 'application/json',
              'Content-Length': String(Buffer.byteLength(errorBody)),
            });
            res.end(errorBody);
            return;
          }
          upstreamHeaders = rewriteUpstreamAuthHeaders(
            requestHeadersWithoutProxyHeaders(req),
            auth,
          );
        }
        await forwardRawAnthropicRequest(
          req,
          res,
          rawBody,
          anthropicOrigin,
          options.anthropicRejectUnauthorized ?? true,
          lifecycle
            ? (statusCode, errorContent) => writeInferenceResponseErrorLog(lifecycle.logPath, {
                requestId: decision.requestId,
                modelId: decision.modelId,
                provider: 'anthropic',
                route: 'passthrough',
                statusCode,
                errorContent,
              })
            : undefined,
          lifecycle
            ? usage => writeInferenceResponseLifecycleLog(lifecycle.logPath, {
                event: 'response_usage',
                requestId: decision.requestId,
                modelId: decision.modelId,
                provider: 'anthropic',
                route: 'passthrough',
                ...usage,
              })
            : undefined,
          lifecycle,
          upstreamHeaders,
        );
        return;
      }
      case 'raw':
        await forwardRawAnthropicRequest(
          req,
          res,
          rawBody,
          anthropicOrigin,
          options.anthropicRejectUnauthorized ?? true,
        );
        return;
      default: {
        const exhaustive: never = decision;
        throw new Error(`Unhandled HTTP proxy route decision: ${JSON.stringify(exhaustive)}`);
      }
    }
  });

  const sockets = new Set<Socket>();
  const proxyServer = http.createServer((req, res) => {
    const presented = extractProxyPassword(req.headers);
    if (!presented || !constantTimeEquals(presented, proxyAuthToken)) {
      respondProxyAuthRequired(res);
      return;
    }
    forwardPlainHttp(req, res);
  });

  const closeAdapter = async (): Promise<void> => {
    if (!adapter) return;
    await adapter.close();
    adapter = null;
  };
  proxyServer.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  proxyServer.on('connect', (req, clientSocket, head) => {
    // Client RSTs are routine. Unlistened, they crash the whole process.
    clientSocket.on('error', () => clientSocket.destroy());
    const presented = extractProxyPassword(req.headers);
    if (!presented || !constantTimeEquals(presented, proxyAuthToken)) {
      sendConnectProxyAuthRequired(clientSocket);
      return;
    }
    if (shouldInterceptConnect(req.url ?? '')) {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) clientSocket.unshift(head);
      mitmServer.emit('connection', clientSocket);
      return;
    }

    const target = authorityParts(req.url ?? '');
    if (!target) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const upstream = net.connect(target.port, target.host);
    let tunnelEstablished = false;
    sockets.add(upstream);
    clientSocket.once('close', () => {
      if (!upstream.destroyed) upstream.destroy();
    });
    upstream.once('close', () => {
      sockets.delete(upstream);
      if (tunnelEstablished && !clientSocket.destroyed) clientSocket.destroy();
    });
    upstream.once('connect', () => {
      tunnelEstablished = true;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.once('error', () => {
      if (clientSocket.destroyed) return;
      if (tunnelEstablished) {
        clientSocket.destroy();
        return;
      }
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n', () => clientSocket.destroy());
    });
  });

  let address: AddressInfo;
  try {
    address = await listenTcpServer(
      proxyServer,
      options.port ?? 0,
      options.host ?? '127.0.0.1',
    );
  } catch (err) {
    // Bind/readiness failed: no listener or private adapter resource may survive.
    adapterAgent.destroy();
    if (mitmServer.listening) {
      await new Promise<void>(resolve => mitmServer.close(() => resolve()));
    }
    await closeAdapter();
    throw err;
  }

  return {
    host: options.host ?? '127.0.0.1',
    port: address.port,
    caCertPath: certificates.caCertPath,
    token: proxyAuthToken,
    modelIds: [
      ...(options.modelAliases ?? []).map(alias => alias.name),
      ...options.routes.map(route => route.aliasId),
    ],
    inferenceLogPath: options.inferenceLogPath,
    webSocketDiagnosticsLogPath: options.webSocketDiagnosticsLogPath,
    close: async () => {
      adapterAgent.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => proxyServer.close(() => resolve()));
      await new Promise<void>(resolve => mitmServer.close(() => resolve()));
      await closeAdapter();
    },
  };
}
