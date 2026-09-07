import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRegistry } from '../src/registry/types.js';
import * as io from '../src/registry/io.js';
import { refreshProviderModels } from '../src/registry/refresh-models.js';
import {
  OPENAI_OAUTH_ASTRA_FAILURE,
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

function listing(contextWindow: unknown, fields: Record<string, unknown> = {}): Response {
  return {
    ok: true,
    json: async () => ({
      models: [{
        slug: 'gpt-5.6-sol',
        title: 'GPT-5.6 Sol',
        context_window: contextWindow,
        ...fields,
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

    const result = await refreshProviderModels('openai-oauth', 'token', persisted);

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

    const result = await refreshProviderModels('openai-oauth', 'token', persisted);

    expect(result).toMatchObject({ ok: true, modelSource: 'live' });

    expect(persisted.providers[0]?.modelsCache?.models[0]).toMatchObject({
      contextWindow: undefined,
      contextWindowUnconfirmed: true,
    });
  });

  it('persists invalid context metadata as unconfirmed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(listing(0)));

    const result = await refreshProviderModels('openai-oauth', 'token', persisted);

    expect(result).toMatchObject({ ok: true, modelSource: 'live' });

    expect(persisted.providers[0]?.modelsCache?.models[0]).toMatchObject({
      contextWindow: undefined,
      contextWindowUnconfirmed: true,
    });
  });

  it('preserves provider-reported reasoning and parameter capabilities', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(listing(
      OPENAI_OAUTH_ASTRA_MODEL.context_window,
      OPENAI_OAUTH_ASTRA_MODEL,
    )));

    const result = await refreshProviderModels('openai-oauth', 'token', persisted);

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
      minimalClientVersion: '0.153.0',
      supportsReasoningSummaries: true,
      supportsReasoningSummaryParameter: true,
      supportsParallelToolCalls: true,
      useResponsesLite: true,
      preferWebSockets: true,
      supportsTemperature: false,
    });
  });

  it('does not publish built-in model seeds when discovery fails without a cache', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: OPENAI_OAUTH_ASTRA_FAILURE.status,
      text: async () => OPENAI_OAUTH_ASTRA_FAILURE.body,
    } as Response));

    const result = await refreshProviderModels('openai-oauth', 'token', persisted);

    expect(persisted.providers[0]?.modelsCache).toBeUndefined();
    expect(result.reason).toContain('newer version of Codex');
  });
});
