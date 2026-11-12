import * as http from 'node:http';
import * as net from 'node:net';
import { once } from 'node:events';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createProxyServer } from '../src/http-proxy/proxy-server.js';

const TOKEN = 'test-token';
const PROXY_AUTH = `Basic ${Buffer.from(`leverframe:${TOKEN}`).toString('base64')}`;
const WAIT_MS = 1500;

interface TrackedSocket { socket: net.Socket; closed: Promise<void> }
interface Origin { port: number; firstConnection: Promise<TrackedSocket> }
type SocketAction = (socket: net.Socket) => void;

const ignore = (): void => {};

function within<T>(promise: Promise<T>, label: string, ms = WAIT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function settlesWithin(promise: Promise<unknown>, ms = WAIT_MS): Promise<boolean> {
  return within(promise.then(() => true, () => true), 'settle', ms).catch(() => false);
}

function closeOf(stream: net.Socket | http.IncomingMessage): Promise<void> {
  if (stream.closed) return Promise.resolve();
  return new Promise(resolve => stream.once('close', () => resolve()));
}

function readToEnd(stream: net.Socket): Promise<string> {
  let text = '';
  stream.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  stream.resume();
  return new Promise(resolve => stream.once('end', () => resolve(text)));
}

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
}

function closeOnFinish(server: net.Server, openSockets: () => Iterable<net.Socket>): void {
  onTestFinished(async () => {
    for (const socket of openSockets()) socket.destroy();
    if (server instanceof http.Server) server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
}

async function startOrigin(server: net.Server): Promise<Origin> {
  const sockets: net.Socket[] = [];
  const firstConnection = new Promise<TrackedSocket>(resolve => {
    server.on('connection', (socket: net.Socket) => {
      socket.on('error', ignore);
      sockets.push(socket);
      resolve({ socket, closed: closeOf(socket) });
    });
  });
  closeOnFinish(server, () => sockets);
  return { port: await listen(server), firstConnection };
}

async function startProxy(): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = createProxyServer(TOKEN, new Map(), http.createServer(), sockets);
  closeOnFinish(server, () => [...sockets]);
  return listen(server);
}

function clientAgent(): http.Agent {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  onTestFinished(() => agent.destroy());
  return agent;
}

function proxiedRequest(proxyPort: number, origin: Origin, options: {
  agent?: http.Agent; method?: string; path?: string; headers?: http.OutgoingHttpHeaders;
} = {}): http.ClientRequest {
  const authority = `127.0.0.1:${origin.port}`;
  const req = http.request({
    host: '127.0.0.1', port: proxyPort, method: options.method ?? 'POST', agent: options.agent ?? clientAgent(),
    path: `http://${authority}${options.path ?? '/mcp'}`,
    headers: { host: authority, 'proxy-authorization': PROXY_AUTH, ...options.headers },
  });
  req.on('error', ignore);
  onTestFinished(() => { req.destroy(); });
  return req;
}

function responseOf(req: http.ClientRequest): Promise<http.IncomingMessage> {
  return within(new Promise(resolve => req.once('response', (res: http.IncomingMessage) => {
    res.on('error', ignore);
    resolve(res);
  })), 'client never received response headers');
}

function signal(): { fire: () => void; fired: Promise<void> } {
  let fire = ignore;
  const fired = new Promise<void>(resolve => { fire = resolve; });
  return { fire, fired };
}

async function openEventStream(): Promise<{ origin: Origin; response: http.IncomingMessage; clientSocket: net.Socket }> {
  const origin = await startOrigin(http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ready\n\n');
  }));
  const req = proxiedRequest(await startProxy(), origin, { headers: { 'content-type': 'application/json' } });
  req.end('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  const response = await responseOf(req);
  await within(once(response, 'data'), 'client never received the first event');
  const clientSocket = req.socket;
  if (!clientSocket) throw new Error('client request lost its socket');
  return { origin, response, clientSocket };
}

async function exchange(route: { agent: http.Agent; proxyPort: number; origin: Origin }, path: string) {
  const req = proxiedRequest(route.proxyPort, route.origin, { agent: route.agent, method: 'GET', path });
  req.end();
  const response = await responseOf(req);
  let body = '';
  response.on('data', (chunk: Buffer) => { body += chunk.toString(); });
  await within(closeOf(response), `response for ${path} never finished`);
  return { status: response.statusCode, body, reused: req.reusedSocket };
}

