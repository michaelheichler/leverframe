import { createServer, type IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGatewayModelCatalog, type ServerModelInfo } from '../src/server/models.js';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { createLanguageModel } from '../src/provider-factory.js';
import { generateAnthropicResponse } from '../src/sdk-adapter.js';
import { ProviderTransportError } from '../src/provider-error.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-server-router');

vi.mock('../src/provider-factory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/provider-factory.js')>();
  return {
    ...actual,
    createLanguageModel: vi.fn(async (spec: unknown) => ({ spec })),
  };
});

vi.mock('../src/env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/env.js')>();
  return {
    ...actual,
    resolveProviderCredential: vi.fn(actual.resolveProviderCredential),
  };
});

vi.mock('../src/sdk-adapter.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/sdk-adapter.js')>();
  return {
    ...actual,
    generateAnthropicResponse: vi.fn(async (_model: unknown, _params: unknown, modelId: string) => ({
      id: 'msg-test',
      type: 'message',
      role: 'assistant',
      model: modelId,
      content: [{ type: 'text', text: 'sdk ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
  };
});

vi.mock('../src/openai-adapter.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/openai-adapter.js')>();
  return {
    ...actual,
    generateOpenAiResponse: vi.fn(async (_model: unknown, _params: unknown, modelId: string) => ({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      model: modelId,
      choices: [{ message: { content: 'openai sdk ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })),
  };
});

vi.mock('../src/registry/url-security.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/registry/url-security.js')>();
  return {
    ...actual,
    revalidateCustomEndpointUrl: vi.fn(actual.revalidateCustomEndpointUrl),
  };
});

interface UpstreamRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: any;
}

async function readRequestBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString();
  return raw ? JSON.parse(raw) : null;
}

async function startUpstream(responseBody: any): Promise<{ baseUrl: string; requests: UpstreamRequest[]; close: () => Promise<void> }> {
  const requests: UpstreamRequest[] = [];
  const server = createServer(async (req, res) => {
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: Array.isArray(req.headers.authorization)
        ? req.headers.authorization[0]
        : req.headers.authorization,
      body: await readRequestBody(req),
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing upstream address');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  };
}

const handles: Array<ServerHandle | { close: () => Promise<void> }> = [];

function model(
  id: string,
  modelFormat: ServerModelInfo['modelFormat'],
  sourceBackend: ServerModelInfo['sourceBackend'],
  urls: Partial<Pick<ServerModelInfo, 'baseUrl' | 'completionsUrl' | 'apiKey'>> = {},
): ServerModelInfo {
  return {
    id,
    name: id,
    isFree: false,
    brand: 'Other',
    sourceBackend,
    modelFormat,
    ...urls,
  };
}

function defaultCatalog(upstreamBaseUrl: string) {
  return createGatewayModelCatalog([
    model('claude-native', 'anthropic', 'zen', { baseUrl: upstreamBaseUrl }),
    model('openai-format', 'openai', 'go', { completionsUrl: `${upstreamBaseUrl}/v1/chat/completions` }),
    model('bad-format', 'unsupported', 'zen'),
  ]);
}

async function startTestServer(options: Partial<Parameters<typeof startServer>[0]> = {}): Promise<ServerHandle> {
  const upstream = await startUpstream({
    id: 'chatcmpl-test',
    choices: [{ message: { content: 'upstream ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 7 },
  });
  handles.push(upstream);

  const handle = await startServer({
    host: '127.0.0.1',
    port: 0,
    apiKey: 'real-opencode-key',
    serverPassword: null,
    catalog: defaultCatalog(upstream.baseUrl),
    ...options,
  });
  handles.push(handle);
  return handle;
}

async function closeHandle(handle: ServerHandle | { close: () => Promise<void> }): Promise<void> {
  await handle.close();
}

afterEach(async () => {
  vi.mocked(createLanguageModel).mockClear();
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle) await closeHandle(handle);
  }
});


describe("server router Anthropic routes", () => {
  it('forwards Anthropic-native messages to the backend v1/messages endpoint with the real API key', async () => {
    const upstream = await startUpstream({
      id: 'msg-test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'native ok' }],
    });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([
        model('claude-native', 'anthropic', 'zen', { baseUrl: upstream.baseUrl }),
      ]),
    });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-native', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'msg-test' });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/messages',
      authorization: 'Bearer real-opencode-key',
      body: { model: 'claude-native', messages: [{ role: 'user', content: 'hi' }] },
    });
  });

  it('rejects Anthropic messages for OpenAI-format models without an SDK provider', async () => {
    const server = await startTestServer();

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai-format',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('No SDK provider') },
    });
  });

  it('revalidates an Anthropic passthrough baseUrl at request time and blocks on DNS rebinding', async () => {
    const { revalidateCustomEndpointUrl } = await import('../src/registry/url-security.js');
    const rebindUrl = 'https://rebind.anthropic.example';
    const rebindCatalog = createGatewayModelCatalog([
      model('claude-rebind', 'anthropic', 'zen', { baseUrl: rebindUrl, apiKey: 'leak-if-forwarded' }),
    ]);
    vi.mocked(revalidateCustomEndpointUrl).mockResolvedValueOnce({
      ok: false,
      error: 'URL resolves to a private or restricted network address.',
      hint: 'Use a public HTTPS endpoint.',
    });

    const upstream = await startUpstream({ id: 'should-not-reach', content: [] });
    handles.push(upstream);
    const server = await startServer({
      host: '127.0.0.1',
      port: 0,
      apiKey: 'unused',
      serverPassword: null,
      catalog: rebindCatalog,
    });
    handles.push(server);

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-rebind',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.message).toMatch(/private|restricted/i);
    expect(upstream.requests).toHaveLength(0);
    expect(revalidateCustomEndpointUrl).toHaveBeenCalledWith(rebindUrl, expect.objectContaining({ allowInsecureLocal: false }));
    vi.mocked(revalidateCustomEndpointUrl).mockRestore();
  });

  it('returns Anthropic prompt-too-long shape for a translated context overflow', async () => {
    const contextCatalog = createGatewayModelCatalog([{
      id: 'small-context',
      name: 'Small Context',
      isFree: false,
      brand: 'Test',
      providerId: 'test-provider',
      sourceBackend: 'test-provider',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      apiKey: 'provider-key',
      contextWindow: 10,
    }]);
    vi.mocked(generateAnthropicResponse).mockRejectedValueOnce({
      statusCode: 400,
      data: {
        error: {
          code: 'context_length_exceeded',
          message: 'Your input exceeds the context window of this model.',
        },
      },
    });
    const server = await startTestServer({ catalog: contextCatalog });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-test-provider__small-context',
        messages: [{ role: 'user', content: 'This prompt is too long.' }],
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as {
      type: string;
      error: { type: string; message: string };
      request_id: string;
    };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toMatch(/^prompt is too long: \d+ tokens > 10 maximum$/);
    expect(body.request_id).toEqual(expect.any(String));
  });

  it('returns safe WebSocket status, retry, and provider request headers', async () => {
    const oauthCatalog = createGatewayModelCatalog([{
      id: 'gpt-oauth-rejected',
      name: 'GPT OAuth Rejected',
      isFree: false,
      brand: 'OpenAI',
      providerId: 'openai-oauth',
      sourceBackend: 'openai-oauth',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      authType: 'oauth',
      apiKey: 'oauth-access-token',
    }]);
    const server = await startTestServer({ catalog: oauthCatalog });
    vi.mocked(generateAnthropicResponse).mockRejectedValueOnce(new ProviderTransportError({
      provider: 'openai',
      model: 'gpt-oauth-rejected',
      phase: 'websocket_upgrade',
      httpStatus: 429,
      providerRequestId: 'provider-request-safe',
      retryAfterMs: 2_500,
      retryable: true,
      outputEmitted: false,
      safeMessage: 'Provider WebSocket upgrade was rejected.',
    }));

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-openai-oauth__gpt-oauth-rejected',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3');
    expect(response.headers.get('x-provider-request-id')).toBe('provider-request-safe');
    expect(await response.text()).not.toContain('oauth-access-token');
  });

  it('returns HTTP 400 for malformed translated tool-result images', async () => {
    const imageCatalog = createGatewayModelCatalog([{
      id: 'gpt-image-validation',
      name: 'GPT Image Validation',
      isFree: false,
      brand: 'OpenAI',
      providerId: 'openai',
      sourceBackend: 'openai',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      authType: 'api',
      apiKey: 'provider-key',
    }]);
    const server = await startTestServer({ catalog: imageCatalog });

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-openai__gpt-image-validation',
        messages: [{
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'call_invalid',
            content: [{
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'not base64!',
              },
            }],
          }],
        }],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: 'invalid_request_error',
        message: expect.stringContaining('malformed_base64'),
      },
    });
    expect(createLanguageModel).not.toHaveBeenCalled();
  });

});
