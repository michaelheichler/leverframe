/** Because the inbound coding-session ID must reach OAuth cache affinity. */
import { afterEach, expect, it, vi } from 'vitest';
import { createGatewayModelCatalog, type ServerModelInfo } from '../src/server/models.js';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

const fetchSlot = vi.hoisted(() => ({ current: undefined as typeof fetch | undefined }));

vi.mock('../src/provider-factory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/provider-factory.js')>();
  return {
    ...actual,
    createLanguageModel: vi.fn(async (spec: {
      npm: string; apiKey: string; modelId: string; baseURL?: string; authType?: 'api' | 'oauth' | 'none';
    }) => {
      const fetchImpl: typeof fetch = (...args) => fetchSlot.current!(...args);
      if (spec.authType === 'oauth') {
        const { createOpenAI } = await import('@ai-sdk/openai');
        return createOpenAI({ apiKey: spec.apiKey, baseURL: 'https://api.openai.fixture/v1', fetch: fetchImpl }).chat(spec.modelId);
      }
      const { createBuiltinOpenAiModel } = await import('../src/language-model-builtins.js');
      return createBuiltinOpenAiModel({ ...spec, fetch: fetchImpl }, false);
    }),
  };
});

vi.mock('../src/registry/url-security.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/registry/url-security.js')>(),
  revalidateCustomEndpointUrl: vi.fn(async (url: string) => ({ ok: true, normalizedUrl: url })),
}));

useIsolatedTestHome('leverframe-openai-cache-affinity-route');

const sessionId = '7f4c572b-f0e3-4df1-b359-6d6d9824c901';
const upstreamToken = 'openai-oauth-fixture-sentinel';
const clientToken = 'local-gateway-fixture-sentinel';
let server: ServerHandle | undefined;

interface CapturedCall {
  headers: Headers;
  body: Record<string, unknown>;
}

afterEach(async () => {
  fetchSlot.current = undefined;
  await server?.close();
  server = undefined;
  vi.clearAllMocks();
});

function oauthChatModel(): ServerModelInfo {
  return {
    id: 'fixture-openai-oauth', name: 'fixture OpenAI OAuth', isFree: false, brand: 'OpenAI',
    sourceBackend: 'openai', modelFormat: 'openai', providerId: 'openai', authType: 'oauth',
    npm: '@ai-sdk/openai', apiKey: upstreamToken,
  };
}

async function startRouteServer(model = oauthChatModel()): Promise<ServerHandle> {
  server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: clientToken, serverPassword: null,
    catalog: createGatewayModelCatalog([model]),
  });
  return server;
}

function installFakeUpstream(): CapturedCall[] {
  const calls: CapturedCall[] = [];
  fetchSlot.current = async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    calls.push({ headers: new Headers(request.headers), body: await request.clone().json() as Record<string, unknown> });
    const chunks = [
      { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-openai-oauth', choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture reply' }, finish_reason: null }] },
      { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-openai-oauth', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  return calls;
}

async function sendChat(
  session: string,
  text: string,
  stream = false,
  promptCacheKey = 'caller-key-must-not-override-session',
  modelId = 'fixture-openai-oauth',
): Promise<Response> {
  const route = server;
  if (!route) throw new Error('route server is not running');
  return fetch(`${route.url}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${clientToken}`,
      'content-type': 'application/json',
      'x-claude-code-session-id': session,
      'x-untrusted-forwarded-header': 'must-not-leak',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: text }],
      prompt_cache_key: promptCacheKey,
      stream,
    }),
  });
}

function apiKeyModel(sourceBackend: ServerModelInfo['sourceBackend'], providerId: string, apiBaseUrl?: string): ServerModelInfo {
  return {
    id: `fixture-${providerId}`, name: `fixture ${providerId}`, isFree: false, brand: 'OpenAI',
    sourceBackend, modelFormat: 'openai', providerId, authType: 'api', npm: '@ai-sdk/openai',
    ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
    apiKey: `${providerId}-api-key-fixture-sentinel`,
  };
}

