import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProviderRegistry } from '../src/registry/types.js';
import * as io from '../src/registry/io.js';
import { refreshProviderModels } from '../src/registry/refresh-models.js';
import {
  OPENAI_OAUTH_ASTRA_MODEL,
} from './fixtures/openai-oauth-astra-metadata.js';

vi.mock('../src/registry/credential-lifecycle.js', () => ({
  reconcilePendingCredentialDeletes: vi.fn(async () => ({ deleted: [], pending: [] })),
}));
vi.mock('../src/registry/io.js', () => ({
  loadRegistry: vi.fn(),
  updateRegistry: vi.fn(),
}));
vi.mock('../src/registry/pricing.js', () => ({
  buildPricingIndex: vi.fn(() => new Map()),
  enrichModelsWithPricing: vi.fn(models => models),
  enrichPricingAsync: vi.fn(),
  loadPricingCache: vi.fn(() => ({ models: [] })),
  pricingPlatformForProvider: vi.fn(),
}));

function registry(): ProviderRegistry {
  return {
    schemaVersion: 1,
    providers: [{
      id: 'openai-chatgpt-plan',
      templateId: 'openai-chatgpt-plan',
      name: 'ChatGPT plan',
      enabled: true,
      authRef: 'keyring:oauth:provider:openai-chatgpt-plan',
      authType: 'oauth',
      api: {},
      addedAt: '2026-08-09T00:00:00.000Z',
    }],
  };
}

function listing(contextWindow: unknown, fields: Record<string, unknown> = {}): Response {
  return {
    ok: true,
    json: async () => ({
      models: [{
        slug: 'gpt-5.6-sol',
        title: 'GPT-5.6 Sol',
        visibility: 'list',
        context_window: contextWindow,
        ...fields,
      }],
    }),
  } as Response;
}

function useCachedPlanProvider(registry: ProviderRegistry) {
  const provider = registry.providers[0]!;
  provider.modelsCache = {
    fetchedAt: '2026-11-18T12:00:00.000Z',
    models: [{ id: 'gpt-6.2-astra', upstreamModelId: 'gpt-6.2-astra', name: 'GPT-6.2 Astra', modelFormat: 'openai' }],
  };
  return provider;
}

let persisted: ProviderRegistry;

beforeEach(() => {
  persisted = registry();
  vi.mocked(io.loadRegistry).mockReturnValue(persisted);
  vi.mocked(io.updateRegistry).mockImplementation(mutate => mutate(persisted));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('publishes only visible ChatGPT plan models from the selected account catalog', async () => {
  const provider = persisted.providers[0]!;
  const fetchModels = vi.fn().mockResolvedValue(Response.json({ models: [
    { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2 Sol', visibility: 'list', use_responses_lite: true, prefer_websockets: true },
    { slug: 'hidden', visibility: 'hide' },
  ] }));
  vi.stubGlobal('fetch', fetchModels);

  const result = await refreshProviderModels(provider.id, 'plan-token', persisted);

  expect(result).toMatchObject({ ok: true, modelSource: 'live', modelCount: 1 });
  expect(persisted.providers[0]?.modelsCache?.models).toMatchObject([{
    id: 'gpt-6.2-sol',
    name: 'GPT-6.2 Sol',
  }]);
  expect(persisted.providers[0]?.modelsCache?.models[0]).not.toHaveProperty('useResponsesLite');
  expect(persisted.providers[0]?.modelsCache?.models[0]).not.toHaveProperty('preferWebSockets');
  expect(fetchModels.mock.calls).toEqual([[
    'https://api.openai.com/v1/models',
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer plan-token' }) }),
  ]]);
});

it.each([
  { label: 'empty catalog', models: [] },
  { label: 'hidden models only', models: [{ slug: 'hidden', visibility: 'hide' }] },
])('clears stale ChatGPT plan models on a live result with $label', async ({ models }) => {
  const provider = useCachedPlanProvider(persisted);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ models })));

  const result = await refreshProviderModels(provider.id, 'plan-token', persisted);

  expect(result).toMatchObject({ ok: true, modelSource: 'live', modelCount: 0 });
  expect(persisted.providers[0]?.modelsCache?.models).toEqual([]);
});

it.each([
  { label: 'malformed schema', status: 200, body: { models: 'invalid' } },
  { label: 'missing visibility', status: 200, body: { models: [{ slug: 'no-visibility' }] } },
  { label: 'HTTP failure', status: 503, body: { error: 'try again later' } },
])('keeps the cached ChatGPT plan catalog on $label', async ({ status, body }) => {
  const provider = useCachedPlanProvider(persisted);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body, { status })));

  const result = await refreshProviderModels(provider.id, 'plan-token', persisted);

  expect(result).toMatchObject({ modelSource: 'cache' });
  expect(persisted.providers[0]?.modelsCache?.models.map(model => model.id)).toEqual(['gpt-6.2-astra']);
});

it('persists a confirmed positive context window from provider metadata', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(listing(272_000)));

  const result = await refreshProviderModels('openai-chatgpt-plan', 'token', persisted);

  expect(result).toMatchObject({ ok: true, modelSource: 'live' });

  expect(persisted.providers[0]?.modelsCache?.models[0]).toMatchObject({
    id: 'gpt-5.6-sol',
    contextWindow: 272_000,
    contextWindowUnconfirmed: undefined,
    reasoning: undefined,
  });
});

it('persists missing context metadata as unconfirmed', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(listing(undefined)));

  const result = await refreshProviderModels('openai-chatgpt-plan', 'token', persisted);

  expect(result).toMatchObject({ ok: true, modelSource: 'live' });

  expect(persisted.providers[0]?.modelsCache?.models[0]).toMatchObject({
    contextWindow: undefined,
    contextWindowUnconfirmed: true,
  });
});

it('persists invalid context metadata as unconfirmed', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(listing(0)));

  const result = await refreshProviderModels('openai-chatgpt-plan', 'token', persisted);

  expect(result).toMatchObject({ ok: true, modelSource: 'live' });

  expect(persisted.providers[0]?.modelsCache?.models[0]).toMatchObject({
    contextWindow: undefined,
    contextWindowUnconfirmed: true,
  });
});

it('preserves provider-reported reasoning and parameter capabilities', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(listing(
    OPENAI_OAUTH_ASTRA_MODEL.context_window,
    { ...OPENAI_OAUTH_ASTRA_MODEL, visibility: 'list' },
  )));

  const result = await refreshProviderModels('openai-chatgpt-plan', 'token', persisted);

  expect(result).toMatchObject({ ok: true, modelSource: 'live' });

  expect(persisted.providers[0]?.modelsCache?.models[0]).toMatchObject({
    id: 'gpt-6-astra',
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    inputTokenLimit: 922_000,
    outputTokenLimit: 128_000,
    reasoning: true,
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultReasoningEffort: 'medium',
    supportsReasoningSummaries: true,
    supportsReasoningSummaryParameter: true,
    supportsParallelToolCalls: true,
    supportsTemperature: false,
  });
});
