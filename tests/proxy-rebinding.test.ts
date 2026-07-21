import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

vi.mock('../src/provider-factory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/provider-factory.js')>();
  return {
    ...actual,
    createLanguageModel: vi.fn(async (spec: unknown) => ({ spec })),
  };
});

vi.mock('../src/sdk-adapter.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/sdk-adapter.js')>();
  return {
    ...actual,
    generateAnthropicResponse: vi.fn(async (_model: unknown, _params: unknown, modelId: string) => ({
      id: 'msg-sdk-rebind',
      type: 'message',
      role: 'assistant',
      model: modelId,
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
  };
});

import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { createLanguageModel } from '../src/provider-factory.js';
import { generateAnthropicResponse } from '../src/sdk-adapter.js';

function postToProxy(
  port: number,
  token: string,
  body: unknown,
  path = '/v1/messages',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
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
    req.write(payload);
    req.end();
  });
}

describe('proxy per-request URL revalidation (DNS rebinding)', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('request 1 succeeds then request 2 is blocked after rebinding; credential never reaches the rebound upstream', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    lookupMock.mockImplementation(async () => [{ address: '93.184.216.34', family: 4 }]);

    const route: ProxyRoute = {
      aliasId: 'leverframe:anthropic:rebind',
      realModelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      upstreamUrl: 'https://rebind-proxy.example.com',
      apiKey: 'leak-if-forwarded',
      modelFormat: 'anthropic',
      providerId: 'anthropic',
    };

    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const first = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'first' }],
        stream: false,
      });
      expect(first.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      lookupMock.mockImplementation(async () => [{ address: '192.168.1.5', family: 4 }]);

      const second = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'second' }],
        stream: false,
      });

      expect(second.status).toBe(400);
      expect(second.body).toMatch(/revalidation/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const auths = vi.mocked(fetch).mock.calls.map(([, init]) => (init as any)?.headers?.Authorization);
      expect(auths).toEqual(['Bearer leak-if-forwarded']);
    } finally {
      handle.close();
    }
  });

  it('count_tokens request 1 succeeds then request 2 is blocked after rebinding; credential never reaches the rebound upstream', async () => {
    const fetchMock = vi.fn(async () => new Response('{"input_tokens":17}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    lookupMock.mockImplementation(async () => [{ address: '93.184.216.34', family: 4 }]);

    const route: ProxyRoute = {
      aliasId: 'leverframe:anthropic:rebind-tokens',
      realModelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      upstreamUrl: 'https://rebind-tokens.example.com',
      apiKey: 'count-credential-leak',
      modelFormat: 'anthropic',
      providerId: 'anthropic',
    };

    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const first = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        messages: [{ role: 'user', content: 'count' }],
      }, '/v1/messages/count_tokens');
      expect(first.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      lookupMock.mockImplementation(async () => [{ address: '169.254.169.254', family: 4 }]);

      const second = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        messages: [{ role: 'user', content: 'count after rebind' }],
      }, '/v1/messages/count_tokens');

      expect(second.status).toBe(400);
      expect(second.body).toMatch(/revalidation/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      handle.close();
    }
  });

  it('apiKey="local" sentinel is still gated by URL revalidation on rebinding', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    lookupMock.mockImplementation(async () => [{ address: '93.184.216.34', family: 4 }]);

    const route: ProxyRoute = {
      aliasId: 'leverframe:anthropic:local-rebind',
      realModelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      upstreamUrl: 'https://local-rebind.example.com',
      apiKey: 'local',
      modelFormat: 'anthropic',
      providerId: 'anthropic',
      authType: 'none',
    };

    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const first = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'first' }],
        stream: false,
      });
      expect(first.status).toBe(200);

      lookupMock.mockImplementation(async () => [{ address: '10.0.0.5', family: 4 }]);

      const second = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'second' }],
        stream: false,
      });

      expect(second.status).toBe(400);
      expect(second.body).toMatch(/revalidation/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const auths = vi.mocked(fetch).mock.calls.map(([, init]) => (init as any)?.headers?.Authorization);
      expect(auths).toEqual(['Bearer local']);
    } finally {
      handle.close();
    }
  });

  it('SDK translated path: request 1 hits the language-model factory once then request 2 is blocked before the cached model is reused', async () => {
    lookupMock.mockImplementation(async () => [{ address: '93.184.216.34', family: 4 }]);

    const route: ProxyRoute = {
      aliasId: 'leverframe:openai:sdk-rebind',
      realModelId: 'gpt-5.6',
      displayName: 'GPT-5.6',
      upstreamUrl: 'https://unused-sdk.example/v1/chat/completions',
      apiKey: 'sdk-credential-leak',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      baseURL: 'https://rebind-sdk-proxy.example',
      providerId: 'openai',
    };

    const handle = await startProxyCatalog([route], route.aliasId, false);
    try {
      const first = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'first' }],
        stream: false,
      });
      expect(first.status).toBe(200);
      expect(createLanguageModel).toHaveBeenCalledTimes(1);
      const firstSpec = vi.mocked(createLanguageModel).mock.calls[0]![0] as { apiKey?: string; baseURL?: string };
      expect(firstSpec.apiKey).toBe('sdk-credential-leak');
      expect(firstSpec.baseURL).toBe('https://rebind-sdk-proxy.example');
      expect(generateAnthropicResponse).toHaveBeenCalledTimes(1);

      lookupMock.mockImplementation(async () => [{ address: '169.254.169.254', family: 4 }]);

      const second = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'second' }],
        stream: false,
      });

      expect(second.status).toBe(400);
      expect(second.body).toMatch(/revalidation/i);
      expect(createLanguageModel).toHaveBeenCalledTimes(1);
      expect(generateAnthropicResponse).toHaveBeenCalledTimes(1);
    } finally {
      handle.close();
    }
  });
});
