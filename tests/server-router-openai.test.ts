import { createServer, type IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGatewayModelCatalog, type ServerModelInfo } from '../src/server/models.js';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { createLanguageModel } from '../src/provider-factory.js';
import { revalidateCustomEndpointUrl } from '../src/registry/url-security.js';
import { resolveProviderCredential } from '../src/env.js';
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


describe("server router OpenAI routes", () => {
  it('forwards OpenAI chat completions for OpenAI-format models unchanged', async () => {
    const upstream = await startUpstream({
      id: 'chatcmpl-test',
      choices: [{ message: { content: 'openai ok' }, finish_reason: 'stop' }],
    });
    handles.push(upstream);
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([
        model('openai-format', 'openai', 'go', { completionsUrl: `${upstream.baseUrl}/v1/chat/completions` }),
      ]),
    });

    const body = { model: 'openai-format', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 };
    const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'chatcmpl-test' });
    expect(upstream.requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/chat/completions',
      authorization: 'Bearer real-opencode-key',
      body,
    });
  });

  it('caches SDK language models per provider-qualified route, not just raw model id', async () => {
    const duplicateCatalog = createGatewayModelCatalog([
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        isFree: false,
        brand: 'OpenAI',
        providerId: 'openai',
        providerLabel: 'OpenAI',
        sourceBackend: 'openai',
        modelFormat: 'openai',
        npm: '@ai-sdk/openai',
        apiKey: 'openai-key',
      },
      {
        id: 'gpt-4o',
        name: 'GPT-4o via OpenRouter',
        isFree: false,
        brand: 'OpenAI',
        providerId: 'openrouter',
        providerLabel: 'OpenRouter',
        sourceBackend: 'openrouter',
        modelFormat: 'openai',
        npm: '@openrouter/ai-sdk-provider',
        apiKey: 'openrouter-key',
      },
    ]);
    const server = await startTestServer({ catalog: duplicateCatalog });

    for (const modelId of ['anthropic-openai__gpt-4o', 'anthropic-openrouter__gpt-4o']) {
      const response = await fetch(`${server.url}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(response.status).toBe(200);
    }

    expect(vi.mocked(createLanguageModel)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createLanguageModel).mock.calls.map(call => (call[0] as any).providerId)).toEqual([
      'openai',
      'openrouter',
    ]);
  });

  it('exposes SDK-only registry models through OpenAI chat completions', async () => {
    const sdkOnlyCatalog = createGatewayModelCatalog([{
      id: 'gpt-5',
      name: 'GPT-5',
      isFree: false,
      brand: 'OpenAI',
      providerId: 'openai',
      providerLabel: 'OpenAI',
      sourceBackend: 'openai',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      apiBaseUrl: 'https://api.openai.com/v1',
      apiKey: 'openai-key',
    }]);
    const server = await startTestServer({ catalog: sdkOnlyCatalog });

    const models = await fetch(`${server.url}/openai/v1/models`);
    expect(models.status).toBe(200);
    expect(await models.json()).toEqual({
      object: 'list',
      data: [
        expect.objectContaining({ id: 'gpt-5', owned_by: 'openai' }),
      ],
    });

    const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'chatcmpl-test', choices: [{ message: { content: 'openai sdk ok' } }] });
  });

  it('revalidates the provider base URL before direct OpenAI chat completions', async () => {
    vi.mocked(revalidateCustomEndpointUrl).mockResolvedValueOnce({ ok: false, error: 'blocked for test' });
    const catalog = createGatewayModelCatalog([{
      id: 'gpt-direct',
      name: 'GPT Direct',
      isFree: false,
      brand: 'OpenAI',
      providerId: 'openai',
      providerLabel: 'OpenAI',
      sourceBackend: 'openai',
      modelFormat: 'openai',
      apiBaseUrl: 'https://api.openai.com/v1',
      completionsUrl: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'openai-key',
    }]);
    const server = await startTestServer({ catalog });

    const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-direct', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(response.status).toBe(400);
    expect(revalidateCustomEndpointUrl).toHaveBeenCalledWith('https://api.openai.com/v1', {
      allowInsecureLocal: false,
    });
  });

  it('translates OpenAI requests for Anthropic-native models', async () => {
    const server = await startTestServer();

    const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-native', messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'chatcmpl-test', choices: [{ message: { content: 'openai sdk ok' } }] });
  });

  it('rejects unsupported model formats', async () => {
    const server = await startTestServer();

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'bad-format', messages: [] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('Unsupported model format') },
    });
  });

  it('rejects a canonical unknown candidate before credential resolution or upstream forwarding', async () => {
    const upstream = await startUpstream({ id: 'must-not-be-reached' });
    handles.push(upstream);
    const server = await startServer({
      host: '127.0.0.1',
      port: 0,
      apiKey: 'real-opencode-key',
      serverPassword: null,
      catalog: defaultCatalog(upstream.baseUrl),
    });
    handles.push(server);
    vi.mocked(resolveProviderCredential).mockClear();

    const response = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'leverframe:opencode-go:unknown-candidate', messages: [] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: 'Unknown model: leverframe:opencode-go:unknown-candidate' },
    });
    expect(resolveProviderCredential).not.toHaveBeenCalled();
    expect(upstream.requests).toHaveLength(0);
  });

});
