import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { once } from 'node:events';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { startHttpProxy } from '../src/http-proxy/server.js';
import {
  assertDiagnostic,
  assertForwardedRequest,
  assertUsageLog,
  firstPartyBody,
  readInferenceLog,
  sendFirstPartyRequest,
  startFirstPartyFixture,
} from './fixtures/http-proxy-first-party.js';

const testHome = mkdtempSync(join(tmpdir(), 'leverframe-http-proxy-server-'));
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

  it('forwards first-party request bytes and auth unchanged', async () => {
    const previousRequestPreview = process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'];
    process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'] = '1';
    const fixture = await startFirstPartyFixture(testHome);
    const body = firstPartyBody();

    try {
      const response = await sendFirstPartyRequest(fixture, body);
      expect(response).toContain('200 OK');
      assertForwardedRequest(fixture, body);
      const { raw, entries } = await readInferenceLog(fixture.inferenceLogPath);
      assertUsageLog(entries, raw);
      assertDiagnostic(fixture.diagnosticsLogPath, entries[0].requestId);
    } finally {
      if (previousRequestPreview === undefined) delete process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'];
      else process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'] = previousRequestPreview;
      await fixture.proxy.close();
      await new Promise<void>(resolve => fixture.origin.close(() => resolve()));
    }
  }, 20_000);

  it('cancels a first-party upstream stream when the client disconnects', async () => {
    const certificates = ensureHttpProxyCertificates();
    let resolveUpstreamClosed: (() => void) | undefined;
    const upstreamClosed = new Promise<void>(resolve => {
      resolveUpstreamClosed = resolve;
    });
    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, async (req, res) => {
      req.resume();
      await once(req, 'end');
      req.socket.once('close', () => resolveUpstreamClosed?.());
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    });
    const originPort = await listen(origin);
    const proxy = await startHttpProxy({
      routes: [],
      anthropicOrigin: `https://127.0.0.1:${originPort}`,
      anthropicRejectUnauthorized: false,
    });

    try {
      const body = Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'cancel this stream' }],
        stream: true,
      }));
      const secure = await connectMitm(proxy.port, certificates.caCert, proxy.token);
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Authorization: Bearer subscription-oauth-token',
        'Content-Type: application/json',
        `Content-Length: ${body.length}`,
        'Connection: keep-alive',
        '',
        '',
      ].join('\r\n') + body.toString());
      await once(secure, 'data');
      secure.destroy();

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const closed = await Promise.race([
        upstreamClosed,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('upstream stream was not cancelled')), 1_000);
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      expect(closed).toBeUndefined();
    } finally {
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  });

  it('logs Haiku passthrough status, error body, and system fallback preview', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'haiku-error-inference.jsonl');
    const previousRequestPreview = process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'];
    process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'] = '1';
    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, async (req, res) => {
      const ended = once(req, 'end');
      req.resume();
      await ended;
      res.writeHead(529, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Haiku overloaded for Bearer sk-secret123456789' },
      }));
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
        system: [{ type: 'text', text: 'Generate a concise title for this Claude Code session.' }],
        messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'private tool output' }] }],
        stream: true,
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

      expect(response).toContain('529');
      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(entries[0]).toMatchObject({
        modelId: 'claude-haiku-4-5',
        provider: 'anthropic',
        route: 'passthrough',
        requestPreview: 'user: [tool_result] | system: Generate a concise title for this Claude Code session.',
      });
      const upstreamError = entries.find(entry => entry.event === 'upstream_error');
      expect(upstreamError).toMatchObject({
        event: 'upstream_error',
        modelId: 'claude-haiku-4-5',
        provider: 'anthropic',
        route: 'passthrough',
        statusCode: 529,
      });
      expect(upstreamError.errorContent).toContain('Haiku overloaded');
      expect(upstreamError.errorContent).toContain('[REDACTED]');
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_completed',
        requestId: entries[0].requestId,
        statusCode: 529,
      }));
      expect(readFileSync(inferenceLogPath, 'utf8')).not.toContain('private tool output');
    } finally {
      if (previousRequestPreview === undefined) delete process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'];
      else process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'] = previousRequestPreview;
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  }, 20_000);
