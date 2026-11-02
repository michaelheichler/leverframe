import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { expect } from 'vitest';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { ensureHttpProxyCertificates } from '../../src/http-proxy/ca.js';
import { startHttpProxy } from '../../src/http-proxy/server.js';

export type FirstPartyFixture = {
  inferenceLogPath: string;
  diagnosticsLogPath: string;
  caCert: string;
  origin: https.Server;
  proxy: Awaited<ReturnType<typeof startHttpProxy>>;
  received: { body: Buffer; auth?: string; path?: string; rawHeaders: string[] };
};

export function firstPartyBody(): Buffer {
  return Buffer.from(`{
  "model" : "claude-sonnet-4-6",
  "output_config":{"effort":"high"},
  "messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"private-image-data"}}]},{"type":"text","text":"identify this Sonnet request","cache_control":{"type":"ephemeral"}}]}],
  "stream":true
}
`);
}

function responseSse(): string {
  return [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":321,"output_tokens":1,"cache_creation":{"ephemeral_5m_input_tokens":12,"ephemeral_1h_input_tokens":3},"cache_read_input_tokens":210}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"private response text"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":8}}',
    '', '',
  ].join('\n');
}

function createOrigin(
  certificates: ReturnType<typeof ensureHttpProxyCertificates>,
  received: FirstPartyFixture['received'],
): https.Server {
  return https.createServer({ key: certificates.serverKey, cert: certificates.serverCert }, async (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    await once(req, 'end');
    received.body = Buffer.concat(chunks);
    received.auth = req.headers.authorization;
    received.path = req.url;
    received.rawHeaders = [...req.rawHeaders];
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip' });
    res.end(gzipSync(responseSse()));
  });
}

export async function startFirstPartyFixture(testHome: string): Promise<FirstPartyFixture> {
  const certificates = ensureHttpProxyCertificates();
  const inferenceLogPath = join(testHome, 'anthropic-inference.jsonl');
  const diagnosticsLogPath = join(testHome, 'websocket-diagnostics.jsonl');
  const received = { body: Buffer.alloc(0), auth: undefined as string | undefined,
    path: undefined as string | undefined, rawHeaders: [] as string[] };
  const origin = createOrigin(certificates, received);
  const originPort = await listen(origin);
  const proxy = await startHttpProxy({
    routes: [], inferenceLogPath, webSocketDiagnosticsLogPath: diagnosticsLogPath,
    anthropicOrigin: `https://127.0.0.1:${originPort}`, anthropicRejectUnauthorized: false,
  });
  return { inferenceLogPath, diagnosticsLogPath, caCert: certificates.caCert, origin, proxy, received };
}

export async function sendFirstPartyRequest(fixture: FirstPartyFixture, body: Buffer): Promise<string> {
  const secure = await connectMitm(fixture.proxy.port, fixture.caCert, fixture.proxy.token);
  let response = '';
  secure.on('data', chunk => { response += chunk.toString(); });
  secure.write([
    'POST /v1/messages?beta=true HTTP/1.1', 'Host: api.anthropic.com',
    'Authorization: Bearer subscription-oauth-token', 'x-api-key: native-api-key',
    'anthropic-version: 2023-06-01', 'anthropic-beta: prompt-caching-2024-07-31',
    'Anthropic-Beta: context-management-2025-06-27', 'Content-Type: application/json',
    `Content-Length: ${body.length}`, 'Connection: close', '', '',
  ].join('\r\n') + body.toString());
  await once(secure, 'close');
  return response;
}

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return address.port;
}

