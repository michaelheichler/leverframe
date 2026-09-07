import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { once } from 'node:events';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { startHttpProxy } from '../src/http-proxy/server.js';

const testHome = mkdtempSync(join(tmpdir(), 'leverframe-http-proxy-errors-'));
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

describe('selective HTTP proxy first-party error handling', () => {
  it('logs a partial upstream error body when the origin resets before end', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'partial-error-inference.jsonl');
    const previousRequestPreview = process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'];
    process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'] = '1';
    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, async (req, res) => {
      const ended = once(req, 'end');
      req.resume();
      await ended;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      res.write('{"error":{"message":"partial outage');
      setImmediate(() => res.destroy(new Error('origin reset')));
    });
    const originPort = await listen(origin);
    const proxy = await startHttpProxy({
      routes: [],
      inferenceLogPath,
      anthropicOrigin: `https://127.0.0.1:${originPort}`,
      anthropicRejectUnauthorized: false,
    });

    try {
      const body = JSON.stringify({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'test partial error logging' }],
        stream: true,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert, proxy.token);
      secure.resume();
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body);
      await new Promise<void>(resolve => {
        secure.once('close', () => resolve());
        secure.once('error', () => resolve());
      });

      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const upstreamError = entries.find(entry => entry.event === 'upstream_error');
      expect(upstreamError).toMatchObject({
        event: 'upstream_error',
        modelId: 'claude-haiku-4-5',
        statusCode: 503,
      });
      expect(upstreamError.errorContent).toContain('partial outage');
      expect(upstreamError.errorContent).toContain('stream error');
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_failed',
        requestId: entries[0].requestId,
        statusCode: 503,
      }));
    } finally {
      if (previousRequestPreview === undefined) delete process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'];
      else process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'] = previousRequestPreview;
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  }, 20_000);

  it('logs an Anthropic connection refusal as an upstream response failure', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'connection-refused-inference.jsonl');
    const unavailableOrigin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    });
    const unavailablePort = await listen(unavailableOrigin);
    await new Promise<void>(resolve => unavailableOrigin.close(() => resolve()));
    const proxy = await startHttpProxy({
      routes: [],
      inferenceLogPath,
      anthropicOrigin: `https://127.0.0.1:${unavailablePort}`,
      anthropicRejectUnauthorized: false,
    });

    try {
      const body = JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'test refused origin' }],
        stream: true,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert, proxy.token);
      let response = '';
      secure.on('data', chunk => { response += chunk.toString(); });
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body);
      await once(secure, 'close');

      expect(response).toContain('502');
      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const requestEntry = entries.find(entry => !entry.event);
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_failed',
        requestId: requestEntry.requestId,
        route: 'passthrough',
        statusCode: 502,
        phase: 'waiting_for_headers',
        errorType: 'ECONNREFUSED',
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'upstream_error',
        requestId: requestEntry.requestId,
        statusCode: 502,
      }));
    } finally {
      await proxy.close();
    }
  }, 20_000);
});
