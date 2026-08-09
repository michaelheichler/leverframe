import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRegistry } from '../src/registry/types.js';
import * as io from '../src/registry/io.js';
import { refreshProviderModels } from '../src/registry/refresh-models.js';

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
vi.mock('../src/launch.js', () => ({
  getInstalledClaudeVersion: vi.fn(() => '2.1.220'),
}));

function registry(): ProviderRegistry {
  return {
    schemaVersion: 1,
    providers: [{
      id: 'openai-oauth',
      templateId: 'openai-oauth',
      name: 'OpenAI (ChatGPT)',
      enabled: true,
      authRef: 'keyring:oauth:provider:openai-oauth',
      authType: 'oauth',
      api: {},
      addedAt: '2026-08-09T00:00:00.000Z',
    }],
  };
}

function listing(contextWindow: unknown): Response {
  return {
    ok: true,
    json: async () => ({
      models: [{
        slug: 'gpt-5.6-sol',
        title: 'GPT-5.6 Sol',
        context_window: contextWindow,
      }],
    }),
  } as Response;
}

describe('OpenAI OAuth model refresh', () => {
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

  it('persists a confirmed positive context window from provider metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(listing(272_000)));

    await refreshProviderModels('openai-oauth', 'token', persisted);

    expect(persisted.providers[0]?.modelsCache?.models[0]).toMatchObject({
      id: 'gpt-5.6-sol',
      contextWindow: 272_000,
      contextWindowUnconfirmed: undefined,
    });
  });

  it('persists missing context metadata as unconfirmed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(listing(undefined)));

    await refreshProviderModels('openai-oauth', 'token', persisted);

    expect(persisted.providers[0]?.modelsCache?.models[0]).toMatchObject({
      contextWindow: undefined,
      contextWindowUnconfirmed: true,
    });
  });

  it('persists invalid context metadata as unconfirmed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(listing(0)));

    await refreshProviderModels('openai-oauth', 'token', persisted);

    expect(persisted.providers[0]?.modelsCache?.models[0]).toMatchObject({
      contextWindow: undefined,
      contextWindowUnconfirmed: true,
    });
  });

  it('persists the unconfirmed seed when discovery fails without a cache', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'unavailable',
    } as Response));

    await refreshProviderModels('openai-oauth', 'token', persisted);

    expect(persisted.providers[0]?.modelsCache?.models.find(model => model.id === 'gpt-5.6-sol')).toMatchObject({
      contextWindow: undefined,
      contextWindowUnconfirmed: true,
    });
  });
});
