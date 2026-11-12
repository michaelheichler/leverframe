import * as http from 'node:http';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { once } from 'node:events';
import { relative, sep } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import * as adapterModule from '../src/http-proxy/server.js';
import { startHttpProxy, type HttpProxyHandle } from '../src/http-proxy/server.js';

interface AdapterPoolContract {
  ADAPTER_IDLE_TIMEOUT_MS: number;
  ADAPTER_MAX_FREE_SOCKETS: number;
  ADAPTER_MAX_SOCKETS: number;
  createAdapterAgent(options?: { maxSockets?: number; maxFreeSockets?: number; idleTimeoutMs?: number }): http.Agent;
}
const pool = adapterModule as unknown as AdapterPoolContract;

const WAIT_MS = 10_000;
const OVERFLOW_REQUESTS = 8;
const LATE_ARRIVAL_GRACE_MS = 300;
const ORIGIN_KEEP_ALIVE_MS = 120_000;
const route = {
  aliasId: 'leverframe:test:pooled-model', realModelId: 'pooled-model', displayName: 'Pooled Model',
  upstreamUrl: '', apiKey: 'adapter-pool-dummy-key', modelFormat: 'openai' as const,
  npm: '@ai-sdk/openai-compatible', providerId: 'test-provider',
};

function poolLimits() {
  const limits = { maxSockets: pool.ADAPTER_MAX_SOCKETS, maxFreeSockets: pool.ADAPTER_MAX_FREE_SOCKETS,
    idleTimeoutMs: pool.ADAPTER_IDLE_TIMEOUT_MS };
  const unbounded = Object.entries(limits).filter(([, value]) => !(Number.isSafeInteger(value) && value > 0));
  if (unbounded.length > 0) {
    throw new Error(`src/http-proxy/server.ts exports no finite adapter pool limit for ${unbounded.map(([name]) => name).join(', ')}`);
  }
  return limits;
}

function within<T>(promise: Promise<T>, label: string, ms = WAIT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function settlesWithin(promise: Promise<unknown>, ms = WAIT_MS): Promise<boolean> {
  return within(promise.then(() => true), 'settle', ms).catch(() => false);
}

class AdapterOrigin {
  open = 0;
  peak = 0;
  private arrived = 0;
  private released = false;
  private readonly held: Array<() => void> = [];
  private readonly closeWatchers = new Set<() => void>();
  readonly server = http.createServer((req, res) => this.answer(req, res));

  constructor(private readonly releaseAt: number, private readonly graceMs: number) {
    this.server.keepAliveTimeout = ORIGIN_KEEP_ALIVE_MS;
    this.server.on('connection', socket => this.track(socket));
  }

  openAtMost(count: number): Promise<void> {
    return new Promise(resolve => {
      const check = () => {
        if (this.open > count) return;
        this.closeWatchers.delete(check);
        resolve();
      };
      this.closeWatchers.add(check);
      check();
    });
  }

  close(): void {
    this.server.closeAllConnections();
    if (this.server.listening) this.server.close();
  }

  private track(socket: net.Socket): void {
    this.open += 1;
    this.peak = Math.max(this.peak, this.open);
    socket.once('close', () => {
      this.open -= 1;
      for (const watch of this.closeWatchers) watch();
    });
  }

  private async answer(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    req.resume();
    await once(req, 'end');
    this.arrived += 1;
    if (this.arrived === this.releaseAt) setTimeout(() => this.release(), this.graceMs);
    if (!this.released) await new Promise<void>(resolve => this.held.push(resolve));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '2' });
    res.end('{}');
  }

  private release(): void {
    this.released = true;
    for (const resume of this.held.splice(0)) resume();
  }
}