async function connectMitm(proxyPort: number, caCert: string, token: string): Promise<tls.TLSSocket> {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  const auth = `Proxy-Authorization: Basic ${Buffer.from(`leverframe:${token}`).toString('base64')}\r\n`;
  socket.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com\r\n${auth}\r\n`);
  let response = Buffer.alloc(0);
  while (!response.includes(Buffer.from('\r\n\r\n'))) {
    const [chunk] = await once(socket, 'data') as [Buffer];
    response = Buffer.concat([response, chunk]);
  }
  const boundary = response.indexOf('\r\n\r\n') + 4;
  if (response.subarray(boundary).length) socket.unshift(response.subarray(boundary));
  const secure = tls.connect({ socket, servername: 'api.anthropic.com', ca: caCert });
  await once(secure, 'secureConnect');
  return secure;
}

export async function readInferenceLog(path: string): Promise<{ raw: string; entries: any[] }> {
  const deadline = Date.now() + 5_000;
  let raw = readFileSync(path, 'utf8');
  let entries = raw.trim().split('\n').map(line => JSON.parse(line));
  while (!entries.some(entry => entry.event === 'response_completed') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
    raw = readFileSync(path, 'utf8');
    entries = raw.trim().split('\n').map(line => JSON.parse(line));
  }
  return { raw, entries };
}

export function assertForwardedRequest(fixture: FirstPartyFixture, body: Buffer): void {
  expect(fixture.received.path).toBe('/v1/messages?beta=true');
  expect(fixture.received.auth).toBe('Bearer subscription-oauth-token');
  expect(fixture.received.rawHeaders).toEqual(expect.arrayContaining([
    'Authorization', 'Bearer subscription-oauth-token', 'x-api-key', 'native-api-key',
    'anthropic-version', '2023-06-01', 'anthropic-beta', 'prompt-caching-2024-07-31',
    'Anthropic-Beta', 'context-management-2025-06-27',
  ]));
  expect(fixture.received.rawHeaders).not.toContain('Proxy-Authorization');
  expect(fixture.received.body.equals(body)).toBe(true);
}

export function assertUsageLog(entries: any[], raw: string): void {
  expect(entries[0]).toMatchObject({
    modelId: 'claude-sonnet-4-6', effort: 'high', provider: 'anthropic', route: 'passthrough',
    requestPreview: 'user: identify this Sonnet request',
  });
  const started = entries.find(entry => entry.event === 'response_started');
  const messageStart = entries.find(entry => entry.event === 'response_usage' && entry.usageStage === 'message_start');
  const messageDelta = entries.find(entry => entry.event === 'response_usage' && entry.usageStage === 'message_delta');
  const completed = entries.find(entry => entry.event === 'response_completed');
  expect(started).toMatchObject({ requestId: entries[0].requestId, statusCode: 200, route: 'passthrough' });
  expect(messageStart).toMatchObject({
    event: 'response_usage', requestId: entries[0].requestId, modelId: 'claude-sonnet-4-6',
    provider: 'anthropic', route: 'passthrough', usageStage: 'message_start', inputTokens: 321,
    outputTokens: 1, cacheCreationInputTokens: 15, cacheCreation5mInputTokens: 12,
    cacheCreation1hInputTokens: 3, cacheReadInputTokens: 210, totalInputTokens: 546,
  });
  expect(messageDelta).toMatchObject({
    event: 'response_usage', requestId: entries[0].requestId, modelId: 'claude-sonnet-4-6',
    provider: 'anthropic', route: 'passthrough', usageStage: 'message_delta', inputTokens: 321,
    outputTokens: 8, cacheCreationInputTokens: 15, cacheCreation5mInputTokens: 12,
    cacheCreation1hInputTokens: 3, cacheReadInputTokens: 210, totalInputTokens: 546,
  });
  expect(completed).toMatchObject({ requestId: entries[0].requestId, statusCode: 200, route: 'passthrough' });
  expect(raw).not.toContain('private-image-data');
  expect(raw).not.toContain('private response text');
}

export function assertDiagnostic(path: string, requestId: string): void {
  const raw = readFileSync(path, 'utf8');
  const diagnostic = JSON.parse(raw.trim());
  expect(diagnostic).toMatchObject({
    event: 'request_diagnostic', requestId,
    headers: { authorization: '[REDACTED]' },
    body: { parameters: { model: 'claude-sonnet-4-6', stream: true }, messages: { count: 1 } },
  });
  expect(raw).not.toContain('subscription-oauth-token');
  expect(raw).not.toContain('private-image-data');
  expect(raw).not.toContain('identify this Sonnet request');
}