async function refusedPort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function openConnectTunnel(proxyPort: number, origin: Origin): Promise<net.Socket> {
  const socket = net.connect(proxyPort, '127.0.0.1');
  socket.on('error', ignore);
  onTestFinished(() => { socket.destroy(); });
  await within(once(socket, 'connect'), 'client never reached the proxy');
  socket.write(`CONNECT 127.0.0.1:${origin.port} HTTP/1.1\r\nHost: 127.0.0.1:${origin.port}\r\n`
    + `Proxy-Authorization: ${PROXY_AUTH}\r\n\r\n`);
  const head = await within(readHead(socket), 'proxy never answered CONNECT');
  if (!head.startsWith('HTTP/1.1 200')) throw new Error(`proxy refused the tunnel: ${head}`);
  return socket;
}

function readHead(socket: net.Socket): Promise<string> {
  let text = '';
  return new Promise(resolve => {
    const onData = (chunk: Buffer) => {
      text += chunk.toString();
      if (!text.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      socket.pause();
      resolve(text);
    };
    socket.on('data', onData);
  });
}

async function establishTunnel(originOptions: net.ServerOpts = {}) {
  const origin = await startOrigin(net.createServer(originOptions));
  const client = await openConnectTunnel(await startProxy(), origin);
  const upstream = await within(origin.firstConnection, 'origin never received the tunnel connection');
  return { client, upstream };
}

const clientDisconnects: Array<[string, SocketAction]> = [
  ['destroys its socket', socket => socket.destroy()],
  ['resets its socket', socket => socket.resetAndDestroy()],
  ['ends its socket gracefully', socket => socket.end()],
];

const originFailures: Array<[string, SocketAction]> = [
  ['destroys its socket', socket => socket.destroy()],
  ['resets its socket', socket => socket.resetAndDestroy()],
];

describe('plain forwarded HTTP when the client leaves', () => {
  it.each(clientDisconnects)('closes the origin socket of an open event stream when the client %s', async (_label, disconnect) => {
    const { origin, clientSocket } = await openEventStream();
    const upstream = await origin.firstConnection;
    disconnect(clientSocket);
    expect(await settlesWithin(upstream.closed), 'origin socket stayed open after the client left').toBe(true);
  });

  it('closes the origin socket when the client aborts before the upload finished', async () => {
    const uploadStarted = signal();
    const origin = await startOrigin(http.createServer(req => { req.resume(); uploadStarted.fire(); }));
    const req = proxiedRequest(await startProxy(), origin, { headers: { 'content-length': '1000' } });
    req.write('x'.repeat(10));
    await within(uploadStarted.fired, 'origin never saw the upload start');
    req.destroy();
    const upstream = await origin.firstConnection;
    expect(await settlesWithin(upstream.closed), 'origin socket stayed open after the upload was aborted').toBe(true);
  });

  it('closes the origin socket when the client leaves before response headers arrive', async () => {
    const bodyReceived = signal();
    const origin = await startOrigin(http.createServer(req => { req.resume(); req.once('end', bodyReceived.fire); }));
    const req = proxiedRequest(await startProxy(), origin);
    req.end('{}');
    await within(bodyReceived.fired, 'origin never received the full request body');
    req.destroy();
    const upstream = await origin.firstConnection;
    expect(await settlesWithin(upstream.closed), 'origin socket stayed open while waiting for headers').toBe(true);
  });

  it('closes the origin socket when the client leaves an error response the origin holds open', async () => {
    const errorStarted = signal();
    const origin = await startOrigin(http.createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.write('error body that never ends', errorStarted.fire);
    }));
    const req = proxiedRequest(await startProxy(), origin, { method: 'GET' });
    req.end();
    await within(errorStarted.fired, 'origin never started the error response');
    req.destroy();
    const upstream = await origin.firstConnection;
    expect(await settlesWithin(upstream.closed), 'origin socket stayed open behind an abandoned error response').toBe(true);
  });
});