async function startAdapterOrigin(releaseAt: number, graceMs = 0): Promise<{ origin: AdapterOrigin; port: number }> {
  const origin = new AdapterOrigin(releaseAt, graceMs);
  onTestFinished(() => origin.close());
  origin.server.listen(0, '127.0.0.1');
  await once(origin.server, 'listening');
  return { origin, port: (origin.server.address() as net.AddressInfo).port };
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

async function startPooledProxy(adapter: { origin: AdapterOrigin; port: number }, adapterRequest?: typeof http.request) {
  const proxy = await startHttpProxy({
    routes: [route], ...(adapterRequest ? { adapterRequest } : {}),
    adapterHandle: { port: adapter.port, token: 'adapter-dummy-token', close: () => adapter.origin.close() },
  });
  onTestFinished(() => proxy.close());
  const testHome = process.env['LEVERFRAME_TEST_HOME'];
  if (!testHome || !isInside(testHome, proxy.caCertPath)) throw new Error('The proxy CA left the isolated test home.');
  return proxy;
}

async function connectMitm(proxy: HttpProxyHandle, ca: string): Promise<tls.TLSSocket> {
  const socket = net.connect(proxy.port, '127.0.0.1');
  socket.on('error', () => {});
  onTestFinished(() => { socket.destroy(); });
  await once(socket, 'connect');
  const auth = Buffer.from(`leverframe:${proxy.token}`).toString('base64');
  socket.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
  let head = Buffer.alloc(0);
  while (!head.includes('\r\n\r\n')) head = Buffer.concat([head, (await once(socket, 'data') as [Buffer])[0]]);
  const boundary = head.indexOf('\r\n\r\n') + 4;
  if (!head.subarray(0, boundary).toString().includes(' 200 ')) throw new Error(`proxy refused CONNECT: ${head.toString()}`);
  if (head.length > boundary) socket.unshift(head.subarray(boundary));
  const secure = tls.connect({ socket, servername: 'api.anthropic.com', ca });
  secure.on('error', () => {});
  await once(secure, 'secureConnect');
  return secure;
}

async function translatedStatus(proxy: HttpProxyHandle, ca: string): Promise<string> {
  const secure = await connectMitm(proxy, ca);
  const body = JSON.stringify({ model: route.aliasId, messages: [{ role: 'user', content: 'pool' }], stream: false });
  secure.write(['POST /v1/messages HTTP/1.1', 'Host: api.anthropic.com', 'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close', '', ''].join('\r\n') + body);
  let text = '';
  for await (const chunk of secure) text += String(chunk);
  return text.split('\r\n')[0] ?? '';
}

function burst(proxy: HttpProxyHandle, count: number): Promise<string[]> {
  const ca = ensureHttpProxyCertificates().caCert;
  return within(Promise.all(Array.from({ length: count }, () => translatedStatus(proxy, ca))), 'the burst was not fully answered');
}

const TEST_IDLE_MS = 120;
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function agentFixture() {
  const agent = pool.createAdapterAgent({ idleTimeoutMs: TEST_IDLE_MS });
  onTestFinished(() => agent.destroy());
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.flushHeaders();
    res.write('first');
    setTimeout(() => res.end('last'), Number(_req.headers['x-hold-ms'] ?? 0));
  });
  server.keepAliveTimeout = ORIGIN_KEEP_ALIVE_MS;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  onTestFinished(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { agent, server, sockets, port: (server.address() as net.AddressInfo).port };
}

function agentExchange(fixture: Awaited<ReturnType<typeof agentFixture>>, holdMs = 0) {
  const request = http.get({ host: '127.0.0.1', port: fixture.port, agent: fixture.agent,
    headers: { 'x-hold-ms': holdMs } });
  onTestFinished(() => { request.destroy(); });
  const response = new Promise<{ body: string; reused: boolean }>((resolve, reject) => {
    request.once('error', reject);
    request.once('response', res => {
      let body = '';
      res.on('data', chunk => { body += String(chunk); });
      res.once('error', reject);
      res.once('end', () => resolve({ body, reused: request.reusedSocket }));
    });
  });
  return within(response, 'adapter response');
}

describe('loopback adapter connection pool', () => {
  it('never holds more adapter sockets open at once than the pool cap and still answers every request', async () => {
    const { maxSockets } = poolLimits();
    const requests = maxSockets + OVERFLOW_REQUESTS;
    const adapter = await startAdapterOrigin(maxSockets, LATE_ARRIVAL_GRACE_MS);
    const statuses = await burst(await startPooledProxy(adapter), requests);
    const answered = statuses.filter(status => status.startsWith('HTTP/1.1 200')).length;
    expect({ answered, peak: adapter.origin.peak }).toEqual({ answered: requests, peak: maxSockets });
  }, 60_000);

  it('closes surplus adapter sockets after a burst and keeps at most the free-socket cap', async () => {
    const { maxSockets, maxFreeSockets } = poolLimits();
    const adapter = await startAdapterOrigin(maxSockets);
    await burst(await startPooledProxy(adapter), maxSockets);
    const settled = await settlesWithin(adapter.origin.openAtMost(maxFreeSockets));
    expect(settled, `${adapter.origin.open} idle adapter sockets stayed open`).toBe(true);
  }, 60_000);

  it('closes a free adapter socket after its idle period', async () => {
    const fixture = await agentFixture();
    await agentExchange(fixture);
    await vi.waitFor(() => expect(fixture.sockets.size).toBe(0), { timeout: TEST_IDLE_MS * 10 });
  });

  it('does not cut an active adapter stream that stays quiet longer than the idle period', async () => {
    const fixture = await agentFixture();
    expect(await agentExchange(fixture, TEST_IDLE_MS * 2)).toEqual({ body: 'firstlast', reused: false });
  });

  it('cancels the old idle deadline when a free adapter socket is reused', async () => {
    const fixture = await agentFixture();
    await agentExchange(fixture);
    await delay(TEST_IDLE_MS / 2);
    expect(await agentExchange(fixture, TEST_IDLE_MS * 0.75)).toEqual({ body: 'firstlast', reused: true });
  });

  it('creates a pool whose default active and free socket budgets are finite', () => {
    const agent = pool.createAdapterAgent();
    onTestFinished(() => agent.destroy());
    expect(Number.isSafeInteger(agent.maxSockets) && agent.maxSockets > 0).toBe(true);
    expect(Number.isSafeInteger(agent.maxFreeSockets) && agent.maxFreeSockets > 0).toBe(true);
    expect(agent.maxFreeSockets).toBeLessThanOrEqual(agent.maxSockets);
    expect(agent.maxTotalSockets).toBe(agent.maxSockets);
  });
});
