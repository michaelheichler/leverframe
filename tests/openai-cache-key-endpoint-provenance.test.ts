import http from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGatewayModelCatalog, type ServerModelInfo } from '../src/server/models.js';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-openai-cache-endpoint-provenance');

interface CapturedRequest {
  body: Record<string, unknown>;
  headers: Headers;
}

let server: ServerHandle | undefined;
const gatewayToken = 'openai-provenance-gateway-sentinel';
const providerToken = 'openai-provenance-provider-sentinel';
let previousBaseUrl: string | undefined;

vi.mock('../src/registry/url-security.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/registry/url-security.js')>(),
  revalidateCustomEndpointUrl: vi.fn(async (url: string) => ({ ok: true, normalizedUrl: url })),
}));

beforeEach(() => {
  previousBaseUrl = process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_BASE_URL;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await server?.close();
  server = undefined;
  if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = previousBaseUrl;
});

function openAiModel(apiBaseUrl?: string): ServerModelInfo {
  return {
    id: 'fixture-openai-api', name: 'fixture OpenAI API', isFree: false, brand: 'OpenAI',
    sourceBackend: 'openai', modelFormat: 'openai', providerId: 'openai', authType: 'api',
    npm: '@ai-sdk/openai', apiKey: providerToken,
    ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
  };
}

async function startRoute(model: ServerModelInfo = openAiModel()): Promise<ServerHandle> {
  server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: gatewayToken, serverPassword: null,
    catalog: createGatewayModelCatalog([model]),
  });
  return server;
}

function installFakeUpstream(): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    captured.push({ body: await request.clone().json() as Record<string, unknown>, headers: new Headers(request.headers) });
    return Response.json({
      id: 'chatcmpl-provenance-fixture', object: 'chat.completion', created: 1, model: 'fixture-openai-api',
      choices: [{ index: 0, message: { role: 'assistant', content: 'offline response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
  return captured;
}

function postChat(promptCacheKey: string): Promise<number> {
  const route = server;
  if (!route) throw new Error('server fixture is not running');
  const body = JSON.stringify({
    model: 'fixture-openai-api', messages: [{ role: 'user', content: 'offline prompt' }],
    prompt_cache_key: promptCacheKey, stream: false,
  });
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port: route.port, path: '/openai/v1/chat/completions', method: 'POST',
      headers: {
        authorization: `Bearer ${gatewayToken}`, 'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end(body);
  });
}

it('preserves caller cache keys for the SDK default OpenAI endpoint', async () => {
  const captured = installFakeUpstream();
  await startRoute();

  const status = await postChat('caller-default-endpoint-key');

  expect(status).toBe(200);
  expect(captured).toHaveLength(1);
  expect(captured[0]!.body['prompt_cache_key']).toBe('caller-default-endpoint-key');
});

it('omits caller cache keys when the SDK endpoint comes from a noncanonical environment URL', async () => {
  process.env.OPENAI_BASE_URL = 'https://gateway.fixture/v1';
  const captured = installFakeUpstream();
  await startRoute();

  const status = await postChat('caller-environment-endpoint-key');

  expect(status).toBe(200);
  expect(captured).toHaveLength(1);
  expect(captured[0]!.body['prompt_cache_key']).toBeUndefined();
  expect(JSON.stringify(captured[0]!.body)).not.toContain('caller-environment-endpoint-key');
});

it.each([
  { endpoint: 'https://api.openai.com/v1', forwarded: 'caller-canonical-endpoint-key' },
  { endpoint: 'https://api.openai.com/v1/', forwarded: 'caller-canonical-endpoint-key' },
  { endpoint: 'https://api.openai.com/v1//', forwarded: undefined },
])('classifies only the canonical OpenAI endpoint ($endpoint)', async ({ endpoint, forwarded }) => {
  const captured = installFakeUpstream();
  await startRoute(openAiModel(endpoint));

  const status = await postChat('caller-canonical-endpoint-key');

  expect(status).toBe(200);
  expect(captured[0]!.body['prompt_cache_key']).toBe(forwarded);
});

it('retains cached-model endpoint provenance after canonical-to-custom environment drift', async () => {
  const captured = installFakeUpstream();
  await startRoute();
  const firstStatus = await postChat('caller-first-canonical-key');
  process.env.OPENAI_BASE_URL = 'https://gateway.fixture/v1';
  const secondStatus = await postChat('caller-second-after-drift-key');

  expect(firstStatus).toBe(200);
  expect(secondStatus).toBe(200);
  expect(captured.map(request => request.body['prompt_cache_key'])).toEqual([
    'caller-first-canonical-key', 'caller-second-after-drift-key',
  ]);
});

it('retains cached-model endpoint provenance after custom-to-canonical environment drift', async () => {
  process.env.OPENAI_BASE_URL = 'https://gateway.fixture/v1';
  const captured = installFakeUpstream();
  await startRoute();
  const firstStatus = await postChat('caller-first-custom-key');
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
  const secondStatus = await postChat('caller-second-after-drift-key');

  expect(firstStatus).toBe(200);
  expect(secondStatus).toBe(200);
  expect(captured.map(request => request.body['prompt_cache_key'])).toEqual([undefined, undefined]);
});
