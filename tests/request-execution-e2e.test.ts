

import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { aliasModelId, startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-request-execution');

interface PostToProxyRequest {
  port: number;
  token: string;
  body: unknown;
  path?: string;
}

function postToProxy({ port, token, body, path = '/v1/messages' }: PostToProxyRequest): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      res => {
        let data = '';
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0, body: data });
        };
        res.on('data', chunk => { data += chunk; });
        res.on('end', settle);

        res.on('close', settle);
        res.on('error', settle);
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test upstream did not bind');
  return address.port;
}

function baseRoute(port: number, overrides: Partial<ProxyRoute> = {}): ProxyRoute {
  return {
    aliasId: aliasModelId('deadline-test-model', 'test-provider'),
    realModelId: 'deadline-test-model',
    displayName: 'Deadline Test Model',
    upstreamUrl: `http://127.0.0.1:${port}`,
    apiKey: 'provider-key',
    modelFormat: 'anthropic',
    providerId: 'test-provider',
    ...overrides,
  };
}

describe('request execution — deadline classes (E2E)', () => {
  it('fails fast on the header deadline when the upstream accepts the connection but never responds', async () => {
    const upstream = http.createServer((req) => {
      req.resume();

    });
    const port = await listen(upstream);
    const route = baseRoute(port, {
      requestDeadlines: { connectMs: 5_000, headerMs: 80, idleMs: 5_000, totalMs: 5_000 },
    });
    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const res = await postToProxy({
        port: handle.port,
        token: handle.token,
        body: { model: route.aliasId, messages: [{ role: 'user', content: 'hi' }] },
      });

      expect(res.status).toBe(502);
    } finally {
      handle.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }, 10_000);

  it('fails on the idle deadline when the upstream stream stalls after its first chunk', async () => {
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: content_block_start\ndata: {}\n\n');

    });
    const port = await listen(upstream);
    const route = baseRoute(port, {
      requestDeadlines: { connectMs: 5_000, headerMs: 5_000, idleMs: 80, totalMs: 5_000 },
    });
    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const res = await postToProxy({
        port: handle.port,
        token: handle.token,
        body: { model: route.aliasId, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });

      expect(res.status).toBe(200);
      expect(res.body).toContain('content_block_start');
    } finally {
      handle.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }, 10_000);

  it('fails on the total deadline even under continuous idle-resetting activity', async () => {
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const timer = setInterval(() => {
        if (res.writableEnded) { clearInterval(timer); return; }
        res.write('event: ping\ndata: {}\n\n');
      }, 15);
      res.once('close', () => clearInterval(timer));
    });
    const port = await listen(upstream);
    const route = baseRoute(port, {

      requestDeadlines: { connectMs: 5_000, headerMs: 5_000, idleMs: 5_000, totalMs: 400 },
    });
    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const res = await postToProxy({
        port: handle.port,
        token: handle.token,
        body: { model: route.aliasId, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('event: ping');
    } finally {
      handle.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }, 10_000);
});

describe('request execution — downstream disconnect and terminal-once (E2E)', () => {
  it('tears down the upstream connection when the client disconnects mid-stream', async () => {
    let upstreamClosedResolve!: () => void;
    const upstreamClosed = new Promise<void>(resolve => { upstreamClosedResolve = resolve; });
    let firstChunkSentResolve!: () => void;
    const firstChunkSent = new Promise<void>(resolve => { firstChunkSentResolve = resolve; });
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: content_block_start\ndata: {}\n\n');
      firstChunkSentResolve();
      req.socket.once('close', upstreamClosedResolve);
    });
    const port = await listen(upstream);
    const route = baseRoute(port, {
      requestDeadlines: { connectMs: 5_000, headerMs: 5_000, idleMs: 5_000, totalMs: 5_000 },
    });
    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const payload = JSON.stringify({ model: route.aliasId, stream: true, messages: [{ role: 'user', content: 'hi' }] });
      const clientReq = http.request({
        hostname: '127.0.0.1',
        port: handle.port,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${handle.token}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      });
      clientReq.on('error', () => {});
      clientReq.end(payload);
      await firstChunkSent;

      clientReq.destroy();
      await upstreamClosed;
    } finally {
      handle.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }, 10_000);

  it('stays responsive after a terminal outcome — a fresh request on the same proxy still completes', async () => {
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', id: 'msg_ok', model: 'deadline-test-model', content: [] }));
    });
    const port = await listen(upstream);
    const route = baseRoute(port, {
      requestDeadlines: { connectMs: 5_000, headerMs: 5_000, idleMs: 5_000, totalMs: 5_000 },
    });
    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {

      const first = await postToProxy({
        port: handle.port,
        token: handle.token,
        body: { model: route.aliasId, messages: [{ role: 'user', content: 'one' }] },
      });
      expect(first.status).toBe(200);

      const second = await postToProxy({
        port: handle.port,
        token: handle.token,
        body: { model: route.aliasId, messages: [{ role: 'user', content: 'two' }] },
      });
      expect(second.status).toBe(200);
      expect(JSON.parse(second.body)).toMatchObject({ id: 'msg_ok' });
    } finally {
      handle.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }, 10_000);
});

describe('request execution — malformed/truncated completions (E2E)', () => {
  it('reports a clean 502 when the upstream response body is not valid JSON', async () => {
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"type": "message", "id": truncated-not-json');
    });
    const port = await listen(upstream);
    const route = baseRoute(port, {
      requestDeadlines: { connectMs: 5_000, headerMs: 5_000, idleMs: 5_000, totalMs: 5_000 },
    });
    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const res = await postToProxy({
        port: handle.port,
        token: handle.token,
        body: { model: route.aliasId, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(502);
      expect(res.body).toContain('not valid JSON');
    } finally {
      handle.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }, 10_000);
});

describe('request execution — native passthrough byte invariance (E2E)', () => {
  it('forwards the Anthropic SSE stream byte-for-byte under lifecycle wiring (deadlines generous, none fire)', async () => {
    const sseBody = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sseBody);
    });
    const port = await listen(upstream);
    const route = baseRoute(port, {
      requestDeadlines: { connectMs: 5_000, headerMs: 5_000, idleMs: 5_000, totalMs: 5_000 },
    });
    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const res = await postToProxy({
        port: handle.port,
        token: handle.token,
        body: { model: route.aliasId, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.status).toBe(200);
      expect(res.body).toBe(sseBody);
    } finally {
      handle.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }, 10_000);
});
