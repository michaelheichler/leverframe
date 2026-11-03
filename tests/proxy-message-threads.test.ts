import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-proxy-threads');

vi.mock('../src/registry/url-security.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/registry/url-security.js')>();
  return {
    ...actual,
    revalidateCustomEndpointUrl: vi.fn(async (url: string) => ({ ok: true, normalizedUrl: url })),
  };
});

const openAiCompletion = {
  id: 'chatcmpl-thread-test',
  object: 'chat.completion',
  created: 1,
  model: 'translated-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

const anthropicMessage = {
  id: 'msg_thread_test',
  type: 'message',
  role: 'assistant',
  model: 'native-model',
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 1 },
};

interface FakeUpstream {
  port: number;
  receivedPaths: string[];
  close: () => Promise<void>;
}

async function startFakeUpstream(reply: unknown): Promise<FakeUpstream> {
  const receivedPaths: string[] = [];
  const server = http.createServer((req, res) => {
    receivedPaths.push(req.url ?? '');
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
    res.end(JSON.stringify(reply));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake upstream did not bind');
  return {
    port: address.port,
    receivedPaths,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function openAiFormatRoute(port: number): ProxyRoute {
  return {
    aliasId: 'leverframe:test:translated-model',
    realModelId: 'translated-model',
    displayName: 'Translated Model',
    upstreamUrl: '',
    apiKey: randomUUID(),
    modelFormat: 'openai',
    npm: '@ai-sdk/openai-compatible',
    baseURL: `http://127.0.0.1:${port}/v1`,
    providerId: 'test-provider',
  };
}

function anthropicFormatRoute(port: number): ProxyRoute {
  return {
    aliasId: 'leverframe:test:native-model',
    realModelId: 'native-model',
    displayName: 'Native Model',
    upstreamUrl: `http://127.0.0.1:${port}`,
    apiKey: randomUUID(),
    modelFormat: 'anthropic',
    providerId: 'test-provider',
  };
}

function messagesRequest(model: string, thread?: object): object {
  return {
    model,
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
    ...(thread ? { thread } : {}),
  };
}

function postToProxy(port: number, token: string, body: object): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function sendThroughProxy(route: ProxyRoute, body: object): Promise<{ status: number; body: string }> {
  const handle = await startProxyCatalog([route], route.aliasId, false);
  try {
    return await postToProxy(handle.port, handle.token, body);
  } finally {
    handle.close();
  }
}

describe('message thread requests on translated routes', () => {
  it.each([
    ['continue', { type: 'continue', previous_message_id: 'msg_x' }],
    ['create', { type: 'create' }],
  ])('rejects a thread %s request with an Anthropic 400 before contacting the upstream', async (_kind, thread) => {
    const upstream = await startFakeUpstream(openAiCompletion);
    const route = openAiFormatRoute(upstream.port);
    try {
      const res = await sendThroughProxy(route, messagesRequest(route.aliasId, thread));

      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: expect.stringContaining('message threads are not supported'),
        },
      });
      expect(upstream.receivedPaths).toEqual([]);
    } finally {
      await upstream.close();
    }
  }, 20_000);

  it('translates a stateless request without a thread to the upstream', async () => {
    const upstream = await startFakeUpstream(openAiCompletion);
    const route = openAiFormatRoute(upstream.port);
    try {
      const res = await sendThroughProxy(route, messagesRequest(route.aliasId));

      expect(res.status).toBe(200);
      expect(upstream.receivedPaths).toHaveLength(1);
    } finally {
      await upstream.close();
    }
  }, 20_000);
});

describe('message thread requests on anthropic-format routes', () => {
  it('forwards a thread continue request to the upstream', async () => {
    const upstream = await startFakeUpstream(anthropicMessage);
    const route = anthropicFormatRoute(upstream.port);
    try {
      const res = await sendThroughProxy(
        route,
        messagesRequest(route.aliasId, { type: 'continue', previous_message_id: 'msg_x' }),
      );

      expect(res.status).toBe(200);
      expect(upstream.receivedPaths).toHaveLength(1);
    } finally {
      await upstream.close();
    }
  }, 20_000);
});