function installFakeJsonUpstream(): CapturedCall[] {
  const calls: CapturedCall[] = [];
  fetchSlot.current = async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    calls.push({ headers: new Headers(request.headers), body: await request.clone().json() as Record<string, unknown> });
    return Response.json({
      id: 'chatcmpl-fixture', object: 'chat.completion', created: 1, model: 'fixture-openai-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'fixture reply' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  };
  return calls;
}

it.each([
  { stream: false, contentType: 'application/json' },
  { stream: true, contentType: 'text/event-stream' },
])('sends only a hashed affinity value through the OAuth chat route ($contentType)', async ({ stream, contentType }) => {
  const calls = installFakeUpstream();
  await startRouteServer();
  const response = await sendChat(sessionId, 'first synthetic request', stream);

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain(contentType);
  expect(calls).toHaveLength(1);
  const affinity = calls[0]!.headers.get('session-id');
  const body = calls[0]!.body;
  expect(affinity).toBeTruthy();
  expect(affinity).not.toBe(sessionId);
  expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${upstreamToken}`);
  expect(calls[0]!.headers.has('x-untrusted-forwarded-header')).toBe(false);
  expect(body['prompt_cache_key']).toBe(affinity);
  expect(body['prompt_cache_key']).not.toBe('caller-key-must-not-override-session');
  expect(JSON.stringify(body)).not.toContain(sessionId);
});

it('separates session affinity when one cached OAuth model serves distinct sessions', async () => {
  const calls = installFakeUpstream();
  await startRouteServer();
  const otherSession = '445f9aa7-b822-4b3e-b808-05ee1b89908b';
  const firstResponse = await sendChat(sessionId, 'session one turn');
  const secondResponse = await sendChat(otherSession, 'session two turn');

  expect(firstResponse.status).toBe(200);
  expect(secondResponse.status).toBe(200);
  expect(calls).toHaveLength(2);
  const firstAffinity = calls[0]!.headers.get('session-id');
  const secondAffinity = calls[1]!.headers.get('session-id');
  expect(firstAffinity).toBeTruthy();
  expect(secondAffinity).toBeTruthy();
  expect(secondAffinity).not.toBe(firstAffinity);
  expect(calls[0]!.body['prompt_cache_key']).toBe(firstAffinity);
  expect(calls[1]!.body['prompt_cache_key']).toBe(secondAffinity);
});

it('falls back without exposing malformed inbound session metadata', async () => {
  const calls = installFakeUpstream();
  await startRouteServer();
  const malformed = 'not-a-session-uuid';
  const response = await sendChat(malformed, 'synthetic request without a valid session');

  expect(response.status).toBe(200);
  expect(calls).toHaveLength(1);
  const affinity = calls[0]!.headers.get('session-id');
  expect(affinity).toBeTruthy();
  expect(calls[0]!.body['prompt_cache_key']).toBe(affinity);
  expect(affinity).not.toContain(malformed);
  expect(JSON.stringify(calls[0]!.body)).not.toContain(malformed);
});

it('preserves a caller cache key on the genuine OpenAI API-key route', async () => {
  const calls = installFakeJsonUpstream();
  const model = apiKeyModel('openai', 'custom-openai', 'https://api.openai.com/v1');
  await startRouteServer(model);
  const response = await sendChat(sessionId, 'synthetic OpenAI API request', false, 'caller-openai-cache-key', model.id);

  expect(response.status, await response.clone().text()).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body['prompt_cache_key']).toBe('caller-openai-cache-key');
  expect(calls[0]!.headers.get('session-id')).toBeNull();
});

it('does not pass an OpenAI cache key to an OpenCode Go route using the same SDK', async () => {
  const calls = installFakeJsonUpstream();
  const model = apiKeyModel('go', 'opencode-go', 'https://opencode.ai/zen/go/v1');
  await startRouteServer(model);
  const response = await sendChat(sessionId, 'synthetic OpenCode Go request', false, 'caller-key-for-other-provider', model.id);

  expect(response.status, await response.clone().text()).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body['prompt_cache_key']).toBeUndefined();
  expect(calls[0]!.headers.get('session-id')).toBeNull();
  expect(JSON.stringify(calls[0]!.body)).not.toContain('caller-key-for-other-provider');
});

it('does not preserve a caller cache key when the OpenAI base URL comes from the environment', async () => {
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const calls = installFakeJsonUpstream();
  process.env.OPENAI_BASE_URL = 'https://gateway.fixture/v1';

  try {
    const model = apiKeyModel('openai', 'openai-env-route');
    await startRouteServer(model);
    const response = await sendChat(sessionId, 'synthetic environment endpoint request', false,
      'caller-key-for-environment-endpoint', model.id);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body['prompt_cache_key']).toBeUndefined();
    expect(JSON.stringify(calls[0]!.body)).not.toContain('caller-key-for-environment-endpoint');
  } finally {
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
  }
});
