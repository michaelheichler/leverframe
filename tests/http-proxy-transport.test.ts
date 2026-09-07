import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';
import { once } from 'node:events';
import { ensureHttpProxyCaBundle, ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { shouldInterceptConnect, startHttpProxy } from '../src/http-proxy/server.js';

const testHome = mkdtempSync(join(tmpdir(), 'leverframe-http-proxy-'));
const previousRelayHome = process.env['LEVERFRAME_HOME'];

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return address.port;
}

function activeProxySockets(proxyPort: number): net.Socket[] {
  const getActiveHandles = (process as typeof process & {
    _getActiveHandles(): unknown[];
  })._getActiveHandles;
  return getActiveHandles.call(process).filter((handle): handle is net.Socket =>
    handle instanceof net.Socket
    && handle.localPort === proxyPort
    && !handle.destroyed);
}

beforeAll(() => {
  process.env['LEVERFRAME_HOME'] = testHome;
});

afterAll(() => {
  if (previousRelayHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousRelayHome;
  rmSync(testHome, { recursive: true, force: true });
});

describe('selective HTTP proxy', () => {
  it('rejects an occupied port without leaking the adapter, server, or process listeners', async () => {
    const occupier = net.createServer();
    const occupiedPort = await listen(occupier);
    const activeServers = (): net.Server[] => {
      const getActiveHandles = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles;
      return getActiveHandles.call(process).filter((handle): handle is net.Server =>
        handle instanceof net.Server && handle.listening);
    };
    const beforeServers = activeServers().length;
    const beforeRejections = process.listenerCount('unhandledRejection');
    const beforeExceptions = process.listenerCount('uncaughtException');

    try {
      await expect(startHttpProxy({
        port: occupiedPort,
        routes: [{
          aliasId: 'leverframe:test:bind-failure',
          realModelId: 'bind-failure',
          displayName: 'Bind Failure',
          upstreamUrl: '',
          apiKey: '',
          modelFormat: 'openai',
          npm: '@ai-sdk/openai-compatible',
          providerId: 'test',
        }],
      })).rejects.toMatchObject({ code: 'EADDRINUSE' });

      expect(activeServers()).toHaveLength(beforeServers);
      expect(process.listenerCount('unhandledRejection')).toBe(beforeRejections);
      expect(process.listenerCount('uncaughtException')).toBe(beforeExceptions);
    } finally {
      await new Promise<void>(resolve => occupier.close(() => resolve()));
    }
  });

  it('preserves an existing custom CA in the child trust bundle', () => {
    const certificates = ensureHttpProxyCertificates();
    const extraPath = join(testHome, 'corporate-ca.pem');
    writeFileSync(extraPath, '-----BEGIN CERTIFICATE-----\ncorporate-test\n-----END CERTIFICATE-----\n');
    const combinedPath = ensureHttpProxyCaBundle(certificates.caCertPath, extraPath);
    const combined = readFileSync(combinedPath, 'utf8');
    expect(combinedPath).not.toBe(certificates.caCertPath);
    expect(combined).toContain(certificates.caCert.trim());
    expect(combined).toContain('corporate-test');
  });

  it('intercepts only api.anthropic.com on port 443', () => {
    expect(shouldInterceptConnect('api.anthropic.com:443')).toBe(true);
    expect(shouldInterceptConnect('API.ANTHROPIC.COM.:443')).toBe(true);
    expect(shouldInterceptConnect('api.anthropic.com:8443')).toBe(false);
    expect(shouldInterceptConnect('statsig.anthropic.com:443')).toBe(false);
    expect(shouldInterceptConnect('example.com:443')).toBe(false);
  });

  it('releases both sides of a passthrough CONNECT tunnel when upstream closes', async () => {
    const upstream = net.createServer(socket => socket.end());
    const upstreamPort = await listen(upstream);
    const proxy = await startHttpProxy({ routes: [] });
    const clients: net.Socket[] = [];
    const authHeader = `Proxy-Authorization: Basic ${Buffer.from(`leverframe:${proxy.token}`).toString('base64')}\r\n`;

    try {
      for (let index = 0; index < 25; index += 1) {
        const client = net.connect({
          host: '127.0.0.1',
          port: proxy.port,
          allowHalfOpen: true,
        });
        clients.push(client);
        await once(client, 'connect');
        client.resume();
        client.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n${authHeader}\r\n`);
        await once(client, 'end');
      }
      await new Promise(resolve => setImmediate(resolve));

      expect(activeProxySockets(proxy.port)).toHaveLength(0);
    } finally {
      for (const client of clients) client.destroy();
      await proxy.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });

  it('survives a client RST on an established passthrough tunnel', async () => {
    const upstream = net.createServer(socket => {
      socket.on('error', () => {});
      const flood = setInterval(() => socket.write('x'.repeat(16384)), 1);
      socket.once('close', () => clearInterval(flood));
    });
    const upstreamPort = await listen(upstream);
    const proxy = await startHttpProxy({ routes: [] });
    const authHeader = `Proxy-Authorization: Basic ${Buffer.from(`leverframe:${proxy.token}`).toString('base64')}\r\n`;
    const connectRequest = `CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n${authHeader}\r\n`;

    try {
      const client = net.connect(proxy.port, '127.0.0.1');
      client.on('error', () => {});
      await once(client, 'connect');
      client.write(connectRequest);
      const [firstChunk] = await once(client, 'data') as [Buffer];
      expect(firstChunk.toString()).toContain('200 Connection Established');

      const tunnelSocket = activeProxySockets(proxy.port).find(
        candidate => candidate.remotePort === client.localPort,
      );
      expect(tunnelSocket?.listenerCount('error')).toBeGreaterThanOrEqual(2);

      client.resetAndDestroy();
      await new Promise(resolve => setTimeout(resolve, 100));

      const probe = net.connect(proxy.port, '127.0.0.1');
      probe.on('error', () => {});
      await once(probe, 'connect');
      probe.write(connectRequest);
      const [established] = await once(probe, 'data') as [Buffer];
      expect(established.toString()).toContain('200 Connection Established');
      probe.destroy();
    } finally {
      await proxy.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
});
