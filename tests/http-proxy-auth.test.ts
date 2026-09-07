import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { once } from 'node:events';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { startHttpProxy } from '../src/http-proxy/server.js';
import { HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY } from '../src/env.js';

const testHome = mkdtempSync(join(tmpdir(), 'leverframe-http-proxy-auth-'));
const previousRelayHome = process.env['LEVERFRAME_HOME'];

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return address.port;
}

async function connectMitm(proxyPort: number, ca: string, proxyToken?: string): Promise<tls.TLSSocket> {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  const authHeader = proxyToken
    ? `Proxy-Authorization: Basic ${Buffer.from(`leverframe:${proxyToken}`).toString('base64')}\r\n`
    : '';
  socket.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n${authHeader}\r\n`);

  let response = Buffer.alloc(0);
  while (!response.includes(Buffer.from('\r\n\r\n'))) {
    const [chunk] = await once(socket, 'data') as [Buffer];
    response = Buffer.concat([response, chunk]);
  }
  const boundary = response.indexOf('\r\n\r\n') + 4;
  expect(response.subarray(0, boundary).toString()).toContain('200 Connection Established');
  const remainder = response.subarray(boundary);
  if (remainder.length > 0) socket.unshift(remainder);

  const secure = tls.connect({ socket, servername: 'api.anthropic.com', ca });
  await once(secure, 'secureConnect');
  return secure;
}

beforeAll(() => {
  process.env['LEVERFRAME_HOME'] = testHome;
});

afterAll(() => {
  if (previousRelayHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousRelayHome;
  rmSync(testHome, { recursive: true, force: true });
});

describe('selective HTTP proxy auth', () => {
  it('returns 407 on CONNECT without Proxy-Authorization', async () => {
    const proxy = await startHttpProxy({ routes: [] });
    try {
      const socket = net.connect(proxy.port, '127.0.0.1');
      await once(socket, 'connect');
      socket.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n');
      const response = await new Promise<string>(resolve => {
        let buf = '';
        socket.on('data', chunk => { buf += chunk.toString(); });
        socket.once('close', () => resolve(buf));
      });
      socket.destroy();
      expect(response.startsWith('HTTP/1.1 407')).toBe(true);
      expect(response).toMatch(/Proxy-Authenticate: Basic realm="leverframe"/);
    } finally {
      await proxy.close();
    }
  });

  it('returns 407 on CONNECT with a wrong Proxy-Authorization password', async () => {
    const proxy = await startHttpProxy({ routes: [] });
    try {
      const socket = net.connect(proxy.port, '127.0.0.1');
      await once(socket, 'connect');
      const wrong = Buffer.from('leverframe:wrong-token').toString('base64');
      socket.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nProxy-Authorization: Basic ' + wrong + '\r\n\r\n');
      const response = await new Promise<string>(resolve => {
        let buf = '';
        socket.on('data', chunk => { buf += chunk.toString(); });
        socket.once('close', () => resolve(buf));
      });
      socket.destroy();
      expect(response.startsWith('HTTP/1.1 407')).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it('accepts a CONNECT with the correct Proxy-Authorization password', async () => {
    const proxy = await startHttpProxy({ routes: [] });
    try {
      const socket = net.connect(proxy.port, '127.0.0.1');
      await once(socket, 'connect');
      const correct = Buffer.from('leverframe:' + proxy.token).toString('base64');
      socket.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nProxy-Authorization: Basic ' + correct + '\r\n\r\n');
      const response = await new Promise<string>(resolve => {
        let buf = '';
        socket.on('data', chunk => { buf += chunk.toString(); });
        socket.once('close', () => resolve(buf));
        setTimeout(() => { socket.destroy(); }, 50);
      });
      expect(response.startsWith('HTTP/1.1 200 Connection Established')).toBe(true);
      socket.destroy();
    } finally {
      await proxy.close();
    }
  });

  it('returns 407 on plain HTTP without Proxy-Authorization', async () => {
    const proxy = await startHttpProxy({ routes: [] });
    try {
      const socket = net.connect(proxy.port, '127.0.0.1');
      await once(socket, 'connect');
      socket.write('GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n');
      const response = await new Promise<string>(resolve => {
        let buf = '';
        socket.on('data', chunk => { buf += chunk.toString(); });
        socket.once('close', () => resolve(buf));
      });
      socket.destroy();
      expect(response.startsWith('HTTP/1.1 407')).toBe(true);
      expect(response).toMatch(/Proxy-Authenticate: Basic realm="leverframe"/);
      const expectedBody = 'Proxy authentication required';
      const expectedLength = String(Buffer.byteLength(expectedBody));
      expect(response).toMatch(new RegExp(`Content-Length: ${expectedLength}\\r\\n`));
      expect(response.endsWith('\r\n\r\n' + expectedBody)).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it('returns a fresh random token on the handle when no override is provided', async () => {
    const a = await startHttpProxy({ routes: [] });
    const b = await startHttpProxy({ routes: [] });
    try {
      expect(a.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(b.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(a.token).not.toBe(b.token);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('honors an explicit proxyAuthToken override', async () => {
    const proxy = await startHttpProxy({ routes: [], proxyAuthToken: 'fixed-test-token' });
    try {
      expect(proxy.token).toBe('fixed-test-token');
    } finally {
      await proxy.close();
    }
  });

  it('remaps Anthropic weekly-limit 429 to non-retryable 400 for Claude --print', async () => {
    const certificates = ensureHttpProxyCertificates();
    let sawRetryAfter = false;
    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, async (req, res) => {
      const ended = once(req, 'end');
      req.resume();
      await ended;
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '60',
        'Connection': 'close',
      });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'You have hit your weekly limit' },
      }));
      sawRetryAfter = true;
    });
    const originPort = await listen(origin);
    const proxy = await startHttpProxy({
      routes: [],
      anthropicOrigin: `https://127.0.0.1:${originPort}`,
      anthropicRejectUnauthorized: false,
    });
    try {
      const body = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'Reply with exactly one word: OK' }],
        max_tokens: 16,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert, proxy.token);
      let response = '';
      secure.on('data', chunk => { response += chunk.toString(); });
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Authorization: Bearer subscription-oauth-token',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body);
      await once(secure, 'close');
      expect(sawRetryAfter).toBe(true);
      expect(response).toMatch(/^HTTP\/1\.1 400 /m);
      expect(response).toContain('weekly limit');
      expect(response.toLowerCase()).not.toContain('retry-after');
    } finally {
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  }, 20_000);

  it('keeps transient Anthropic rate-limit 429 unchanged', async () => {
    const certificates = ensureHttpProxyCertificates();
    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, async (req, res) => {
      const ended = once(req, 'end');
      req.resume();
      await ended;
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '12',
        'Connection': 'close',
      });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'rate limit exceeded' },
      }));
    });
    const originPort = await listen(origin);
    const proxy = await startHttpProxy({
      routes: [],
      anthropicOrigin: `https://127.0.0.1:${originPort}`,
      anthropicRejectUnauthorized: false,
    });
    try {
      const body = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 8,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert, proxy.token);
      let response = '';
      secure.on('data', chunk => { response += chunk.toString(); });
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Authorization: Bearer subscription-oauth-token',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body);
      await once(secure, 'close');
      expect(response).toMatch(/^HTTP\/1\.1 429 /m);
      expect(response.toLowerCase()).toContain('retry-after');
      expect(response).toContain('rate limit exceeded');
    } finally {
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  }, 20_000);

  it('substitutes Claude OAuth for placeholder keys and never forwards the placeholder', async () => {
    const certificates = ensureHttpProxyCertificates();
    const seenAuth: string[] = [];
    const seenApiKeys: string[] = [];
    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, async (req, res) => {
      const auth = req.headers['authorization'];
      const apiKey = req.headers['x-api-key'];
      if (typeof auth === 'string') seenAuth.push(auth);
      if (typeof apiKey === 'string') seenApiKeys.push(apiKey);
      const ended = once(req, 'end');
      req.resume();
      await ended;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'OK' }],
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
    const originPort = await listen(origin);
    const proxy = await startHttpProxy({
      routes: [],
      anthropicOrigin: `https://127.0.0.1:${originPort}`,
      anthropicRejectUnauthorized: false,
      resolveClaudeCodeAuth: async () => ({ kind: 'oauth', token: 'claude-oauth-from-store' }),
    });
    try {
      const body = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'Reply with exactly one word: OK' }],
        max_tokens: 16,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert, proxy.token);
      let response = '';
      secure.on('data', chunk => { response += chunk.toString(); });
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        `Authorization: Bearer ${HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY}`,
        `x-api-key: ${HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body);
      await once(secure, 'close');
      expect(response).toMatch(/^HTTP\/1\.1 200 /m);
      expect(response).toContain('"OK"');
      expect(seenAuth).toEqual(['Bearer claude-oauth-from-store']);
      expect(seenApiKeys).toEqual([]);
      expect(seenAuth.join('\n')).not.toContain(HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY);
    } finally {
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  }, 20_000);
});
