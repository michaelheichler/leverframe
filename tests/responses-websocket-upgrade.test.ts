import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createResponsesWebSocketFetch,
  resetResponsesWebSocketConnectionsForTests,
  type ResponsesWebSocketDiagnosticEvent,
  type ResponsesWebSocketFetchOptions,
} from '../src/oauth/responses-websocket.js';

interface UpgradeServer {
  url: string;
  attempts: number;
}

const openServers: Server[] = [];
const openSockets = new Set<Socket>();

function responseLines(
  status: number,
  body: string,
  headers: IncomingHttpHeaders,
): string[] {
  const payload = Buffer.from(body);
  return [
    `HTTP/1.1 ${status} Rejected`,
    'Connection: close',
    `Content-Length: ${payload.length}`,
    'Content-Type: application/json',
    ...Object.entries(headers).flatMap(([name, value]) => {
      if (value === undefined) return [];
      return [`${name}: ${Array.isArray(value) ? value.join(', ') : value}`];
    }),
    '',
    body,
  ];
}

async function startRejectionServer(
  status: number,
  body = '',
  headers: IncomingHttpHeaders = {},
): Promise<UpgradeServer> {
  let attempts = 0;
  const server = createServer();
  openServers.push(server);
  server.on('connection', socket => {
    openSockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => openSockets.delete(socket));
  });
  server.on('upgrade', (_request, socket) => {
    attempts += 1;
    socket.write(responseLines(status, body, headers).join('\r\n'));
    setTimeout(() => socket.end(), 10);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('rejection server did not bind');
  return {
    url: `ws://127.0.0.1:${address.port}`,
    get attempts() { return attempts; },
  };
}

async function startImmediateCloseServer(): Promise<UpgradeServer> {
  let attempts = 0;
  const server = createServer();
  openServers.push(server);
  server.on('connection', socket => {
    openSockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => openSockets.delete(socket));
  });
  server.on('upgrade', (_request, socket) => {
    attempts += 1;
    socket.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('close server did not bind');
  return {
    url: `ws://127.0.0.1:${address.port}`,
    get attempts() { return attempts; },
  };
}

async function startHangingUpgradeServer(): Promise<UpgradeServer> {
  let attempts = 0;
  const server = createServer();
  openServers.push(server);
  server.on('connection', socket => {
    openSockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => openSockets.delete(socket));
  });
  server.on('upgrade', () => {
    attempts += 1;
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('hanging server did not bind');
  return {
    url: `ws://127.0.0.1:${address.port}`,
    get attempts() { return attempts; },
  };
}

function request(
  server: UpgradeServer,
  options: ResponsesWebSocketFetchOptions = {},
): Promise<Response> {
  const fetchTransport = createResponsesWebSocketFetch(server.url, undefined, {
    providerId: 'openai',
    accountId: 'account-test',
    maxTransportRetries: 0,
    ...options,
  });
  return fetchTransport('http://local.test/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer secret-sentinel' },
    body: JSON.stringify({
      model: 'gpt-test',
      prompt_cache_key: 'session-test',
      input: [],
    }),
  });
}

afterEach(async () => {
  resetResponsesWebSocketConnectionsForTests();
  for (const socket of openSockets) socket.destroy();
  openSockets.clear();
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server?.listening) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});

