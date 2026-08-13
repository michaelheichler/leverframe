// tests/proxy.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aliasModelId, isTransientSdkStreamFailure, startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { getProxyDebugLogPath } from '../src/trace-log.js';
import { buildClaudeCodeBillingSystemLine } from '../src/oauth/claude-identity.js';
import { anthropicMessagesEndpoint, estimateAnthropicInputTokens } from '../src/anthropic-endpoints.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-proxy');

vi.mock('../src/registry/url-security.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/registry/url-security.js')>();
  return {
    ...actual,
    revalidateCustomEndpointUrl: vi.fn(async (url: string) => ({ ok: true, normalizedUrl: url })),
  };
});

/** POST JSON to a local proxy via node:http (avoids vi.stubGlobal('fetch') interception). */
function postToProxy(
  port: number,
  token: string,
  body: unknown,
  relayRequestId?: string,
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
          ...(relayRequestId ? { 'x-relay-request-id': relayRequestId } : {}),
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

describe('Anthropic endpoint routing', () => {
  it('matches messages and count_tokens exactly, including query strings', () => {
    expect(anthropicMessagesEndpoint('/v1/messages?beta=true')).toBe('messages');
    expect(anthropicMessagesEndpoint('/v1/messages/count_tokens?beta=true')).toBe('count_tokens');
    expect(anthropicMessagesEndpoint('/v1/messages/batches')).toBeNull();
    expect(anthropicMessagesEndpoint('/v1/messages-not-real')).toBeNull();
  });

  it('estimates only input-context fields', () => {
    const base = estimateAnthropicInputTokens({
      model: 'leverframe:test:model',
      messages: [{ role: 'user', content: 'hello world' }],
    });
    expect(base).toBeGreaterThan(0);
    expect(estimateAnthropicInputTokens({
      model: 'a-different-model',
      stream: true,
      max_tokens: 128_000,
      messages: [{ role: 'user', content: 'hello world' }],
    })).toBe(base);
  });

  it('weights JSON structural overhead lower than prose text (two-weight estimate)', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(200);
    const body = {
      model: 'leverframe:test:model',
      system: text,
      messages: [
        { role: 'user', content: text },
        { role: 'assistant', content: text },
      ],
    };
    const contextBody = { system: body.system, messages: body.messages };
    const serializedBytes = Buffer.byteLength(JSON.stringify(contextBody), 'utf8');
    const textBytes = Buffer.byteLength(text, 'utf8') * 3; // system + 2 message contents
    const oldFormula = Math.ceil(serializedBytes / 4);
    const textFloor = Math.ceil(textBytes / 4);

    const estimate = estimateAnthropicInputTokens(body);

    // The new two-weight formula must land strictly between the old
    // bytes/4-over-everything estimate (over-counts JSON structure) and the
    // pure-text bytes/4 floor (would ignore structure entirely).
    expect(estimate).toBeLessThan(oldFormula);
    expect(estimate).toBeGreaterThan(textFloor);
  });

  it('counts images at a flat vision estimate instead of base64 bytes/4', () => {
    const data = 'A'.repeat(400_000);
    const withImage = estimateAnthropicInputTokens({
      messages: [{ role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
        ] },
      ] }],
    });
    // bytes/4 on the raw payload alone would be ~100k tokens
    expect(withImage).toBeLessThan(5_000);
    expect(withImage).toBeGreaterThanOrEqual(1_600);
  });
});

describe('aliasModelId', () => {
  it('returns claude-* ids unchanged', () => {
    expect(aliasModelId('claude-sonnet-4', 'Anthropic')).toBe('claude-sonnet-4');
  });

  it('prefixes non-claude ids with anthropic-{providerId}__', () => {
    expect(aliasModelId('grok-4.3', 'xai')).toBe('anthropic-xai__grok-4.3');
  });

  it('uses stable provider id slug in alias', () => {
    expect(aliasModelId('deepseek-v4', 'go')).toBe('anthropic-go__deepseek-v4');
  });
});

