import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGatewayModelCatalog, type ServerModelInfo } from '../src/server/models.js';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { createLanguageModel } from '../src/provider-factory.js';
import { generateAnthropicResponse } from '../src/sdk-adapter.js';
import { generateOpenAiResponse } from '../src/openai-adapter.js';
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


describe("server router streaming and disconnects", () => {
  it('forces internal streaming for non-streaming requests on OpenAI OAuth routes', async () => {
    const oauthCatalog = createGatewayModelCatalog([{
      id: 'gpt-oauth',
      name: 'GPT OAuth',
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

    const messagesResponse = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-openai-oauth__gpt-oauth',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(messagesResponse.status).toBe(200);
    expect(vi.mocked(generateAnthropicResponse)).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ forceStream: true }),
    );

    const chatResponse = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-oauth',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(chatResponse.status).toBe(200);
    expect(vi.mocked(generateOpenAiResponse)).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ forceStream: true }),
    );
  });

  it('aborts OpenAI OAuth provider work when the Anthropic client disconnects', async () => {
    const oauthCatalog = createGatewayModelCatalog([{
      id: 'gpt-oauth-cancel',
      name: 'GPT OAuth Cancel',
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
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    let observedSignal: AbortSignal | undefined;
    vi.mocked(generateAnthropicResponse).mockImplementationOnce(
      async (_model, _params, _modelId, adapterOptions) => {
        observedSignal = adapterOptions?.abortSignal;
        resolveStarted?.();
        return new Promise((_resolve, reject) => {
          observedSignal?.addEventListener('abort', () => reject(observedSignal?.reason), { once: true });
        });
      },
    );

    const request = httpRequest(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    request.on('error', () => {});
    request.end(JSON.stringify({
      model: 'anthropic-openai-oauth__gpt-oauth-cancel',
      messages: [{ role: 'user', content: 'cancel' }],
    }));
    await started;
    request.destroy();

    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
    expect(observedSignal?.reason).toMatchObject({ name: 'AbortError' });
  });

  it('aborts OpenAI OAuth provider work when the OpenAI client disconnects', async () => {
    const oauthCatalog = createGatewayModelCatalog([{
      id: 'gpt-oauth-openai-cancel',
      name: 'GPT OAuth OpenAI Cancel',
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
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    let observedSignal: AbortSignal | undefined;
    vi.mocked(generateOpenAiResponse).mockImplementationOnce(
      async (_model, _params, _modelId, adapterOptions) => {
        observedSignal = adapterOptions?.abortSignal;
        resolveStarted?.();
        return new Promise((_resolve, reject) => {
          observedSignal?.addEventListener('abort', () => reject(observedSignal?.reason), { once: true });
        });
      },
    );

    const request = httpRequest(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    request.on('error', () => {});
    request.end(JSON.stringify({
      model: 'gpt-oauth-openai-cancel',
      messages: [{ role: 'user', content: 'cancel' }],
    }));
    await started;
    request.destroy();

    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
    expect(observedSignal?.reason).toMatchObject({ name: 'AbortError' });
  });

  it('rebuilds a cached provider handle after its credential changes', async () => {
    const rotatingModel: ServerModelInfo = {
      id: 'gpt-rotating-key',
      name: 'GPT Rotating Key',
      isFree: false,
      brand: 'OpenAI',
      providerId: 'openai',
      sourceBackend: 'openai',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      authType: 'api',
      apiKey: 'credential-a',
    };
    const server = await startTestServer({
      catalog: createGatewayModelCatalog([rotatingModel]),
    });
    const send = () => fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-openai__gpt-rotating-key',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    expect((await send()).status).toBe(200);
    rotatingModel.apiKey = 'credential-b';
    expect((await send()).status).toBe(200);

    expect(vi.mocked(createLanguageModel)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createLanguageModel).mock.calls[0]?.[0]).toMatchObject({
      apiKey: 'credential-a',
    });
    expect(vi.mocked(createLanguageModel).mock.calls[1]?.[0]).toMatchObject({
      apiKey: 'credential-b',
    });
  });

  it('does not force streaming for non-streaming requests on API-key routes', async () => {
    const apiKeyCatalog = createGatewayModelCatalog([{
      id: 'gpt-api',
      name: 'GPT API',
      isFree: false,
      brand: 'OpenAI',
      providerId: 'openai',
      sourceBackend: 'openai',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      authType: 'api',
      apiKey: 'sk-test',
    }]);
    const server = await startTestServer({ catalog: apiKeyCatalog });

    const messagesResponse = await fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-openai__gpt-api',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(messagesResponse.status).toBe(200);
    expect(vi.mocked(generateAnthropicResponse)).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ forceStream: false }),
    );

    const chatResponse = await fetch(`${server.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-api',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(chatResponse.status).toBe(200);
    expect(vi.mocked(generateOpenAiResponse)).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ forceStream: false }),
    );
  });

});
