import { createServer, type IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGatewayModelCatalog, type ServerModelInfo } from '../src/server/models.js';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { createLanguageModel } from '../src/provider-factory.js';
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


describe("server router aliases", () => {
  describe('saved alias and masked-id request resolution', () => {
    const lunaModel: ServerModelInfo = {
      id: 'gpt-5.6-luna',
      name: 'GPT-5.6 Luna',
      isFree: false,
      brand: 'OpenAI',
      providerId: 'openai-oauth',
      providerLabel: 'OpenAI (ChatGPT)',
      sourceBackend: 'openai-oauth',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      apiKey: 'oauth-token',
    };
    const gateway = { maskGatewayIds: true as const };
    const aliases = [{ name: 'luna', providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' }];

    async function startAliasServer(): Promise<ServerHandle> {
      return startTestServer({
        catalog: createGatewayModelCatalog([lunaModel], gateway, aliases),
        gateway,
        aliasNames: new Set(aliases.map(alias => alias.name)),
      });
    }

    it('resolves a bare saved alias and echoes it back verbatim in the response model', async () => {
      const server = await startAliasServer();

      const response = await fetch(`${server.url}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'luna', messages: [{ role: 'user', content: 'hi' }] }),
      });

      expect(response.status).toBe(200);

      expect(await response.json()).toMatchObject({ id: 'msg-test', model: 'luna' });
    });

    it('resolves masked and canonical leverframe ids when masking is on', async () => {
      const server = await startAliasServer();

      for (const requestId of [
        'anthropic-htuao-ianepo__anul-6.5-tpg', // masked form of anthropic-openai-oauth__gpt-5.6-luna
        'leverframe:openai-oauth:gpt-5.6-luna',
      ]) {
        const response = await fetch(`${server.url}/anthropic/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: requestId, messages: [{ role: 'user', content: 'hi' }] }),
        });
        expect(response.status, requestId).toBe(200);
      }
    });

    it('resolves a saved alias on the OpenAI chat completions endpoint too', async () => {
      const server = await startAliasServer();

      const response = await fetch(`${server.url}/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'luna', messages: [{ role: 'user', content: 'hi' }] }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: 'chatcmpl-test', model: 'luna' });
    });

    it('still rejects unknown model ids with 400', async () => {
      const server = await startAliasServer();

      const response = await fetch(`${server.url}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nova', messages: [] }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { message: 'Unknown model: nova' } });
    });

    it('does not advertise alias names in the discovery model list', async () => {
      const server = await startAliasServer();

      const listing = await fetch(`${server.url}/anthropic/v1/models`);
      expect(listing.status).toBe(200);
      const payload = await listing.json() as { data: Array<{ id: string }> };
      expect(payload.data.map(entry => entry.id)).toEqual(['anthropic-htuao-ianepo__anul-6.5-tpg']);
    });
  });
});
