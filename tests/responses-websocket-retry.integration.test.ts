import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createResponsesWebSocketFetch,
  resetResponsesWebSocketConnectionsForTests,
} from '../src/oauth/responses-websocket.js';

interface ScriptedServer {
  url: string;
  attempts: number;
  payloads: Array<Record<string, unknown>>;
}

const servers: Server[] = [];
const sockets = new Set<Socket>();
const webSocketServers: WebSocketServer[] = [];

type RejectedStatus = number | { status: number; body: string };

async function startScriptedServer(rejectedStatuses: RejectedStatus[]): Promise<ScriptedServer> {
  let attempts = 0;
  const payloads: Array<Record<string, unknown>> = [];
  const server = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true });
  servers.push(server);
  webSocketServers.push(webSocketServer);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    attempts += 1;
    const rejected = rejectedStatuses[attempts - 1];
    if (rejected !== undefined) {
      const status = typeof rejected === 'number' ? rejected : rejected.status;
      const body = typeof rejected === 'number' ? '' : rejected.body;
      // Keep integration retries immediate; unit coverage separately asserts
      // the synthesized 5s default and 60s clamp for headerless/oversized 403s.
      const retryAfter = status === 429 || status === 403 ? 'Retry-After: 0\r\n' : '';
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\n`
        + 'Connection: close\r\n'
        + retryAfter
        + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, webSocket => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });
  webSocketServer.on('connection', webSocket => {
    webSocket.once('message', data => {
      payloads.push(JSON.parse(data.toString()) as Record<string, unknown>);
      webSocket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp-recovered' } }));
      webSocket.send(JSON.stringify({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: 'msg-recovered' },
      }));
      webSocket.send(JSON.stringify({
        type: 'response.output_text.delta',
        item_id: 'msg-recovered',
        delta: 'recovered',
      }));
      webSocket.send(JSON.stringify({
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'message', id: 'msg-recovered' },
      }));
      webSocket.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp-recovered' } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('scripted server did not bind');
  return {
    url: `ws://127.0.0.1:${address.port}`,
    get attempts() { return attempts; },
    payloads,
  };
}

async function execute(server: ScriptedServer): Promise<string> {
  const transport = createResponsesWebSocketFetch(server.url, undefined, {
    providerId: 'openai',
    maxTransportRetries: 1,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 1_000,
    random: () => 0,
  });
  const response = await transport('http://local.test/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer private-token' },
    body: JSON.stringify({
      model: 'gpt-test',
      prompt_cache_key: 'retry-session',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    }),
  });
  return response.text();
}

afterEach(async () => {
  resetResponsesWebSocketConnectionsForTests();
  for (const webSocketServer of webSocketServers.splice(0)) {
    for (const client of webSocketServer.clients) client.terminate();
    webSocketServer.close();
  }
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  while (servers.length > 0) {
    const server = servers.pop();
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe('Responses WebSocket pre-frame retry', () => {
  it.each([503, 429])('recovers once after HTTP %i before any provider frame', async status => {
    const server = await startScriptedServer([status]);

    const body = await execute(server);

    expect(body).toContain('recovered');
    expect(server.attempts).toBe(2);
    expect(server.payloads).toHaveLength(1);
    expect(server.payloads[0]).not.toHaveProperty('previous_response_id');
  });

  // Every upgrade 403 is an edge/WAF throttle signal (or, rarely, a geo
  // restriction) — never the terminal permission failure a bare status code
  // would suggest — so it recovers exactly like 429/503, body or not
  // (stabilization plan §9.2, upstream 303db6e/32c1f7b).
  it.each([
    ['bodyless', 403],
    ['with an explanatory body', { status: 403, body: JSON.stringify({ error: 'permission denied' }) }],
  ])('recovers once after an HTTP 403 throttle rejection (%s)', async (_label, rejected) => {
    const server = await startScriptedServer([rejected as RejectedStatus]);

    const body = await execute(server);

    expect(body).toContain('recovered');
    expect(server.attempts).toBe(2);
  });

  it.each([401])('does not retry terminal HTTP %i rejections', async status => {
    const server = await startScriptedServer([status]);

    await expect(execute(server)).rejects.toMatchObject({
      httpStatus: status,
      retryable: false,
      attemptCount: 1,
    });
    expect(server.attempts).toBe(1);
  });

  it('exhausts the retry budget after two transient failures', async () => {
    const server = await startScriptedServer([503, 503]);

    await expect(execute(server)).rejects.toMatchObject({
      httpStatus: 503,
      retryable: true,
      attemptCount: 2,
    });
    expect(server.attempts).toBe(2);
  });
});
