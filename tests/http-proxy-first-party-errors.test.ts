import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { once } from 'node:events';
import { brotliCompressSync } from 'node:zlib';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { startHttpProxy } from '../src/http-proxy/server.js';

const testHome = mkdtempSync(join(tmpdir(), 'leverframe-http-proxy-errors-'));
const previousRelayHome = process.env['LEVERFRAME_HOME'];

type InferenceLogEntry = Record<string, unknown>;

interface FixedResponse {
  statusCode: number;
  headers: http.OutgoingHttpHeaders;
  body: Buffer;
}

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return address.port;
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function startOrigin(handler?: http.RequestListener): Promise<{ server: https.Server; port: number }> {
  const certificates = ensureHttpProxyCertificates();
  const server = https.createServer({ key: certificates.serverKey, cert: certificates.serverCert }, handler);
  return { server, port: await listen(server) };
}

function respondAfterRequestBody(response: FixedResponse): http.RequestListener {
  return (req, res) => {
    req.resume();
    req.once('end', () => {
      res.writeHead(response.statusCode, { ...response.headers, 'Content-Length': response.body.length });
      res.end(response.body);
    });
  };
}

const resetAfterPartialErrorBody: http.RequestListener = async (req, res) => {
  const ended = once(req, 'end');
  req.resume();
  await ended;
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.flushHeaders();
  res.write('{"error":{"message":"partial outage');
  setImmediate(() => res.destroy(new Error('origin reset')));
};

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

function readInferenceLog(path: string): InferenceLogEntry[] {
  return readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as InferenceLogEntry);
}

async function exchangeThroughProxy<T>(
  originPort: number,
  logFileName: string,
  act: (secure: tls.TLSSocket) => Promise<T>,
): Promise<{ result: T; entries: InferenceLogEntry[] }> {
  const certificates = ensureHttpProxyCertificates();
  const inferenceLogPath = join(testHome, logFileName);
  const proxy = await startHttpProxy({
    routes: [],
    inferenceLogPath,
    anthropicOrigin: `https://127.0.0.1:${originPort}`,
    anthropicRejectUnauthorized: false,
  });
  try {
    const result = await act(await connectMitm(proxy.port, certificates.caCert, proxy.token));
    return { result, entries: readInferenceLog(inferenceLogPath) };
  } finally {
    await proxy.close();
  }
}

function writeRawMessagesRequest(secure: tls.TLSSocket, payload: unknown): void {
  const body = JSON.stringify(payload);
  secure.write([
    'POST /v1/messages HTTP/1.1',
    'Host: api.anthropic.com',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n') + body);
}

async function postMessagesThroughMitm(secure: tls.TLSSocket, payload: unknown): Promise<Buffer> {
  const body = JSON.stringify(payload);
  const request = http.request({
    createConnection: () => secure,
    method: 'POST',
    path: '/v1/messages',
    headers: {
      Host: 'api.anthropic.com',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Connection: 'close',
    },
  });
  request.end(body);
  const [response] = await once(request, 'response') as [http.IncomingMessage];
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function socketFinished(secure: tls.TLSSocket): Promise<void> {
  await new Promise<void>(resolve => {
    secure.once('close', () => resolve());
    secure.once('error', () => resolve());
  });
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

async function runPartialErrorExchange(): Promise<InferenceLogEntry[]> {
  const previousRequestPreview = process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'];
  process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'] = '1';
  const origin = await startOrigin(resetAfterPartialErrorBody);
  try {
    const { entries } = await exchangeThroughProxy(origin.port, 'partial-error-inference.jsonl', async secure => {
      secure.resume();
      writeRawMessagesRequest(secure, {
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'test partial error logging' }],
        stream: true,
      });
      await socketFinished(secure);
    });
    return entries;
  } finally {
    restoreEnv('LEVERFRAME_LOG_REQUEST_PREVIEW', previousRequestPreview);
    await closeServer(origin.server);
  }
}

async function runRefusedOriginExchange(): Promise<{ result: string; entries: InferenceLogEntry[] }> {
  const unavailableOrigin = await startOrigin();
  await closeServer(unavailableOrigin.server);
  return exchangeThroughProxy(unavailableOrigin.port, 'connection-refused-inference.jsonl', async secure => {
    let response = '';
    secure.on('data', chunk => { response += chunk.toString(); });
    writeRawMessagesRequest(secure, {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'test refused origin' }],
      stream: true,
    });
    await once(secure, 'close');
    return response;
  });
}

async function runCompressedErrorExchange(
  originResponse: FixedResponse,
): Promise<{ result: Buffer; entries: InferenceLogEntry[] }> {
  const origin = await startOrigin(respondAfterRequestBody(originResponse));
  try {
    return await exchangeThroughProxy(origin.port, 'compressed-error-inference.jsonl', secure =>
      postMessagesThroughMitm(secure, {
        model: 'claude-test-missing',
        messages: [{ role: 'user', content: 'test compressed error logging' }],
      }));
  } finally {
    await closeServer(origin.server);
  }
}

beforeAll(() => {
  process.env['LEVERFRAME_HOME'] = testHome;
});

afterAll(() => {
  restoreEnv('LEVERFRAME_HOME', previousRelayHome);
  rmSync(testHome, { recursive: true, force: true });
});

describe('selective HTTP proxy first-party error handling', () => {
  it('logs a partial upstream error body when the origin resets before end', async () => {
    const entries = await runPartialErrorExchange();

    const upstreamError = entries.find(entry => entry.event === 'upstream_error');
    expect(upstreamError).toMatchObject({
      event: 'upstream_error',
      modelId: 'claude-haiku-4-5',
      statusCode: 503,
    });
    expect(upstreamError?.errorContent).toContain('partial outage');
    expect(upstreamError?.errorContent).toContain('stream error');
    expect(entries).toContainEqual(expect.objectContaining({
      event: 'response_failed',
      requestId: entries[0]?.requestId,
      statusCode: 503,
    }));
  }, 20_000);

  it('logs an Anthropic connection refusal as an upstream response failure', async () => {
    const { result: response, entries } = await runRefusedOriginExchange();

    expect(response).toContain('502');
    const requestEntry = entries.find(entry => !entry.event);
    expect(entries).toContainEqual(expect.objectContaining({
      event: 'response_failed',
      requestId: requestEntry?.requestId,
      route: 'passthrough',
      statusCode: 502,
      phase: 'waiting_for_headers',
      errorType: 'ECONNREFUSED',
    }));
    expect(entries).toContainEqual(expect.objectContaining({
      event: 'upstream_error',
      requestId: requestEntry?.requestId,
      statusCode: 502,
    }));
  }, 20_000);
});

describe('selective HTTP proxy compressed first-party errors', () => {
  it('logs a brotli upstream error as decoded text and forwards the original compressed bytes', async () => {
    const compressedBody = brotliCompressSync(
      '{"type":"error","error":{"type":"not_found_error","message":"model: claude-test-missing"}}',
    );

    const { result: clientBody, entries } = await runCompressedErrorExchange({
      statusCode: 404,
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'br' },
      body: compressedBody,
    });

    const upstreamError = entries.find(entry => entry.event === 'upstream_error');
    expect(upstreamError).toMatchObject({ statusCode: 404 });
    expect(upstreamError?.errorContent).toContain('model: claude-test-missing');
    expect(clientBody.equals(compressedBody)).toBe(true);
  }, 20_000);
});
