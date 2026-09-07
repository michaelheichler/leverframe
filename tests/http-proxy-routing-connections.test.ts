import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { once } from 'node:events';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { startHttpProxy } from '../src/http-proxy/server.js';

const testHome = mkdtempSync(join(tmpdir(), 'leverframe-http-proxy-connections-'));
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

describe('selective HTTP proxy relay connection lifecycle', () => {
  it('terminates and logs a translated response when the adapter closes before end', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'adapter-abort-inference.jsonl');
    const adapterServer = http.createServer(async (req, res) => {
      const ended = once(req, 'end');
      req.resume();
      await ended;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      setImmediate(() => res.destroy(new Error('adapter reset')));
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
        messages: [{ role: 'user', content: 'test adapter reset' }],
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
      const requestEntry = entries.find(entry => !entry.event);
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_started',
        requestId: requestEntry.requestId,
        statusCode: 200,
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_failed',
        requestId: requestEntry.requestId,
        statusCode: 200,
        phase: 'streaming',
      }));
      expect(entries.some(entry => entry.event === 'response_completed')).toBe(false);
    } finally {
      await proxy.close();
    }
  }, 20_000);

  it('reuses a private keep-alive pool for translated adapter requests', async () => {
    const certificates = ensureHttpProxyCertificates();
    let connectionCount = 0;
    const adapterServer = http.createServer((req, res) => {
      req.resume();
      req.once('end', () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': '2',
        });
        res.end('{}');
      });
    });
    adapterServer.keepAliveTimeout = 60_000;
    adapterServer.on('connection', () => {
      connectionCount += 1;
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
      adapterRequest: ((options: http.RequestOptions, onResponse: (response: http.IncomingMessage) => void) =>
        http.request(
          { ...options, agent: options.agent ?? false },
          onResponse,
        )) as typeof http.request,
    });

    try {
      const body = JSON.stringify({
        model: route.aliasId,
        messages: [{ role: 'user', content: 'test adapter connection reuse' }],
        stream: false,
      });
      const requestTranslatedModel = async () => {
        const secure = await connectMitm(proxy.port, certificates.caCert, proxy.token);
        const payload = Buffer.from(body);
        secure.write([
          'POST /v1/messages HTTP/1.1',
          'Host: api.anthropic.com',
          'Content-Type: application/json',
          `Content-Length: ${payload.length}`,
          'Connection: close',
          '',
          '',
        ].join('\r\n'));
        secure.write(payload);

        let response = '';
        for await (const chunk of secure) {
          response += chunk.toString();
          if (response.includes('\r\n\r\n{}')) break;
        }
        secure.destroy();
        return response;
      };
      const firstResponse = await requestTranslatedModel();
      const secondResponse = await requestTranslatedModel();

      expect(firstResponse).toContain('200');
      expect(secondResponse).toContain('200');
      expect(connectionCount).toBe(1);
    } finally {
      await proxy.close();
    }
  }, 20_000);
});
