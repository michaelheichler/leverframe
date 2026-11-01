import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import type { ProxyHandle } from '../proxy.js';
import { copyResponse as copyHttpProxyResponse } from './copy-response.js';
import { observeResponseUsage, type ResponseUsage } from './response-usage.js';
import { ForwardLifecycle, type ForwardLog } from './forward-lifecycle.js';

export function requestHeadersWithoutProxyHeaders(req: http.IncomingMessage): string[] {
  const headers: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    if (/^proxy-(authorization|connection)$/i.test(name)) continue;
    headers.push(name, req.rawHeaders[i + 1] ?? '');
  }
  return headers;
}

function copyResponse(upstream: http.IncomingMessage, res: http.ServerResponse, options: {
  onErrorResponse?: (statusCode: number, body: string) => void;
  onResponseUsage?: (usage: ResponseUsage) => void;
  onResponseUsageComplete?: () => void;
} = {}): void {
  copyHttpProxyResponse(upstream, res, {
    ...options,
    observeSuccessSseUsage: (message, encoding, hooks) => observeResponseUsage(message, encoding, hooks),
  });
}

function observeResponse(upstream: http.IncomingMessage, res: http.ServerResponse, state: ForwardLifecycle, options: {
  onErrorResponse?: (statusCode: number, body: string) => void;
  onResponseUsage?: (usage: ResponseUsage) => void;
  log?: ForwardLog;
}): void {
  state.headers(upstream.statusCode ?? 502);
  upstream.on('data', (chunk: Buffer) => state.data(chunk));
  copyResponse(upstream, res, {
    onErrorResponse: options.onErrorResponse,
    onResponseUsage: options.onResponseUsage,
    onResponseUsageComplete: options.log ? () => state.usageComplete() : undefined,
  });
}

export function forwardRawAnthropicRequest(
  req: http.IncomingMessage, res: http.ServerResponse, rawBody: Buffer, origin: URL,
  rejectUnauthorized: boolean, onErrorResponse?: (statusCode: number, body: string) => void,
  onResponseUsage?: (usage: ResponseUsage) => void, log?: ForwardLog, upstreamHeaders?: string[],
): Promise<void> {
  return new Promise(resolve => {
    const state = new ForwardLifecycle(log, 'passthrough');
    const upstream = https.request({
      protocol: 'https:', hostname: origin.hostname, port: origin.port || 443,
      method: req.method, path: req.url, headers: upstreamHeaders ?? requestHeadersWithoutProxyHeaders(req),
      servername: net.isIP(origin.hostname) ? undefined : origin.hostname, rejectUnauthorized,
    }, response => {
      observeResponse(response, res, state, { onErrorResponse, onResponseUsage, log });
      response.once('end', () => { state.end(); resolve(); });
      response.once('error', err => {
        if (!state.disconnected && !state.failed) state.fail((err as NodeJS.ErrnoException).code ?? err.name);
        resolve();
      });
    });
    res.once('finish', () => state.finish());
    res.once('close', () => {
      if (!state.disconnect(res)) return;
      upstream.destroy(new Error('Client disconnected'));
      resolve();
    });
    upstream.once('error', err => {
      if (state.disconnected) { resolve(); return; }
      state.fail((err as NodeJS.ErrnoException).code ?? err.name, true);
      onErrorResponse?.(502, `Anthropic upstream unreachable: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Anthropic upstream unreachable: ${err.message}`);
      resolve();
    });
    upstream.end(rawBody);
  });
}

function observeAdapterResponse(response: http.IncomingMessage, res: http.ServerResponse, state: ForwardLifecycle, log: ForwardLog | undefined, done: () => void): void {
  observeResponse(response, res, state, { log, onResponseUsage: log ? usage => state.usage(usage) : undefined });
  const fail = (err: Error) => {
    if (state.disconnected) { done(); return; }
    if (state.ended || state.failed) return;
    state.fail(err.name);
    if (!res.writableEnded) res.destroy(err);
    done();
  };
  response.once('end', () => { state.end(); done(); });
  response.once('error', fail);
  response.once('aborted', () => fail(new Error('Relay adapter response aborted')));
  response.once('close', () => {
    if (!response.complete) fail(new Error('Relay adapter response closed before completion'));
  });
}

export function forwardToAdapter(
  req: http.IncomingMessage, res: http.ServerResponse, rawBody: Buffer, adapter: ProxyHandle,
  adapterRequest: typeof http.request, adapterAgent: http.Agent, log?: ForwardLog,
): Promise<void> {
  return new Promise(resolve => {
    const state = new ForwardLifecycle(log, 'translated');
    let response: http.IncomingMessage | undefined;
    let upstream: http.ClientRequest | undefined;
    res.once('finish', () => state.finish());
    res.once('close', () => {
      if (!state.disconnect(res)) return;
      response?.destroy(new Error('Client disconnected'));
      upstream?.destroy(new Error('Client disconnected'));
      resolve();
    });
    const fail = (err: Error) => {
      if (state.disconnected) { resolve(); return; }
      if (state.headersReceived || state.failed) return;
      state.fail(err.name, true);
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Relay adapter unreachable: ${err.message}`);
      resolve();
    };
    upstream = adapterRequest({
      hostname: '127.0.0.1', port: adapter.port, method: 'POST', path: req.url, agent: adapterAgent,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': String(rawBody.length), 'x-api-key': adapter.token,
        ...(typeof req.headers['anthropic-beta'] === 'string' ? { 'anthropic-beta': req.headers['anthropic-beta'] } : {}),
        ...(typeof req.headers['x-claude-code-session-id'] === 'string' ? { 'x-claude-code-session-id': req.headers['x-claude-code-session-id'] } : {}),
        ...(log ? { 'x-relay-request-id': log.requestId } : {}),
      },
    }, upstreamRes => {
      response = upstreamRes;
      observeAdapterResponse(upstreamRes, res, state, log, resolve);
    });
    upstream.once('error', fail);
    upstream.once('close', () => {
      if (!state.headersReceived && !state.failed) fail(new Error('Relay adapter connection closed before a response'));
    });
    upstream.end(rawBody);
  });
}

export function forwardPlainHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
  let target: URL;
  try { target = new URL(req.url ?? ''); } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('HTTP proxy requests must use an absolute URL');
    return;
  }
  const transport = target.protocol === 'https:' ? https : http;
  const upstream = transport.request({
    protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
    method: req.method, path: `${target.pathname}${target.search}`, headers: requestHeadersWithoutProxyHeaders(req),
  }, upstreamRes => copyResponse(upstreamRes, res));
  upstream.on('error', err => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Proxy upstream unreachable: ${err.message}`);
  });
  req.pipe(upstream);
}
