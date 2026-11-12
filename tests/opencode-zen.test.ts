import { afterEach, expect, it, vi } from 'vitest';
import { generateText } from 'ai';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { getTemplateById, listAddableTemplates } from '../src/provider-templates.js';
import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';
import { addProviderFromTemplate } from '../src/registry/add-template.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';
import { refreshProviderModels } from '../src/registry/refresh-models.js';
import { materializeRegistry } from '../src/registry/materialize.js';
import { getProvidersPath } from '../src/paths.js';
import { createLanguageModel } from '../src/language-model-factory.js';
import { translateRequest } from '../src/sdk-request-translation.js';
import { generateAnthropicResponse } from '../src/sdk-non-streaming-response.js';

const zenBaseUrl = 'https://opencode.ai/inference/openai/v1';
const session = '11111111-1111-4111-8111-111111111111';
const anotherSession = '22222222-2222-4222-8222-222222222222';

function listedModel(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    type: 'chat',
    family: 'fixture-family',
    limit: { context: 200000, input: 160000, output: 32000 },
    capabilities: { reasoning: { supported: true }, temperature: false },
    cost: { text: { input: { price: 0, cache: { read: 0, write: 0 } }, output: { price: 0 } } },
    api: { 'chat-completions': {
      base_url: zenBaseUrl,
      compatibility: { reasoning_field: 'reasoning_content' },
    } },
    ...overrides,
  };
}

function listedModelsFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    if (String(input).includes('models.dev')) return Response.json({});
    return Response.json({ data: [
      listedModel('confirmed-free'),
      listedModel('paid', { cost: { text: { input: { price: 1 }, output: { price: 2 } } } }),
      listedModel('unknown-price', { cost: undefined }),
      listedModel('missing-output-price', { cost: { text: { input: { price: 0 } } } }),
      listedModel('paid-cache', { cost: { text: { input: { price: 0, cache: { read: 1 } }, output: { price: 0 } } } }),
      listedModel('non-chat', { type: 'image' }),
      listedModel('other-endpoint', { api: { 'chat-completions': { base_url: 'https://other.example/v1' } } }),
    ] });
  });
}

function chatResponseFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
    id: 'chatcmpl_fixture',
    created: 1,
    model: 'confirmed-free',
    object: 'chat.completion',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
}

afterEach(() => vi.restoreAllMocks());

it('discovers only fully priced free chat models on the supported endpoint', async () => {
  const fetchMock = listedModelsFetch();
  const template = getTemplateById('opencode-zen');
  expect(template).toBeDefined();
  const result = await fetchTemplateModels(template!, '');

  expect(String(fetchMock.mock.calls[0][0])).toBe('https://opencode.ai/inference/v1/models');
  expect(result.error).toBeUndefined();
  expect(result.models.map(model => model.id)).toEqual(['confirmed-free']);
  expect(result.models[0]).toMatchObject({
    contextWindow: 200000,
    inputTokenLimit: 160000,
    outputTokenLimit: 32000,
    reasoning: true,
    supportsTemperature: false,
    interleavedReasoningField: 'reasoning_content',
    isFree: true,
    freeStatus: 'verified_free',
  });
  expect(listAddableTemplates().map(item => item.id)).toContain('opencode-go');
});

it('stores anonymous Zen access without a key and materializes only its free model', async () => {
  listedModelsFetch();
  const fixtureHome = process.env['LEVERFRAME_HOME'];
  expect(fixtureHome).toBeTruthy();
  const registryPath = resolve(getProvidersPath());
  const relativeRegistryPath = relative(resolve(fixtureHome!), registryPath);
  expect(isAbsolute(relativeRegistryPath) || relativeRegistryPath === '..'
    || relativeRegistryPath.startsWith(`..${sep}`)).toBe(false);

  const template = getTemplateById('opencode-zen');
  expect(template).toBeDefined();
  const result = await addProviderFromTemplate(template!, '');

  expect(result.added).toBe(true);
  expect(result.provider).toMatchObject({
    authType: 'none',
    authRef: 'none:anonymous',
    subscriptionFilter: 'free',
  });
  expect(materializeRegistry(loadRegistry(), () => null)
    .find(provider => provider.id === 'opencode-zen')?.models.map(model => model.id)).toEqual(['confirmed-free']);
});