describe('Responses WebSocket rejected upgrades', () => {
  it.each([
    [401, false],
    [500, true],
    [502, true],
    [503, true],
    [504, true],
    [529, true],
  ])('preserves HTTP %i as a typed upgrade failure', async (status, retryable) => {
    const server = await startRejectionServer(status);

    await expect(request(server)).rejects.toMatchObject({
      name: 'ProviderTransportError',
      phase: 'websocket_upgrade',
      httpStatus: status,
      retryable,
      outputEmitted: false,
      attemptCount: 1,
    });
    expect(server.attempts).toBe(1);
  });

  // OpenAI's edge/WAF rejects the upgrade with a bodyless HTTP 403 when the
  // account's concurrency/usage throttle trips, before the request reaches
  // the application; the only application-level 403 is a geo restriction.
  // Per OpenAI's documented error codes and the official codex client,
  // terminal conditions are 401 (re-auth) or a 429 with a JSON body, and
  // codex retries ALL 403s — so every upgrade 403 is treated as retryable,
  // body or not (stabilization plan §9.2, upstream 303db6e/32c1f7b).
  it.each([
    ['bodyless', ''],
    ['with an explanatory body', JSON.stringify({ error: 'permission denied' })],
  ])('treats an HTTP 403 upgrade rejection %s as a retryable throttle', async (_label, body) => {
    const server = await startRejectionServer(403, body);

    // Mapped to 429 (not left as 403): the real upstream failure is a
    // throttle, not a permission error, and 403 code paths elsewhere in the
    // stack (e.g. sdkUpstreamErrorDetails) treat 403 as terminal.
    await expect(request(server)).rejects.toMatchObject({
      name: 'ProviderTransportError',
      phase: 'websocket_upgrade',
      httpStatus: 429,
      retryable: true,
      outputEmitted: false,
      attemptCount: 1,
    });
    expect(server.attempts).toBe(1);
  });

  it('parses delta-seconds Retry-After and preserves safe headers', async () => {
    const server = await startRejectionServer(429, '', {
      'retry-after': '7',
      'x-request-id': 'req-delta',
      'set-cookie': ['private-cookie'],
    });

    await expect(request(server)).rejects.toMatchObject({
      httpStatus: 429,
      providerRequestId: 'req-delta',
      retryAfterMs: 7_000,
      retryable: true,
      responseHeaders: {
        'retry-after': '7',
        'x-request-id': 'req-delta',
      },
    });
  });

  it('parses HTTP-date Retry-After', async () => {
    const retryDate = new Date(Date.now() + 5_000).toUTCString();
    const server = await startRejectionServer(429, '', { 'retry-after': retryDate });

    try {
      await request(server);
      throw new Error('expected rejected upgrade');
    } catch (error) {
      expect(error).toMatchObject({ httpStatus: 429, retryable: true });
      const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
      expect(retryAfterMs).toBeTypeOf('number');
      expect(retryAfterMs).toBeGreaterThan(0);
      expect(retryAfterMs).toBeLessThanOrEqual(5_000);
    }
  });

  it.each([
    ['empty', ''],
    ['malformed', '{not-json'],
    ['oversized', 'x'.repeat(100_000)],
  ])('does not expose %s rejected response bodies', async (_label, body) => {
    const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
    const server = await startRejectionServer(502, body);

    const result = request(server, { onDiagnostic: event => diagnostics.push(event) });

    await expect(result).rejects.not.toThrow(/not-json|xxxx|secret-sentinel/);
    await vi.waitFor(() => {
      const bodyDiagnostic = diagnostics.find(event => event.event === 'ws_upgrade_response_body');
      expect(bodyDiagnostic).toBeDefined();
      if (body) expect(bodyDiagnostic?.bodyBytesObserved).toBeGreaterThan(0);
      else expect(bodyDiagnostic?.bodyBytesObserved).toBe(0);
    });
    if (body) expect(JSON.stringify(diagnostics)).not.toContain(body.slice(0, 20));
    expect(JSON.stringify(diagnostics)).not.toContain('secret-sentinel');
  });

  it('classifies a proxy-style HTTP 407 rejection without returning HTTP 200', async () => {
    const server = await startRejectionServer(407, 'proxy credentials rejected', {
      'x-request-id': 'proxy-request',
    });

    await expect(request(server)).rejects.toMatchObject({
      phase: 'websocket_upgrade',
      httpStatus: 407,
      providerRequestId: 'proxy-request',
      retryable: false,
    });
  });

  it('times out an accepted connection whose upgrade handshake never completes', async () => {
    const server = await startHangingUpgradeServer();
    const startedAt = performance.now();

    await expect(request(server, { handshakeTimeoutMs: 25 })).rejects.toMatchObject({
      name: 'ProviderTransportError',
      phase: 'connect',
      outputEmitted: false,
    });
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(server.attempts).toBe(1);
  }, 1_000);

  it('settles an immediate handshake close without waiting for the stream idle timeout', async () => {
    const server = await startImmediateCloseServer();
    const startedAt = performance.now();

    await expect(request(server)).rejects.toMatchObject({
      name: 'ProviderTransportError',
      phase: 'connect',
      outputEmitted: false,
    });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(server.attempts).toBe(1);
  });
});
