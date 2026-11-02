/** Because native cache directives must survive adapter routing. */
import * as http from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { forwardToAdapter } from '../src/http-proxy/forward.js';
import type { ProxyHandle } from '../src/proxy.js';

async function listen(server: http.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
  return address.port;
}

it('forwards native Anthropic version, beta, and cache-marked body to a routed adapter', async () => {
  let forwarded: { version: string | undefined; beta: string | undefined; body: string } | undefined;
  const adapter = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    forwarded = {
      version: typeof req.headers['anthropic-version'] === 'string' ? req.headers['anthropic-version'] : undefined,
      beta: typeof req.headers['anthropic-beta'] === 'string' ? req.headers['anthropic-beta'] : undefined,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const adapterPort = await listen(adapter);
  const relay = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    await forwardToAdapter(
      req,
      res,
      Buffer.concat(chunks),
      { port: adapterPort, token: 'internal-adapter-sentinel', close: () => {} } satisfies ProxyHandle,
      http.request,
      new http.Agent({ keepAlive: false }),
    );
  });
  const relayPort = await listen(relay);
  const markedBody = {
    model: 'claude-cache-fixture',
    cache_control: { type: 'ephemeral', ttl: '5m' },
    system: [{ type: 'text', text: 'stable instructions', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture prompt', cache_control: { type: 'ephemeral', ttl: '5m' } }] }],
  };

  try {
    const response = await fetch(`http://127.0.0.1:${relayPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'anthropic-version': '2025-04-15',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'content-type': 'application/json',
      },
      body: JSON.stringify(markedBody),
    });

    expect(response.status).toBe(200);
    expect(forwarded).toEqual({
      version: '2025-04-15',
      beta: 'prompt-caching-2024-07-31',
      body: JSON.stringify(markedBody),
    });
  } finally {
    await new Promise<void>(resolve => relay.close(() => resolve()));
    await new Promise<void>(resolve => adapter.close(() => resolve()));
  }
});
