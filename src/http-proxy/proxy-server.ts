import * as http from 'node:http';
import * as net from 'node:net';
import type { Duplex } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import type { ProxyRoute } from '../proxy.js';
import { handleContextSelectionRequest } from '../proxy-context-selection.js';
import { sendJson } from '../http-utils.js';
import { forwardPlainHttp } from './forward.js';

function authorityParts(authority: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(`http://${authority}`);
    return { host: parsed.hostname, port: Number(parsed.port || 443) };
  } catch { return null; }
}

export function shouldInterceptConnect(authority: string): boolean {
  const target = authorityParts(authority);
  return Boolean(target && target.port === 443 && target.host.replace(/\.$/, '').toLowerCase() === 'api.anthropic.com');
}

function authorized(headers: http.IncomingHttpHeaders, token: string): boolean {
  const raw = headers['proxy-authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return false;
  const match = /^\s*Basic\s+([A-Za-z0-9+/]+={0,2})\s*$/i.exec(value.replace(/\r?\n/g, ' ').trim());
  if (!match) return false;
  const encoded = match[1]!;
  if (!encoded.length || encoded.length % 4 !== 0 || Buffer.from(encoded, 'base64').toString('base64') !== encoded) return false;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const index = decoded.indexOf(':');
  if (index === -1) return false;
  const candidate = Buffer.from(decoded.slice(index + 1), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function authRequired(res: http.ServerResponse): void {
  const body = 'Proxy authentication required';
  res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="leverframe"', 'Content-Type': 'text/plain',
    'Content-Length': String(Buffer.byteLength(body)), Connection: 'close' });
  res.end(body);
}

function connectAuthRequired(socket: Duplex): void {
  const body = 'Proxy authentication required';
  socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n'
    + 'Proxy-Authenticate: Basic realm="leverframe"\r\n'
    + 'Content-Type: text/plain\r\n' + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + 'Connection: close\r\n\r\n' + body);
}

function openTunnel(target: { host: string; port: number }, client: Duplex, head: Buffer, sockets: Set<net.Socket>): void {
  const upstream = net.connect(target.port, target.host);
  let established = false;
  sockets.add(upstream);
  client.once('close', () => { if (!upstream.destroyed) upstream.destroy(); });
  upstream.once('close', () => {
    sockets.delete(upstream);
    if (established && !client.destroyed) client.destroy();
  });
  upstream.once('connect', () => {
    established = true;
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  upstream.once('error', () => {
    if (client.destroyed) return;
    if (established) { client.destroy(); return; }
    client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n', () => client.destroy());
  });
}

function handleConnect(req: http.IncomingMessage, client: Duplex, head: Buffer, token: string, mitm: http.Server, sockets: Set<net.Socket>): void {
  client.on('error', () => client.destroy());
  if (!authorized(req.headers, token)) { connectAuthRequired(client); return; }
  if (shouldInterceptConnect(req.url ?? '')) {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) client.unshift(head);
    mitm.emit('connection', client);
    return;
  }
  const target = authorityParts(req.url ?? '');
  if (!target) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  openTunnel(target, client, head, sockets);
}

async function handlePlain(req: http.IncomingMessage, res: http.ServerResponse, token: string, routes: Map<string, ProxyRoute>): Promise<void> {
  try {
    if (await handleContextSelectionRequest(req, res, { proxyToken: token, byAlias: routes })) return;
    if (!authorized(req.headers, token)) { authRequired(res); return; }
    forwardPlainHttp(req, res);
  } catch {
    if (res.headersSent || res.destroyed) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    sendJson(res, 500, { error: { type: 'internal_server_error', message: 'Proxy request failed.' } });
  }
}

export function createProxyServer(token: string, routes: Map<string, ProxyRoute>, mitm: http.Server, sockets: Set<net.Socket>): http.Server {
  const server = http.createServer((req, res) => { void handlePlain(req, res, token, routes); });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (req, socket, head) => handleConnect(req, socket, head, token, mitm, sockets));
  return server;
}
