import * as http from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { RoutingNoticeChannel } from '../src/routing-notice-channel.js';

async function startChannelServer(channel: RoutingNoticeChannel, sessionId: string) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const consumerId = url.searchParams.get('consumerId') ?? '';
    if (!channel.connect(sessionId, consumerId, 0, res)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'consumer unavailable' }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('notice channel fixture did not bind');

  return {
    connect(consumerId: string) {
      return new Promise<{ status: number; closed: Promise<void>; close: () => void }>((resolve, reject) => {
        const request = http.get({ hostname: '127.0.0.1', port: address.port,
          path: `/events?consumerId=${encodeURIComponent(consumerId)}` }, response => {
          const closed = new Promise<void>(finish => response.once('close', finish));
          response.resume();
          resolve({ status: response.statusCode ?? 0, closed, close: () => request.destroy() });
        });
        request.on('error', error => {
          if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
        });
      });
    },
    close: async () => {
      channel.dispose();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

it('revokes the old stream when a session registers a replacement consumer', async () => {
  const channel = new RoutingNoticeChannel();
  const server = await startChannelServer(channel, 'channel-session');
  const original = channel.register('channel-session');

  try {
    const firstStream = await server.connect(original.consumerId);
    const firstSignal = channel.signal('channel-session');
    const replacement = channel.register('channel-session');
    const staleConnection = await server.connect(original.consumerId);
    const replacementStream = await server.connect(replacement.consumerId);

    expect(firstStream.status).toBe(200);
    expect(firstSignal?.aborted).toBe(true);
    expect(staleConnection.status).toBe(409);
    expect(replacementStream.status).toBe(200);
    expect(channel.signal('channel-session')?.aborted).toBe(false);
  } finally {
    await server.close();
  }
});

it('expires a notice consumer before accepting its stream', async () => {
  const channel = new RoutingNoticeChannel();
  const server = await startChannelServer(channel, 'expiring-channel-session');
  const registered = channel.register('expiring-channel-session');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(registered.expiresAt));

  try {
    const connection = await server.connect(registered.consumerId);

    expect(connection.status).toBe(409);
    expect(channel.signal('expiring-channel-session')).toBeUndefined();
  } finally {
    clock.mockRestore();
    await server.close();
  }
});

it('aborts active consumer signals and rejects late registration after shutdown', async () => {
  const channel = new RoutingNoticeChannel();
  const server = await startChannelServer(channel, 'shutdown-channel-session');
  const registered = channel.register('shutdown-channel-session');

  try {
    const stream = await server.connect(registered.consumerId);
    const signal = channel.signal('shutdown-channel-session');
    channel.dispose();
    await stream.closed;

    expect(signal?.aborted).toBe(true);
    expect(channel.signal('shutdown-channel-session')).toBeUndefined();
    expect(() => channel.register('shutdown-channel-session')).toThrow();
  } finally {
    await server.close();
  }
});