describe('isTransientSdkStreamFailure', () => {
  it('classifies a reasoning-part-not-found error as retryable', () => {
    expect(isTransientSdkStreamFailure(new Error('reasoning part reasoning-42 not found'))).toBe(true);
  });

  it('does not classify a text-part-not-found error as retryable (out of this fix\'s scope)', () => {
    expect(isTransientSdkStreamFailure(new Error('text part msg-9 not found'))).toBe(false);
  });

  it('does not classify an unrelated error as retryable', () => {
    expect(isTransientSdkStreamFailure(new Error('rate limited'))).toBe(false);
  });
});

describe('SDK anonymous route handling', () => {
  it('does not reject empty upstream keys before SDK routing', async () => {
    const route: ProxyRoute = {
      aliasId: 'anthropic-kilo__tencent/hy3:free',
      realModelId: 'tencent/hy3:free',
      displayName: 'Tencent Hy3',
      upstreamUrl: '',
      apiKey: '',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-for-test',
      baseURL: 'https://api.kilo.ai/api/gateway',
      providerId: 'kilo',
    };

    const handle = await startProxyCatalog([route], route.aliasId, false);
    const res = await postToProxy(handle.port, handle.token, {
      model: route.aliasId,
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });

    handle.close();
    expect(res.status).toBe(502);
    expect(res.body).not.toContain('Missing API key');
  });
});

describe('catalog model aliases', () => {
  it('routes alias names to their target route without rewriting the requested model id', async () => {
    const defaultRoute: ProxyRoute = {
      aliasId: 'leverframe:test:default-model',
      realModelId: 'default-model',
      displayName: 'Default Model',
      upstreamUrl: '',
      apiKey: '',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-that-must-not-load',
      providerId: 'test-provider',
    };
    const aliasTarget: ProxyRoute = {
      aliasId: 'leverframe:openai-oauth:gpt-5.6-sol',
      realModelId: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      upstreamUrl: 'https://upstream-sol.example',
      apiKey: 'provider-key',
      modelFormat: 'anthropic',
      providerId: 'openai-oauth',
    };
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'gpt-5.6-sol',
        content: [{ type: 'text', text: 'The upstream model is gpt-5.6-sol.' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await startProxyCatalog(
      [defaultRoute, aliasTarget],
      defaultRoute.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      [{ name: 'sol', routeId: aliasTarget.aliasId }],
    );

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: 'sol',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });

      // Resolved to the alias target (not the default route's missing SDK → 502)
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toContain('upstream-sol.example');
      expect(JSON.parse(init.body as string).model).toBe('gpt-5.6-sol');
      expect(JSON.parse(res.body)).toMatchObject({
        model: 'sol',
        content: [{ text: 'The upstream model is gpt-5.6-sol.' }],
      });

      // GET /v1/models/<alias> resolves too
      const modelLookup = await new Promise<number>((resolve, reject) => {
        http.get(
          { hostname: '127.0.0.1', port: handle.port, path: '/v1/models/sol' },
          res2 => { res2.resume(); resolve(res2.statusCode ?? 0); },
        ).on('error', reject);
      });
      expect(modelLookup).toBe(200);
    } finally {
      handle.close();
    }
  });

  it('echoes an alias in streaming Anthropic passthrough events without rewriting content text', async () => {
    const route: ProxyRoute = {
      aliasId: 'leverframe:anthropic:claude-sonnet-4-6',
      realModelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      upstreamUrl: 'https://api.anthropic.com',
      apiKey: 'provider-key',
      modelFormat: 'anthropic',
      providerId: 'anthropic',
    };
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"The upstream model is claude-sonnet-4-6."}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const encoded = new TextEncoder().encode(sse);
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoded.slice(0, 73));
        controller.enqueue(encoded.slice(73, 161));
        controller.enqueue(encoded.slice(161));
        controller.close();
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    const handle = await startProxyCatalog(
      [route],
      route.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      [{ name: 'sonnet', routeId: route.aliasId }],
    );

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: 'sonnet',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      const events = res.body
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => JSON.parse(line.slice('data: '.length)));

      expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).model).toBe('claude-sonnet-4-6');
      expect(events[0].message.model).toBe('sonnet');
      expect(events[1].delta.text).toBe('The upstream model is claude-sonnet-4-6.');
    } finally {
      handle.close();
    }
  });

  it('echoes a canonical route id unchanged for Anthropic passthrough', async () => {
    const route: ProxyRoute = {
      aliasId: 'leverframe:anthropic:claude-sonnet-4-6',
      realModelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      upstreamUrl: 'https://api.anthropic.com',
      apiKey: 'provider-key',
      modelFormat: 'anthropic',
      providerId: 'anthropic',
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: route.realModelId,
      content: [{ type: 'text', text: `Canonical upstream content names ${route.realModelId}.` }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const handle = await startProxyCatalog([route], route.aliasId, false);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });

      expect(JSON.parse(res.body)).toMatchObject({
        model: route.aliasId,
        content: [{ text: `Canonical upstream content names ${route.realModelId}.` }],
      });
    } finally {
      handle.close();
    }
  });

  it('ignores aliases whose target route is absent', async () => {
    const route: ProxyRoute = {
      aliasId: 'leverframe:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: '',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-that-must-not-load',
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog(
      [route],
      route.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      [{ name: 'ghost', routeId: 'leverframe:test:not-a-route' }],
    );

    try {
      const status = await new Promise<number>((resolve, reject) => {
        http.get(
          { hostname: '127.0.0.1', port: handle.port, path: '/v1/models/ghost' },
          res2 => { res2.resume(); resolve(res2.statusCode ?? 0); },
        ).on('error', reject);
      });
      expect(status).toBe(404);
    } finally {
      handle.close();
    }
  });
});

