import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { once } from 'node:events';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { startHttpProxy } from '../src/http-proxy/server.js';

const testHome = mkdtempSync(join(tmpdir(), 'leverframe-http-proxy-routing-'));
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

describe('selective HTTP proxy relay routing', () => {
  it('routes exact relay models and short aliases while stripping Anthropic auth from the adapter hop', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'relay-inference.jsonl');
    let adapterAuth: string | undefined;
    let adapterApiKey: string | undefined;
    let adapterClaudeSessionId: string | undefined;
    let adapterBody = '';
    let anthropicRequests = 0;
    let fallbackAuth: string | undefined;

    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, async (req, res) => {
      anthropicRequests += 1;
      fallbackAuth = req.headers.authorization;
      const ended = once(req, 'end');
      req.resume();
      await ended;
      res.setHeader('Connection', 'close');
      res.end('{"unexpected":true}');
    });
    const originPort = await listen(origin);

    const adapterServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      await once(req, 'end');
      adapterAuth = req.headers.authorization;
      adapterApiKey = req.headers['x-api-key'] as string | undefined;
      adapterClaudeSessionId = req.headers['x-claude-code-session-id'] as string | undefined;
      adapterBody = Buffer.concat(chunks).toString();
      await new Promise(resolve => setTimeout(resolve, 35));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
      res.end([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
        '',
      ].join('\n'));
    });
    const adapterPort = await listen(adapterServer);
    const proxy = await startHttpProxy({
      routes: [{
        aliasId: 'leverframe:groq:llama-3.3-70b',
        realModelId: 'llama-3.3-70b-versatile',
        displayName: 'Llama 3.3 70B (Groq)',
        upstreamUrl: '',
        apiKey: 'provider-key',
        modelFormat: 'openai',
        npm: '@ai-sdk/groq',
        providerId: 'groq',
      }],
      modelAliases: [{
        name: 'llama',
        routeId: 'leverframe:groq:llama-3.3-70b',
        displayName: 'Llama 3.3 70B (Groq)',
      }],
      adapterHandle: {
        port: adapterPort,
        token: 'adapter-local-token',
        close: () => {
          adapterServer.closeAllConnections();
          adapterServer.close();
        },
      },
      anthropicOrigin: `https://127.0.0.1:${originPort}`,
      anthropicRejectUnauthorized: false,
      inferenceLogPath,
      responseProgressIntervalMs: 10,
    });

    try {
      const body = JSON.stringify({
        model: 'leverframe:groq:llama-3.3-70b',
        output_config: { effort: 'medium' },
        messages: [],
        stream: true,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert, proxy.token);
      let response = '';
      secure.on('data', chunk => { response += chunk.toString(); });
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Authorization: Bearer subscription-oauth-token',
        'X-Claude-Code-Session-Id: 11111111-1111-4111-8111-111111111111',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body);
      await once(secure, 'close');

      expect(response).toContain('200 OK');
      expect(anthropicRequests).toBe(0);
      expect(adapterAuth).toBeUndefined();
      expect(adapterApiKey).toBe('adapter-local-token');
      expect(adapterClaudeSessionId).toBe('11111111-1111-4111-8111-111111111111');
      expect(adapterBody).toBe(body);
      const relayEntries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const requestEntry = relayEntries.find(entry => !entry.event);
      expect(requestEntry).toMatchObject({
        modelId: 'leverframe:groq:llama-3.3-70b',
        effort: 'medium',
        provider: 'groq',
        route: 'translated',
        stream: true,
      });
      expect(requestEntry.requestId).toEqual(expect.any(String));
      expect(relayEntries).toContainEqual(expect.objectContaining({
        event: 'response_progress',
        requestId: requestEntry.requestId,
        phase: 'waiting_for_headers',
        bytes: 0,
        chunks: 0,
      }));
      expect(relayEntries).toContainEqual(expect.objectContaining({
        event: 'response_started',
        requestId: requestEntry.requestId,
        statusCode: 200,
      }));
      expect(relayEntries).toContainEqual(expect.objectContaining({
        event: 'response_usage',
        requestId: requestEntry.requestId,
        modelId: 'leverframe:groq:llama-3.3-70b',
        provider: 'groq',
        route: 'translated',
        usageStage: 'message_start',
        inputTokens: 0,
        outputTokens: 0,
      }));
      expect(relayEntries).toContainEqual(expect.objectContaining({
        event: 'response_completed',
        requestId: requestEntry.requestId,
        statusCode: 200,
      }));

      const aliasBody = JSON.stringify({ model: 'llama', messages: [], stream: true });
      const aliasSocket = await connectMitm(proxy.port, certificates.caCert, proxy.token);
      aliasSocket.resume();
      aliasSocket.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Authorization: Bearer subscription-oauth-token',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(aliasBody)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + aliasBody);
      await once(aliasSocket, 'close');

      expect(anthropicRequests).toBe(0);
      expect(JSON.parse(adapterBody)).toMatchObject({
        model: 'llama',
        messages: [],
      });
      const aliasEntries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(aliasEntries.find(entry => !entry.event && entry.modelId === 'llama')).toMatchObject({
        provider: 'groq',
        route: 'translated',
      });

      const typoBody = JSON.stringify({ model: 'leverframe:groq:typo', messages: [] });
      const typoSocket = await connectMitm(proxy.port, certificates.caCert, proxy.token);
      let typoResponse = '';
      typoSocket.on('data', chunk => { typoResponse += chunk.toString(); });
      typoSocket.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Authorization: Bearer subscription-oauth-token',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(typoBody)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + typoBody);
      await once(typoSocket, 'close');
      expect(typoResponse).toContain('404 Not Found');
      expect(typoResponse).toContain('Unknown model: leverframe:groq:typo');
      expect(anthropicRequests).toBe(0);
      expect(fallbackAuth).toBeUndefined();
      const inferenceEntries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(inferenceEntries.find(entry => !entry.event && entry.modelId === 'leverframe:groq:typo')).toMatchObject({
        modelId: 'leverframe:groq:typo',
        provider: 'leverframe',
        route: 'passthrough',
      });
    } finally {
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  }, 20_000);

  it('routes count_tokens to the adapter without recording it as inference', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'count-tokens-inference.jsonl');
    let adapterPath: string | undefined;
    let anthropicRequests = 0;

    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, (req, res) => {
      anthropicRequests += 1;
      req.resume();
      res.end('{"unexpected":true}');
    });
    const originPort = await listen(origin);
    const adapterServer = http.createServer(async (req, res) => {
      adapterPath = req.url;
      const ended = once(req, 'end');
      req.resume();
      await ended;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end('{"input_tokens":42}');
    });
    const adapterPort = await listen(adapterServer);
    const route = {
      aliasId: 'leverframe:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai' as const,
      npm: '@ai-sdk/openai-compatible',
      providerId: 'test-provider',
    };
    const proxy = await startHttpProxy({
      routes: [route],
      adapterHandle: {
        port: adapterPort,
        token: 'adapter-local-token',
        close: () => {
          adapterServer.closeAllConnections();
          adapterServer.close();
        },
      },
      anthropicOrigin: `https://127.0.0.1:${originPort}`,
      anthropicRejectUnauthorized: false,
      inferenceLogPath,
    });

    try {
      const body = JSON.stringify({
        model: route.aliasId,
        messages: [{ role: 'user', content: 'count this' }],
      });
      const secure = await connectMitm(proxy.port, certificates.caCert, proxy.token);
      let response = '';
      secure.on('data', chunk => { response += chunk.toString(); });
      secure.write([
        'POST /v1/messages/count_tokens?beta=true HTTP/1.1',
        'Host: api.anthropic.com',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body);
      await once(secure, 'close');

      expect(response).toContain('200 OK');
      expect(response).toContain('{"input_tokens":42}');
      expect(adapterPath).toBe('/v1/messages/count_tokens?beta=true');
      expect(anthropicRequests).toBe(0);
      expect(existsSync(inferenceLogPath)).toBe(false);
    } finally {
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  }, 20_000);

  it('closes the adapter request and logs a terminal client disconnect', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'client-disconnect-inference.jsonl');
    let adapterReceivedResolve!: () => void;
    const adapterReceived = new Promise<void>(resolve => { adapterReceivedResolve = resolve; });
    let adapterClosedResolve!: () => void;
    const adapterClosed = new Promise<void>(resolve => { adapterClosedResolve = resolve; });
    const adapterServer = http.createServer((req) => {
      req.resume();
      req.once('end', adapterReceivedResolve);
      req.socket.once('close', adapterClosedResolve);
    });
    const adapterPort = await listen(adapterServer);
    const route = {
      aliasId: 'leverframe:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai' as const,
      npm: '@ai-sdk/openai-compatible',
      providerId: 'test-provider',
    };
    const proxy = await startHttpProxy({
      routes: [route],
      adapterHandle: {
        port: adapterPort,
        token: 'adapter-local-token',
        close: () => {
          adapterServer.closeAllConnections();
          adapterServer.close();
        },
      },
      inferenceLogPath,
    });

    try {
      const body = JSON.stringify({
        model: route.aliasId,
        messages: [{ role: 'user', content: 'wait forever' }],
        stream: false,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert, proxy.token);
      secure.on('error', () => {});
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        '',
        '',
      ].join('\r\n') + body);
      await adapterReceived;
      secure.destroy();
      await adapterClosed;
      await new Promise(resolve => setImmediate(resolve));

      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const requestEntry = entries.find(entry => !entry.event);
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_client_disconnected',
        requestId: requestEntry.requestId,
        phase: 'waiting_for_headers',
      }));
      expect(entries.some(entry => entry.event === 'response_completed')).toBe(false);
      expect(entries.some(entry => entry.event === 'response_failed')).toBe(false);
    } finally {
      await proxy.close();
    }
  }, 20_000);
});
