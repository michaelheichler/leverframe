import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { startHttpProxy } from '../src/http-proxy/server.js';

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

describe('selective HTTP proxy transport first-party', () => {
  it('forwards first-party request bytes and auth unchanged', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'anthropic-inference.jsonl');
    const webSocketDiagnosticsLogPath = join(testHome, 'websocket-diagnostics.jsonl');
    const previousRequestPreview = process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'];
    process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'] = '1';
    let receivedBody = Buffer.alloc(0);
    let receivedAuth: string | undefined;
    let receivedPath: string | undefined;
    let receivedRawHeaders: string[] = [];
    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, async (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      await once(req, 'end');
      receivedBody = Buffer.concat(chunks);
      receivedAuth = req.headers.authorization;
      receivedPath = req.url;
      receivedRawHeaders = [...req.rawHeaders];
      const sse = [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":321,"output_tokens":1,"cache_creation_input_tokens":12,"cache_read_input_tokens":210}}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"private response text"}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":19,"output_tokens":8,"cache_creation_input_tokens":100,"cache_read_input_tokens":220}}',
        '',
        '',
      ].join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Content-Encoding': 'gzip',
      });
      res.end(gzipSync(sse));
    });
    const originPort = await listen(origin);
    const proxy = await startHttpProxy({
      routes: [],
      inferenceLogPath,
      webSocketDiagnosticsLogPath,
      anthropicOrigin: `https://127.0.0.1:${originPort}`,
      anthropicRejectUnauthorized: false,
    });

    try {
      const body = Buffer.from('{\n  "model" : "claude-sonnet-4-6",\n  "output_config":{"effort":"high"},\n  "messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"private-image-data"}}]},{"type":"text","text":"identify this Sonnet request","cache_control":{"type":"ephemeral"}}]}],\n  "stream":true\n}\n');
      const secure = await connectMitm(proxy.port, certificates.caCert, proxy.token);
      let response = '';
      secure.on('data', chunk => { response += chunk.toString(); });
      secure.write([
        'POST /v1/messages?beta=true HTTP/1.1',
        'Host: api.anthropic.com',
        'Authorization: Bearer subscription-oauth-token',
        'x-api-key: native-api-key',
        'anthropic-version: 2023-06-01',
        'anthropic-beta: prompt-caching-2024-07-31',
        'Anthropic-Beta: context-management-2025-06-27',
        'Content-Type: application/json',
        `Content-Length: ${body.length}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body.toString());
      await once(secure, 'close');

      expect(response).toContain('200 OK');
      expect(receivedPath).toBe('/v1/messages?beta=true');
      expect(receivedAuth).toBe('Bearer subscription-oauth-token');
      expect(receivedRawHeaders).toEqual(expect.arrayContaining([
        'Authorization',
        'Bearer subscription-oauth-token',
        'x-api-key',
        'native-api-key',
        'anthropic-version',
        '2023-06-01',
        'anthropic-beta',
        'prompt-caching-2024-07-31',
        'Anthropic-Beta',
        'context-management-2025-06-27',
      ]));
      expect(receivedRawHeaders).not.toContain('Proxy-Authorization');
      expect(receivedBody.equals(body)).toBe(true);
      const logDeadline = Date.now() + 5000;
      let inferenceLog = readFileSync(inferenceLogPath, 'utf8');
      let entries = inferenceLog.trim().split('\n').map(line => JSON.parse(line));
      while (!entries.some(entry => entry.event === 'response_completed') && Date.now() < logDeadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
        inferenceLog = readFileSync(inferenceLogPath, 'utf8');
        entries = inferenceLog.trim().split('\n').map(line => JSON.parse(line));
      }
      expect(entries[0]).toMatchObject({
        modelId: 'claude-sonnet-4-6',
        effort: 'high',
        provider: 'anthropic',
        route: 'passthrough',
        requestPreview: 'user: identify this Sonnet request',
      });
      const responseStarted = entries.find(entry => entry.event === 'response_started');
      const messageStartUsage = entries.find(entry => entry.event === 'response_usage' && entry.usageStage === 'message_start');
      const messageDeltaUsage = entries.find(entry => entry.event === 'response_usage' && entry.usageStage === 'message_delta');
      const responseCompleted = entries.find(entry => entry.event === 'response_completed');
      expect(responseStarted).toMatchObject({
        requestId: entries[0].requestId,
        statusCode: 200,
        route: 'passthrough',
      });
      expect(messageStartUsage).toMatchObject({
        event: 'response_usage',
        requestId: entries[0].requestId,
        modelId: 'claude-sonnet-4-6',
        provider: 'anthropic',
        route: 'passthrough',
        usageStage: 'message_start',
        inputTokens: 321,
        outputTokens: 1,
        cacheCreationInputTokens: 12,
        cacheReadInputTokens: 210,
      });
      expect(messageDeltaUsage).toMatchObject({
        event: 'response_usage',
        requestId: entries[0].requestId,
        modelId: 'claude-sonnet-4-6',
        provider: 'anthropic',
        route: 'passthrough',
        usageStage: 'message_delta',
        inputTokens: 19,
        outputTokens: 8,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 220,
      });
      expect(responseCompleted).toMatchObject({
        requestId: entries[0].requestId,
        statusCode: 200,
        route: 'passthrough',
      });
      expect(inferenceLog).not.toContain('private-image-data');
      expect(inferenceLog).not.toContain('private response text');
      const diagnosticRaw = readFileSync(webSocketDiagnosticsLogPath, 'utf8');
      const diagnostic = JSON.parse(diagnosticRaw.trim());
      expect(diagnostic).toMatchObject({
        event: 'request_diagnostic',
        requestId: entries[0].requestId,
        headers: { authorization: '[REDACTED]' },
        body: {
          parameters: { model: 'claude-sonnet-4-6', stream: true },
          messages: { count: 1 },
        },
      });
      expect(diagnosticRaw).not.toContain('subscription-oauth-token');
      expect(diagnosticRaw).not.toContain('private-image-data');
      expect(diagnosticRaw).not.toContain('identify this Sonnet request');
    } finally {
      if (previousRequestPreview === undefined) delete process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'];
      else process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'] = previousRequestPreview;
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
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
      await Promise.race([
        upstreamClosed,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('upstream stream was not cancelled')), 1_000);
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
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
});