describe('token counting', () => {
  it('returns a local estimate for translated routes without loading or invoking the provider', async () => {
    const route: ProxyRoute = {
      aliasId: 'leverframe:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: '',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-that-must-not-load',
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        messages: [{ role: 'user', content: 'count this context locally' }],
      }, undefined, '/v1/messages/count_tokens?beta=true');

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ input_tokens: expect.any(Number) });
      expect(JSON.parse(res.body).input_tokens).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });

  it('forwards native Anthropic token counts with the real upstream model id', async () => {
    const fetchMock = vi.fn(async () => new Response('{"input_tokens":17}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const route: ProxyRoute = {
      aliasId: 'leverframe:anthropic:sonnet',
      realModelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      upstreamUrl: 'https://api.anthropic.com',
      apiKey: 'provider-key',
      modelFormat: 'anthropic',
      providerId: 'anthropic',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        messages: [{ role: 'user', content: 'count upstream' }],
      }, undefined, '/v1/messages/count_tokens');

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ input_tokens: 17 });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages/count_tokens',
        expect.objectContaining({
          body: expect.stringContaining('"model":"claude-sonnet-4-6"'),
        }),
      );
    } finally {
      handle.close();
      vi.unstubAllGlobals();
    }
  });
});

describe('translated request cancellation', () => {
  it('aborts the SDK provider request and records translation cancellation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-sdk-cancel-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    let upstreamReceivedResolve!: () => void;
    const upstreamReceived = new Promise<void>(resolve => { upstreamReceivedResolve = resolve; });
    let upstreamClosedResolve!: () => void;
    const upstreamClosed = new Promise<void>(resolve => { upstreamClosedResolve = resolve; });
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.once('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        upstreamReceivedResolve();
      });
      req.socket.once('close', upstreamClosedResolve);
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('test upstream did not bind');

    const route: ProxyRoute = {
      aliasId: 'leverframe:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const payload = JSON.stringify({
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'cancel this request' }],
        stream: true,
      });
      const request = http.request({
        hostname: '127.0.0.1',
        port: handle.port,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${handle.token}`,
          'Content-Length': Buffer.byteLength(payload),
          'x-relay-request-id': 'req-cancel-1',
        },
      });
      request.on('error', () => {});
      request.end(payload);
      await upstreamReceived;
      request.destroy();
      await upstreamClosed;

      await vi.waitFor(() => {
        const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(entries).toContainEqual(expect.objectContaining({
          event: 'translation_cancelled',
          requestId: 'req-cancel-1',
          phase: 'translating',
        }));
      });
    } finally {
      handle.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('SDK translated error logging', () => {
  it('returns an HTTP error when request translation throws instead of leaving the client pending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-sdk-translation-error-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    const route: ProxyRoute = {
      aliasId: 'leverframe:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: 'http://127.0.0.1:1/v1',
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: {},
        stream: true,
      }, 'req-translate-error');

      expect(res.status).toBe(502);
      expect(res.body).toContain('error');
      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_failed',
        requestId: 'req-translate-error',
        phase: 'preparing_translation',
        sdkParts: 0,
        translatedBytes: 0,
      }));
    } finally {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves a pre-stream HTTP failure and logs the AI SDK response body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-sdk-error-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    const previousRequestPreview = process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'];
    process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'] = '1';
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(400, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({ error: { message: 'translated request rejected', type: 'invalid_request_error' } }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('test upstream did not bind');

    const route: ProxyRoute = {
      aliasId: 'leverframe:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }, 'req-error-1');

      expect(res.status).toBe(400);
      expect(res.body).toContain('translated request rejected');
      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const errorEntry = entries.find(entry => entry.event === 'upstream_error');
      expect(errorEntry).toMatchObject({
        event: 'upstream_error',
        requestId: 'req-error-1',
        modelId: route.aliasId,
        provider: 'test-provider',
        route: 'translated',
        statusCode: 400,
        isRetryable: false,
        attemptCount: 1,
      });
      expect(errorEntry.errorContent).toContain('translated request rejected');
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_dispatched',
        requestId: 'req-error-1',
        phase: 'waiting_for_sdk',
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_started',
        requestId: 'req-error-1',
        lastPartType: 'start',
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_failed',
        requestId: 'req-error-1',
        lastPartType: 'error',
      }));
    } finally {
      if (previousRequestPreview === undefined) delete process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'];
      else process.env['LEVERFRAME_LOG_REQUEST_PREVIEW'] = previousRequestPreview;
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('translates an OpenAI context overflow into an Anthropic prompt-too-long error', async () => {
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(400, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({
        error: {
          message: 'Your input exceeds the context window of this model. Please adjust your input and try again.',
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
        },
      }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('test upstream did not bind');

    const route: ProxyRoute = {
      aliasId: 'leverframe:test:small-context',
      realModelId: 'small-context',
      displayName: 'Small Context Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
      contextWindow: 10,
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'This prompt is too long.' }],
        stream: true,
      }, 'req-context-overflow');

      expect(res.status).toBe(400);
      const body = JSON.parse(res.body) as {
        type: string;
        error: { type: string; message: string };
        request_id: string;
      };
      expect(body).toMatchObject({
        type: 'error',
        error: { type: 'invalid_request_error' },
        request_id: 'req-context-overflow',
      });
      expect(body.error.message).toMatch(/^prompt is too long: \d+ tokens > 10 maximum$/);
    } finally {
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }, 20_000);

  it('streams a Claude Code compact request as text with upstream tools disabled', async () => {
    let upstreamRequest: Record<string, unknown> | undefined;
    const upstream = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        upstreamRequest = JSON.parse(body) as Record<string, unknown>;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
        res.end([
          'data: {"id":"chatcmpl-compact","object":"chat.completion.chunk","created":1,"model":"translated-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Compact summary"},"finish_reason":null}]}',
          '',
          'data: {"id":"chatcmpl-compact","object":"chat.completion.chunk","created":1,"model":"translated-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'));
      });
    });
    let handle: Awaited<ReturnType<typeof startProxyCatalog>> | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        upstream.once('error', reject);
        upstream.listen(0, '127.0.0.1', () => resolve());
      });
      const address = upstream.address();
      if (!address || typeof address === 'string') throw new Error('test upstream did not bind');
      const route: ProxyRoute = {
        aliasId: 'leverframe:test:compact-model',
        realModelId: 'translated-model',
        displayName: 'Compact Model',
        upstreamUrl: '',
        apiKey: 'provider-key',
        modelFormat: 'openai',
        npm: '@ai-sdk/openai-compatible',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        providerId: 'test-provider',
      };
      handle = await startProxyCatalog([route], route.aliasId, false);
      const compactInstruction = [
        'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.',
        'Your task is to create a detailed summary of the conversation so far.',
        'REMINDER: Do NOT call any tools. Respond with plain text only.',
      ].join('\n');
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: compactInstruction }],
        tools: [
          { name: 'Read', input_schema: { type: 'object' } },
          { name: 'StructuredOutput', input_schema: { type: 'object' } },
        ],
        tool_choice: { type: 'any' },
        stream: true,
      });

      expect(res.status).toBe(200);
      expect(upstreamRequest?.tool_choice).toBe('none');
      const events = res.body
        .split('\n\n')
        .filter(block => block.startsWith('event: '))
        .map(block => {
          const [eventLine, dataLine] = block.split('\n');
          return {
            event: eventLine!.replace('event: ', ''),
            data: JSON.parse(dataLine!.replace('data: ', '')) as Record<string, unknown>,
          };
        });
      expect(events.map(event => event.event)).toEqual([
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);
      expect(events.some(event => event.data.type === 'content_block_start'
        && (event.data.content_block as { type?: unknown } | undefined)?.type === 'tool_use')).toBe(false);
      expect(events.some(event => event.data.type === 'message_delta'
        && (event.data.delta as { stop_reason?: unknown } | undefined)?.stop_reason === 'tool_use')).toBe(false);
      const messageDelta = events.find(event => event.event === 'message_delta');
      expect(messageDelta).toBeDefined();
      expect((messageDelta!.data.delta as { stop_reason?: unknown }).stop_reason).toBe('end_turn');
    } finally {
      handle?.close();
      if (upstream.listening) await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }, 20_000);

  it('logs SDK input and translated output through successful stream completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-sdk-success-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
      res.end([
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"translated-model","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}',
        '',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"translated-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('test upstream did not bind');

    const route: ProxyRoute = {
      aliasId: 'leverframe:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const requestBody = {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      };
      const countResponse = await postToProxy(
        handle.port,
        handle.token,
        requestBody,
        undefined,
        '/v1/messages/count_tokens',
      );
      const expectedInputTokens = JSON.parse(countResponse.body).input_tokens;
      const res = await postToProxy(handle.port, handle.token, requestBody, 'req-success-1');

      expect(res.status).toBe(200);
      expect(res.body).toContain('event: message_stop');
      const messageStartBlock = res.body
        .split('\n\n')
        .find(block => block.startsWith('event: message_start'))!;
      const messageStart = JSON.parse(messageStartBlock.split('\n')[1]!.replace('data: ', ''));
      expect(messageStart.message.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
      const messageDeltaBlock = res.body
        .split('\n\n')
        .find(block => block.startsWith('event: message_delta'))!;
      const messageDelta = JSON.parse(messageDeltaBlock.split('\n')[1]!.replace('data: ', ''));
      expect(messageDelta.usage).toEqual({
        input_tokens: expectedInputTokens,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_dispatched',
        requestId: 'req-success-1',
        phase: 'waiting_for_sdk',
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_started',
        requestId: 'req-success-1',
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_completed',
        requestId: 'req-success-1',
        lastPartType: 'finish',
      }));
      const completed = entries.find(entry => entry.event === 'translation_completed');
      expect(completed.sdkParts).toBeGreaterThan(0);
      expect(completed.translatedBytes).toBeGreaterThan(0);
      expect(completed.translatedChunks).toBeGreaterThan(0);
    } finally {
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('logs dispatch and completion for a non-streaming translated request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-sdk-nonstream-'));
    const inferenceLogPath = join(dir, 'inference.jsonl');
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({
        id: 'chatcmpl-nonstream',
        object: 'chat.completion',
        created: 1,
        model: 'translated-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('test upstream did not bind');
    const route: ProxyRoute = {
      aliasId: 'leverframe:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai-compatible',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false, inferenceLogPath);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: route.aliasId,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }, 'req-nonstream-1');

      expect(res.status).toBe(200);
      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_dispatched',
        requestId: 'req-nonstream-1',
        phase: 'waiting_for_sdk',
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'translation_completed',
        requestId: 'req-nonstream-1',
        phase: 'waiting_for_sdk',
      }));
    } finally {
      handle.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('anthropic passthrough debug logging', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('adopts a refreshed OAuth credential without mutating the shared route DTO', async () => {
    const route: ProxyRoute = {
      aliasId: 'claude-refresh-test',
      realModelId: 'claude-refresh-test',
      displayName: 'Claude Refresh Test',
      upstreamUrl: 'https://api.anthropic.com',
      apiKey: 'token-a',
      modelFormat: 'anthropic',
      providerId: 'claude-code',
      authType: 'oauth',
      refreshToken: vi.fn(async () => 'token-b'),
    };
    const credentials: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization') ?? '';
      credentials.push(authorization);
      if (authorization === 'Bearer token-a') {
        return new Response('{"error":{"type":"authentication_error"}}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{"type":"message","model":"claude-refresh-test"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const handle = await startProxyCatalog([route], route.aliasId);
    const request = {
      model: route.aliasId,
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    };

    try {
      const first = await postToProxy(handle.port, handle.token, request);
      const second = await postToProxy(handle.port, handle.token, request);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(credentials).toEqual(['Bearer token-a', 'Bearer token-b', 'Bearer token-b']);
      expect(route.apiKey).toBe('token-a');
      expect(route.refreshToken).toHaveBeenCalledOnce();
    } finally {
      await handle.close();
    }
  });

  it('logs upstream non-OK status and body', async () => {
    const route: ProxyRoute = {
      aliasId: 'claude-sonnet-4-6',
      realModelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      upstreamUrl: 'https://api.anthropic.com',
      apiKey: 'oauth-token',
      modelFormat: 'anthropic',
      providerId: 'claude-code',
      authType: 'oauth',
      providerData: {},
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ error: { type: 'rate_limit_error', message: 'rate limit exceeded' } }),
    }));

    const handle = await startProxyCatalog([route], route.aliasId, true);
    const res = await postToProxy(handle.port, handle.token, {
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

    handle.close();
    expect(res.status).toBe(429);
    const log = readFileSync(getProxyDebugLogPath(), 'utf8');
    expect(log).toContain('anthropic upstream 429');
    expect(log).toContain('rate limit exceeded');
  });

  it('forwards matching Claude Code OAuth session id in body metadata and header', async () => {
    const route: ProxyRoute = {
      aliasId: 'claude-sonnet-4-6',
      realModelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      upstreamUrl: 'https://api.anthropic.com',
      apiKey: 'oauth-token',
      modelFormat: 'anthropic',
      providerId: 'claude-code',
      authType: 'oauth',
      providerData: {
        cliUserID: 'a'.repeat(64),
        accountUUID: '11111111-1111-4111-8111-111111111111',
      },
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ error: { type: 'rate_limit_error', message: 'rate limit exceeded' } }),
    }));

    const handle = await startProxyCatalog([route], route.aliasId, true);
    await postToProxy(handle.port, handle.token, {
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

    handle.close();
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(String(init?.body)) as { metadata?: { user_id?: string } };
    const userId = JSON.parse(body.metadata!.user_id!) as { session_id: string };
    expect(headers['X-Claude-Code-Session-Id']).toBe(userId.session_id);
  });

  it('prepends Claude Code OAuth billing line to upstream system prompt', async () => {
    const route: ProxyRoute = {
      aliasId: 'claude-sonnet-4-6',
      realModelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      upstreamUrl: 'https://api.anthropic.com',
      apiKey: 'oauth-token',
      modelFormat: 'anthropic',
      providerId: 'claude-code',
      authType: 'oauth',
      providerData: {
        cliUserID: 'a'.repeat(64),
        accountUUID: '11111111-1111-4111-8111-111111111111',
      },
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ type: 'message', content: [] }),
      text: async () => JSON.stringify({ type: 'message', content: [] }),
    }));

    const handle = await startProxyCatalog([route], route.aliasId, false);
    await postToProxy(handle.port, handle.token, {
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      system: [{ type: 'text', text: 'You are helpful.' }],
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });

    handle.close();
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as { system?: Array<{ type: string; text: string }> };
    expect(body.system?.[0]?.text).toBe(buildClaudeCodeBillingSystemLine());
    expect(body.system?.[0]?.text).toMatch(/^x-anthropic-billing-header: cc_version=2\.1\.195\.0; cc_entrypoint=[\w-]+;$/);
    expect(body.system?.[1]?.text).toBe('You are helpful.');
  });
});

describe('malformed request handling', () => {
  it('returns 400 for non-string model field instead of hanging', async () => {
    const route: ProxyRoute = {
      aliasId: 'leverframe:test:default-model',
      realModelId: 'default-model',
      displayName: 'Default Model',
      upstreamUrl: '',
      apiKey: '',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-that-must-not-load',
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: 42,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain('must be a string');
    } finally {
      handle.close();
    }
  });

  it('returns 400 for a model field that is an object', async () => {
    const route: ProxyRoute = {
      aliasId: 'leverframe:test:default-model',
      realModelId: 'default-model',
      displayName: 'Default Model',
      upstreamUrl: '',
      apiKey: '',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-that-must-not-load',
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: { nested: 'object' },
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      expect(res.status).toBe(400);
    } finally {
      handle.close();
    }
  });

  it('falls back to the default route when model field is missing', async () => {
    const route: ProxyRoute = {
      aliasId: 'leverframe:test:default-model',
      realModelId: 'default-model',
      displayName: 'Default Model',
      upstreamUrl: '',
      apiKey: '',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-that-must-not-load',
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      expect(res.status).toBe(502);
    } finally {
      handle.close();
    }
  });

  it('rejects an unrecognized model id instead of silently bypassing to the default route (upstream 383f464)', async () => {
    const defaultRoute: ProxyRoute = {
      aliasId: 'leverframe:test:default-model',
      realModelId: 'default-model',
      displayName: 'Default Model',
      upstreamUrl: 'https://default.invalid',
      apiKey: 'default-key',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-that-must-not-load',
      providerId: 'default-provider',
    };
    const otherRoute: ProxyRoute = {
      aliasId: 'leverframe:test:other-model',
      realModelId: 'other-model',
      displayName: 'Other Model',
      upstreamUrl: 'https://other.invalid',
      apiKey: 'other-key',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-that-must-not-load',
      providerId: 'other-provider',
    };
    const handle = await startProxyCatalog([defaultRoute, otherRoute], defaultRoute.aliasId, false);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: 'leverframe:test:stale-alias-that-was-removed',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      // Must be rejected outright, never silently rerouted to defaultRoute
      // (which would send the request, and its credentials, to a provider
      // the caller never selected).
      expect(res.status).toBe(404);
      expect(res.body).toMatch(/Unknown model/);
    } finally {
      handle.close();
    }
  });

  it('rejects an explicit unknown model instead of falling back across routes', async () => {
    const route: ProxyRoute = {
      aliasId: 'leverframe:test:default-model',
      realModelId: 'default-model',
      displayName: 'Default Model',
      upstreamUrl: '',
      apiKey: '',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-that-must-not-load',
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);

    try {
      const res = await postToProxy(handle.port, handle.token, {
        model: 'leverframe:another-provider:not-configured',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({
        type: 'error',
        error: {
          type: 'not_found_error',
          message: 'Unknown model: leverframe:another-provider:not-configured',
        },
      });
    } finally {
      handle.close();
    }
  });

  it('returns 400 for a malformed percent-encoded model lookup URL', async () => {
    const route: ProxyRoute = {
      aliasId: 'leverframe:test:default-model',
      realModelId: 'default-model',
      displayName: 'Default Model',
      upstreamUrl: '',
      apiKey: '',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-that-must-not-load',
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);

    try {
      const status = await new Promise<number>((resolve, reject) => {
        http.get(
          { hostname: '127.0.0.1', port: handle.port, path: '/v1/models/%ZZ' },
          res => { res.resume(); resolve(res.statusCode ?? 0); },
        ).on('error', reject);
      });
      expect(status).toBe(400);
    } finally {
      handle.close();
    }
  });

  it.each([
    ['null', 'null'],
    ['array', '[1, 2, 3]'],
    ['string', '"just a string"'],
    ['number', '42'],
    ['boolean', 'true'],
  ])('returns 400 when the JSON body is %s, not an object', async (_label, payload) => {
    const route: ProxyRoute = {
      aliasId: 'leverframe:test:default-model',
      realModelId: 'default-model',
      displayName: 'Default Model',
      upstreamUrl: '',
      apiKey: '',
      modelFormat: 'openai',
      npm: 'missing-sdk-provider-that-must-not-load',
      providerId: 'test-provider',
    };
    const handle = await startProxyCatalog([route], route.aliasId, false);

    try {
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: handle.port,
            path: '/v1/messages',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${handle.token}`,
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
      expect(res.status).toBe(400);
      expect(res.body).toContain('must be a JSON object');
    } finally {
      handle.close();
    }
  });
});