describe('plain forwarded HTTP when the origin fails', () => {
  it.each(originFailures)('closes the client connection and leaves the response incomplete when the origin %s mid-stream', async (_label, fail) => {
    const { origin, response, clientSocket } = await openEventStream();
    fail((await origin.firstConnection).socket);
    const clientClosed = await settlesWithin(closeOf(clientSocket));
    expect({ clientClosed, complete: response.complete }).toEqual({ clientClosed: true, complete: false });
  });

  it('settles the client response when the origin fails after part of an error body', async () => {
    const origin = await startOrigin(http.createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain', 'Content-Length': '1000' });
      res.write('partial error body', () => res.socket?.resetAndDestroy());
    }));
    const req = proxiedRequest(await startProxy(), origin, { method: 'GET' });
    req.end();
    const response = await responseOf(req);
    response.resume();
    expect(await settlesWithin(closeOf(response)), 'client response never settled').toBe(true);
  });
});

describe('plain forwarded HTTP round trips', () => {
  it('answers with a completed bad gateway response when the origin refuses the connection', async () => {
    const origin: Origin = { port: await refusedPort(), firstConnection: new Promise(ignore) };
    const req = proxiedRequest(await startProxy(), origin, { method: 'GET' });
    req.end();
    const response = await responseOf(req);
    response.resume();
    await within(closeOf(response), 'bad gateway response never finished');
    expect({ status: response.statusCode, complete: response.complete }).toEqual({ status: 502, complete: true });
  });

  it('serves complete responses and keeps the client connection reusable for a second request', async () => {
    const origin = await startOrigin(http.createServer((req, res) => res.end(`path ${req.url}`)));
    const route = { agent: clientAgent(), proxyPort: await startProxy(), origin };
    const first = await exchange(route, '/first');
    const second = await exchange(route, '/second');
    expect([first, second]).toEqual([
      { status: 200, body: 'path /first', reused: false },
      { status: 200, body: 'path /second', reused: true },
    ]);
  });

  it('leaves no idle origin socket after a completed response while the client keeps its connection', async () => {
    const server = http.createServer((req, res) => res.end(`path ${req.url}`));
    server.keepAliveTimeout = 60_000;
    const origin = await startOrigin(server);
    const agent = clientAgent();
    const answer = await exchange({ agent, proxyPort: await startProxy(), origin }, '/done');
    const originClosed = await settlesWithin((await origin.firstConnection).closed);
    const clientConnectionsKept = Object.values(agent.freeSockets).flat().filter(socket => socket && !socket.destroyed).length;
    expect({ answer, originClosed, clientConnectionsKept }).toEqual({
      answer: { status: 200, body: 'path /done', reused: false }, originClosed: true, clientConnectionsKept: 1,
    });
  });
});

describe('CONNECT tunnel connection lifecycle', () => {
  it.each(clientDisconnects)('closes the origin socket when the client %s', async (_label, disconnect) => {
    const { client, upstream } = await establishTunnel();
    disconnect(client);
    expect(await settlesWithin(upstream.closed), 'origin socket stayed open after the client left').toBe(true);
  });

  it.each(originFailures)('closes the client socket when the origin %s', async (_label, fail) => {
    const { client, upstream } = await establishTunnel();
    fail(upstream.socket);
    expect(await settlesWithin(closeOf(client)), 'client socket stayed open after the origin left').toBe(true);
  });

  it('carries the origin reply after the client half-closes, then closes both sides', async () => {
    const { client, upstream } = await establishTunnel({ allowHalfOpen: true });
    const originRead = readToEnd(upstream.socket);
    const clientRead = readToEnd(client);
    client.end('request');
    const request = await within(originRead, 'origin never saw the client half-close');
    upstream.socket.end('reply');
    const reply = await within(clientRead, 'client never received the reply after its half-close');
    const closed = await settlesWithin(Promise.all([upstream.closed, closeOf(client)]));
    expect({ request, reply, closed }).toEqual({ request: 'request', reply: 'reply', closed: true });
  });

  it('delivers the final origin bytes after the origin half-closes, then closes both sides', async () => {
    const { client, upstream } = await establishTunnel({ allowHalfOpen: true });
    const clientRead = readToEnd(client);
    upstream.socket.end('goodbye');
    const final = await within(clientRead, 'client never saw the origin half-close');
    const closed = await settlesWithin(Promise.all([upstream.closed, closeOf(client)]));
    expect({ final, closed }).toEqual({ final: 'goodbye', closed: true });
  });
});
