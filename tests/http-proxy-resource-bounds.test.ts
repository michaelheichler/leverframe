import * as http from 'node:http';
import * as net from 'node:net';
import { once } from 'node:events';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import * as proxyModule from '../src/http-proxy/proxy-server.js';

const TOKEN = 'resource-dummy-token';
const AUTH = `Basic ${Buffer.from(`leverframe:${TOKEN}`).toString('base64')}`;
const WAIT_MS = 1500;
const QUIET_MS = 160;
interface Limits {
  maxConnections?: number;
  tunnelConnectTimeoutMs?: number;
  connect?: (port: number, host: string) => net.Socket;
}
interface ProxyContract {
  PROXY_MAX_CONNECTIONS: number;
  TCP_KEEPALIVE_INITIAL_DELAY_MS: number;
  TUNNEL_CONNECT_TIMEOUT_MS: number;
  createProxyServer(token: string, routes: Map<string, never>, mitm: http.Server, sockets: Set<net.Socket>,
    routing: undefined, limits?: Limits): http.Server;
}
const contract = proxyModule as unknown as ProxyContract;
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function within<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('socket operation did not settle')), WAIT_MS);
  })]).finally(() => clearTimeout(timer));
}

async function listen(server: net.Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
}

function cleanup(server: net.Server, sockets: Set<net.Socket>) {
  server.on('connection', socket => {
    socket.on('error', () => {});
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
}

async function proxy(limits?: Limits) {
  const sockets = new Set<net.Socket>();
  const server = contract.createProxyServer(TOKEN, new Map<string, never>(), http.createServer(), sockets, undefined, limits);
  cleanup(server, sockets);
  return { server, sockets, port: await listen(server) };
}

async function client(port: number) {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  onTestFinished(() => { socket.destroy(); });
  await within(once(socket, 'connect'));
  return socket;
}

function closed(socket: net.Socket): Promise<void> {
  return socket.closed ? Promise.resolve() : new Promise(resolve => socket.once('close', () => resolve()));
}

function head(socket: net.Socket): Promise<string> {
  return new Promise(resolve => {
    let result = '';
    const receive = (chunk: Buffer) => {
      result += String(chunk);
      if (!result.includes('\r\n\r\n')) return;
      socket.off('data', receive);
      resolve(result);
    };
    socket.on('data', receive);
  });
}

async function origin(transport: 'plain' | 'tunnel') {
  const sockets = new Set<net.Socket>();
  const state: { response?: http.ServerResponse } = {};
  const server = transport === 'plain'
    ? http.createServer((_req, res) => { state.response = res; res.writeHead(200); res.write('ready'); })
    : net.createServer();
  cleanup(server, sockets);
  return { sockets, port: await listen(server), send: (text: string) => transport === 'plain'
    ? state.response!.write(text) : [...sockets][0]!.write(text) };
}

async function open(transport: 'plain' | 'tunnel', limits?: Limits) {
  const upstream = await origin(transport);
  const downstream = await proxy(limits);
  const socket = await client(downstream.port);
  const response = head(socket);
  const authority = `127.0.0.1:${upstream.port}`;
  const line = transport === 'plain' ? `GET http://${authority}/listen` : `CONNECT ${authority}`;
  socket.write(`${line} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${AUTH}\r\n\r\n`);
  const headers = await within(response);
  if (!headers.startsWith('HTTP/1.1 200')) throw new Error(`unexpected proxy response: ${headers}`);
  return { upstream, downstream, socket };
}

interface KeepAliveCall { socket: net.Socket; enabled: boolean | undefined; initialDelay: number | undefined }
function observeKeepAlive() {
  const calls: KeepAliveCall[] = [];
  const original = net.Socket.prototype.setKeepAlive;
  const spy = vi.spyOn(net.Socket.prototype, 'setKeepAlive').mockImplementation(function (this: net.Socket, enabled, initialDelay) {
    calls.push({ socket: this, enabled, initialDelay });
    return original.call(this, enabled, initialDelay);
  });
  onTestFinished(() => spy.mockRestore());
  return calls;
}

function pendingConnect() {
  const state: { socket?: net.Socket } = {};
  const connect = (port: number): net.Socket => {
    state.socket = net.connect({ port, host: 'pending.invalid', lookup: () => {} });
    state.socket.on('error', () => {});
    onTestFinished(() => { state.socket?.destroy(); });
    return state.socket;
  };
  return { state, connect };
}

describe('proxy connection ownership and bounds', () => {
  it('has a finite default client connection budget', async () => {
    const { server } = await proxy();
    expect(Number.isSafeInteger(server.maxConnections) && server.maxConnections > 0).toBe(true);
    expect(server.maxConnections).toBe(contract.PROXY_MAX_CONNECTIONS);
  });

  it('closes connections above its budget while a connection below it still forwards', async () => {
    const upstream = await origin('plain');
    const downstream = await proxy({ maxConnections: 2 });
    const admitted = await client(downstream.port);
    await client(downstream.port);
    const overflow = await client(downstream.port);
    overflow.resume();
    await within(closed(overflow));
    const response = head(admitted);
    admitted.write(`GET http://127.0.0.1:${upstream.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\nProxy-Authorization: ${AUTH}\r\n\r\n`);
    expect(await within(response)).toMatch(/^HTTP\/1\.1 200/);
  });

});

describe('TCP dead-peer detection without stream idle deadlines', () => {
  it.each([
    ['plain', 'client'], ['plain', 'upstream'], ['tunnel', 'client'], ['tunnel', 'upstream'],
  ] as const)('enables TCP dead-peer probes on the %s %s socket', async (transport, side) => {
    const calls = observeKeepAlive();
    const connection = await open(transport);
    const port = side === 'client' ? connection.downstream.port : connection.upstream.port;
    const applicable = calls.filter(call => side === 'client' ? call.socket.localPort === port : call.socket.remotePort === port);
    expect(applicable.map(({ enabled, initialDelay }) => ({ enabled, initialDelay }))).toEqual(expect.arrayContaining([
      { enabled: true, initialDelay: contract.TCP_KEEPALIVE_INITIAL_DELAY_MS },
    ]));
    expect(Number.isSafeInteger(contract.TCP_KEEPALIVE_INITIAL_DELAY_MS)
      && contract.TCP_KEEPALIVE_INITIAL_DELAY_MS > 0).toBe(true);
  });

  it.each(['plain', 'tunnel'] as const)('keeps a healthy quiet %s stream open and delivers later data', async transport => {
    const connection = await open(transport, { tunnelConnectTimeoutMs: QUIET_MS / 4 });
    await delay(QUIET_MS);
    const received = once(connection.socket, 'data');
    connection.upstream.send('late-stream-data');
    expect(String((await within(received))[0])).toContain('late-stream-data');
    expect(connection.socket.destroyed).toBe(false);
  });

  it('bounds a pending tunnel connection and destroys its pending upstream socket', async () => {
    const pending = pendingConnect();
    const upstream = await origin('tunnel');
    const downstream = await proxy({ tunnelConnectTimeoutMs: 40, connect: pending.connect });
    const socket = await client(downstream.port);
    socket.resume();
    socket.write(`CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\nProxy-Authorization: ${AUTH}\r\n\r\n`);
    await within(closed(socket));
    expect(pending.state.socket?.destroyed).toBe(true);
    expect(Number.isSafeInteger(contract.TUNNEL_CONNECT_TIMEOUT_MS) && contract.TUNNEL_CONNECT_TIMEOUT_MS > 0).toBe(true);
  });
});