it('uses OpenCode request identity and carries the Claude session through the request', async () => {
  const fetchMock = chatResponseFetch();
  const model = await createLanguageModel({
    npm: '@ai-sdk/openai-compatible',
    modelId: 'confirmed-free',
    apiKey: '',
    authType: 'none',
    providerId: 'opencode-zen',
    baseURL: zenBaseUrl,
  });
  const params = translateRequest({
    model: 'confirmed-free',
    messages: [{ role: 'user', content: 'Reply OK' }],
  }, '@ai-sdk/openai-compatible', {
    claudeSessionId: session,
    reasoningMetadata: { providerId: 'opencode-zen' },
  });
  await generateAnthropicResponse(model, params, 'confirmed-free');

  expect(String(fetchMock.mock.calls[0][0])).toBe(`${zenBaseUrl}/chat/completions`);
  const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
  expect(headers.get('authorization')).toBe('Bearer public');
  expect(headers.get('user-agent')).toMatch(/^opencode\/[^/]+\/[^/]+\/leverframe$/);
  expect(headers.get('x-opencode-client')).toBe('leverframe');
  expect(headers.get('x-opencode-project')).toBeTruthy();
  expect(headers.get('x-opencode-session')).toBe(session);
  expect(headers.get('x-opencode-session-id')).toBe(session);
  expect(headers.get('x-session-affinity')).toBe(session);
  expect(headers.get('x-session-id')).toBe(session);
});

it('uses only the public Zen credential when custom headers contain an API key', async () => {
  const fetchMock = chatResponseFetch();
  const model = await createLanguageModel({ npm: '@ai-sdk/openai-compatible', modelId: 'confirmed-free',
    apiKey: 'go-secret', providerId: 'opencode-zen', baseURL: zenBaseUrl,
    headers: { Authorization: 'Bearer go-secret', 'x-api-key': 'go-secret' } });
  await generateText({ model, prompt: 'Reply OK', maxRetries: 0 });

  const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
  expect(headers.get('authorization')).toBe('Bearer public');
  expect(headers.get('x-api-key')).toBeNull();
});

it('does not retry a Zen free tier limit response', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    error: { type: 'FreeUsageLimitError', message: 'Free model limit reached.' },
  }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '0' } }));
  const model = await createLanguageModel({ npm: '@ai-sdk/openai-compatible', modelId: 'confirmed-free',
    apiKey: '', authType: 'none', providerId: 'opencode-zen', baseURL: zenBaseUrl });
  const params = translateRequest({ model: 'confirmed-free', messages: [{ role: 'user', content: 'Reply OK' }] },
    '@ai-sdk/openai-compatible', { claudeSessionId: session, reasoningMetadata: { providerId: 'opencode-zen' } });

  await expect(generateAnthropicResponse(model, params, 'confirmed-free')).rejects.toThrow();

  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('isolates separate Claude sessions in Zen requests', async () => {
  const fetchMock = chatResponseFetch();
  const model = await createLanguageModel({ npm: '@ai-sdk/openai-compatible', modelId: 'confirmed-free',
    apiKey: '', authType: 'none', providerId: 'opencode-zen', baseURL: zenBaseUrl });
  const first = translateRequest({ model: 'confirmed-free', messages: [{ role: 'user', content: 'First' }] },
    '@ai-sdk/openai-compatible', { claudeSessionId: session, reasoningMetadata: { providerId: 'opencode-zen' } });
  const second = translateRequest({ model: 'confirmed-free', messages: [{ role: 'user', content: 'Second' }] },
    '@ai-sdk/openai-compatible', { claudeSessionId: anotherSession, reasoningMetadata: { providerId: 'opencode-zen' } });
  await generateAnthropicResponse(model, first, 'confirmed-free');
  await generateAnthropicResponse(model, second, 'confirmed-free');

  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('x-opencode-session')).toBe(session);
  expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('x-opencode-session')).toBe(anotherSession);
});

