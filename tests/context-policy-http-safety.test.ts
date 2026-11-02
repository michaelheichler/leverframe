import * as https from 'node:https';
import * as tls from 'node:tls';
import { expect, it, vi } from 'vitest';
import * as requestPolicy from '../src/context/request-policy.js';
import { startHttpProxy } from '../src/http-proxy/server.js';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { bounded, connectMitm } from './fixtures/account-pool-proxy.js';

type CapturedRequest = { path: string | undefined; body: string };

async function startOrigin(certificates: ReturnType<typeof ensureHttpProxyCertificates>, received: CapturedRequest[]) {
  const origin = https.createServer({ key: certificates.serverKey, cert: certificates.serverCert }, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ path: request.url, body: Buffer.concat(chunks).toString() });
    response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end('{}');
  });
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  const address = origin.address();
  if (!address || typeof address === 'string') throw new Error('Local HTTPS origin failed to bind');
  return {
    port: address.port,
    close: async () => {
      origin.closeAllConnections();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    },
  };
}

async function startProxy(port: number) {
  return startHttpProxy({
    routes: [],
    anthropicOrigin: `https://127.0.0.1:${port}`,
    anthropicRejectUnauthorized: false,
  });
}

function writeRequest(socket: tls.TLSSocket, path: string, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write([
      `POST ${path} HTTP/1.1`, 'Host: api.anthropic.com', 'X-API-Key: fixture-key',
      'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close', '', '',
    ].join('\r\n') + body, error => error ? reject(error) : resolve());
  });
}

it.each(['/v1/messages/count_tokens', '/v1/models'])(
  'forwards %s without invoking context policy', async path => {
    const certificates = ensureHttpProxyCertificates();
    const received: CapturedRequest[] = [];
    const origin = await startOrigin(certificates, received);
    const proxy = await startProxy(origin.port);
    const applyPolicy = vi.spyOn(requestPolicy, 'applyRequestContextPolicy');
    const rawBody = '{ "model": "fixture-model", "messages": [] }';

    try {
      const socket = await bounded(connectMitm(proxy.port, proxy.token, certificates.caCert), 'HTTP proxy TLS handshake timed out');
      let response = '';
      socket.on('data', chunk => { response += chunk.toString(); });
      await writeRequest(socket, path, rawBody);
      await bounded(new Promise<void>(resolve => socket.once('close', resolve)), 'Raw endpoint response did not close');

      expect(response).toContain('HTTP/1.1 200');
      expect(received).toEqual([{ path, body: rawBody }]);
      expect(applyPolicy).not.toHaveBeenCalled();
    } finally {
      await proxy.close();
      await origin.close();
      vi.restoreAllMocks();
    }
  },
);

it('aborts deferred policy work after a direct HTTP client disconnects', async () => {
  const certificates = ensureHttpProxyCertificates();
  const received: CapturedRequest[] = [];
  const origin = await startOrigin(certificates, received);
  const proxy = await startProxy(origin.port);
  let policySignal: AbortSignal | undefined;
  let policyStarted: (() => void) | undefined;
  let finishPolicy: (() => void) | undefined;
  const policyReached = new Promise<void>(resolve => { policyStarted = resolve; });
  const policyFinished = new Promise<void>(resolve => { finishPolicy = resolve; });
  vi.spyOn(requestPolicy, 'applyRequestContextPolicy').mockImplementation(async input => {
    policySignal = input.signal;
    policyStarted?.();
    await new Promise<void>(resolve => {
      if (input.signal.aborted) resolve();
      else input.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    finishPolicy?.();
    return { request: input.request, outcome: 'unchanged', reason: 'aborted' };
  });

  try {
    const socket = await bounded(connectMitm(proxy.port, proxy.token, certificates.caCert), 'HTTP proxy TLS handshake timed out');
    await writeRequest(socket, '/v1/messages', JSON.stringify({
      model: 'fixture-model', messages: [{ role: 'user', content: 'hello' }],
    }));
    await bounded(policyReached, 'Context policy was not reached');
    socket.destroy();
    await bounded(policyFinished, 'Deferred context policy did not observe disconnect');

    expect(policySignal?.aborted).toBe(true);
    expect(received).toHaveLength(0);
  } finally {
    await proxy.close();
    await origin.close();
    vi.restoreAllMocks();
  }
});
