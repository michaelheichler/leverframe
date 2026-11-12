import * as http from 'node:http';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createAdapterAgent } from '../src/http-proxy/adapter-agent.js';
import { createProxyServer } from '../src/http-proxy/proxy-server.js';

function operatorOutput() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    chunks.push(String(chunk));
    return true;
  });
  onTestFinished(() => spy.mockRestore());
  return () => chunks.join('').trim().split('\n').filter(Boolean);
}

async function listen(server: net.Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
}

async function heldOrigin() {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = http.createServer((_request, response) => {
    void gate.then(() => response.end('accepted'));
  });
  onTestFinished(() => { release(); server.closeAllConnections(); server.close(); });
  return { server, port: await listen(server), release };
}

function exchange(port: number, agent: http.Agent, privateValue: string) {
  const request = http.request({ host: '127.0.0.1', port, agent, method: 'POST', path: `/${privateValue}`,
    headers: { Authorization: `Bearer ${privateValue}` } });
  onTestFinished(() => { request.destroy(); });
  const done = new Promise<void>((resolve, reject) => {
    request.once('error', reject);
    request.once('response', response => {
      response.resume();
      response.once('end', resolve);
      response.once('error', reject);
    });
  });
  request.end(privateValue);
  return done;
}

async function client(port: number) {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  onTestFinished(() => { socket.destroy(); });
  await once(socket, 'connect');
  return { socket, closed };
}

async function boundedProxy(privateValue: string) {
  const sockets = new Set<net.Socket>();
  const server = createProxyServer(privateValue, new Map(), http.createServer(), sockets, undefined, { maxConnections: 1 });
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { server, port: await listen(server) };
}

it('reports an adapter queue burst once without exposing request data', async () => {
  const privateValue = randomUUID();
  const origin = await heldOrigin();
  const agent = createAdapterAgent({ maxSockets: 1 });
  onTestFinished(() => agent.destroy());
  const arrived = once(origin.server, 'request');
  const active = exchange(origin.port, agent, privateValue);
  await arrived;
  const output = operatorOutput();

  const queued = [exchange(origin.port, agent, privateValue), exchange(origin.port, agent, privateValue)];
  await setImmediate();
  origin.release();
  await Promise.all([active, ...queued]);

  expect(output()).toHaveLength(1);
  expect(output().join('\n')).not.toContain(privateValue);
});

it('reports a client connection drop burst once without exposing the proxy credential', async () => {
  const privateValue = randomUUID();
  const proxy = await boundedProxy(privateValue);
  await client(proxy.port);
  const output = operatorOutput();

  const overflow = await Promise.all([client(proxy.port), client(proxy.port)]);
  await Promise.all(overflow.map(connection => connection.closed));

  expect(output()).toHaveLength(1);
  expect(output().join('\n')).not.toContain(privateValue);
});