it('keeps Go authentication and user agent separate from Zen request identity', async () => {
  const fetchMock = chatResponseFetch();
  const model = await createLanguageModel({
    npm: '@ai-sdk/openai-compatible',
    modelId: 'go-model',
    apiKey: 'go-key',
    providerId: 'opencode-go',
    baseURL: 'https://opencode.ai/zen/go/v1',
  });
  await generateText({ model, prompt: 'Reply OK', maxRetries: 0 });

  const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
  expect(headers.get('authorization')).toBe('Bearer go-key');
  expect(headers.get('user-agent')).toMatch(/^leverframe\//);
  expect(headers.get('x-opencode-client')).toBeNull();
});

it('keeps Zen credentials and identity off a different API host', async () => {
  const fetchMock = chatResponseFetch();
  const model = await createLanguageModel({
    npm: '@ai-sdk/openai-compatible',
    modelId: 'other-model',
    apiKey: 'other-key',
    providerId: 'opencode-zen',
    baseURL: 'https://example.com/v1',
  });
  await generateText({ model, prompt: 'Reply OK', maxRetries: 0 });

  const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
  expect(headers.get('authorization')).toBe('Bearer other-key');
  expect(headers.get('user-agent')).not.toMatch(/^opencode\//);
  expect(headers.get('x-opencode-client')).toBeNull();
  expect(headers.get('x-opencode-project')).toBeNull();
});

it('retains a stable session for an unkeyed Zen request', async () => {
  const fetchMock = chatResponseFetch();
  const model = await createLanguageModel({
    npm: '@ai-sdk/openai-compatible',
    modelId: 'confirmed-free',
    apiKey: '',
    authType: 'none',
    providerId: 'opencode-zen',
    baseURL: zenBaseUrl,
  });
  await generateText({ model, prompt: 'Reply OK', maxRetries: 0 });
  await generateText({ model, prompt: 'Reply OK', maxRetries: 0 });

  const first = new Headers(fetchMock.mock.calls[0][1]?.headers);
  const second = new Headers(fetchMock.mock.calls[1][1]?.headers);
  expect(first.get('x-opencode-session')).toBeTruthy();
  expect(second.get('x-opencode-session')).toBe(first.get('x-opencode-session'));
});

it('wraps a caller transport and stops redirects to keep identity headers off other origins', async () => {
  const transport = chatResponseFetch();
  const model = await createLanguageModel({ npm: '@ai-sdk/openai-compatible', modelId: 'confirmed-free',
    apiKey: '', authType: 'none', providerId: 'opencode-zen', baseURL: zenBaseUrl, fetch: globalThis.fetch });
  await generateText({ model, prompt: 'Reply OK', maxRetries: 0 });

  const init = transport.mock.calls[0][1];
  expect(new Headers(init?.headers).get('x-opencode-session')).toBeTruthy();
  expect(init?.redirect).toBe('manual');
});

it('keeps refreshed Zen model inventory free only', async () => {
  const fixtureHome = process.env['LEVERFRAME_HOME']!;
  const relativeRegistryPath = relative(resolve(fixtureHome), resolve(getProvidersPath()));
  expect(isAbsolute(relativeRegistryPath) || relativeRegistryPath === '..'
    || relativeRegistryPath.startsWith(`..${sep}`)).toBe(false);
  saveRegistry({ schemaVersion: 1, providers: [
    {
      id: 'opencode-zen',
      templateId: 'opencode-zen',
      name: 'OpenCode Zen',
      enabled: true,
      authType: 'none',
      authRef: 'none:anonymous',
      api: { npm: '@ai-sdk/openai-compatible', url: zenBaseUrl },
      addedAt: '2026-11-04T00:00:00.000Z',
      modelsCache: { fetchedAt: '2026-11-04T00:00:00.000Z', models: [] },
    },
    {
      id: 'opencode-go',
      templateId: 'opencode-go',
      name: 'OpenCode Go',
      enabled: true,
      authType: 'api',
      authRef: 'keyring:provider:opencode-go',
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://opencode.ai/zen/go/v1' },
      addedAt: '2026-11-04T00:00:00.000Z',
      modelsCache: { fetchedAt: '2026-11-04T00:00:00.000Z', models: [
        { id: 'go-cached', name: 'Go cached model', upstreamModelId: 'go-cached',
          npm: '@ai-sdk/openai-compatible', modelFormat: 'openai' },
      ] },
    },
  ] });
  listedModelsFetch();

  const result = await refreshProviderModels('opencode-zen', null, loadRegistry());

  expect(result.ok).toBe(true);
  expect(loadRegistry().providers[0]?.modelsCache?.models.map(model => model.id)).toEqual(['confirmed-free']);
  expect(loadRegistry().providers[1]?.modelsCache?.models.map(model => model.id)).toEqual(['go-cached']);
});
