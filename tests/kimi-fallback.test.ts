import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { addProviderFromTemplate } from '../src/registry/add-template.js';
import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';
import { getTemplateById } from '../src/provider-templates.js';
import * as env from '../src/env.js';
import * as io from '../src/registry/io.js';
import * as pricing from '../src/registry/pricing.js';
import type { ProviderRegistry } from '../src/registry/types.js';

vi.mock('../src/env.js', () => ({
  saveProviderCredential: vi.fn(),
  resolveProviderCredential: vi.fn(),
}));
vi.mock('../src/provider-factory.js', () => ({ isSdkMigratedNpm: vi.fn(() => true) }));
vi.mock('../src/registry/io.js', () => ({
  loadRegistry: vi.fn(),
  saveRegistry: vi.fn(),
}));
vi.mock('../src/registry/pricing.js', () => ({
  loadPricingCache: vi.fn(),
  enrichModelsWithPricing: vi.fn(),
  enrichPricingAsync: vi.fn(),
  pricingPlatformForProvider: vi.fn(),
  buildPricingIndex: vi.fn(),
}));

const kimi = () => getTemplateById('kimi')!;

describe('Kimi api-list fallback to staticModels (addProviderFromTemplate)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(env.saveProviderCredential).mockResolvedValue(true);
    vi.mocked(io.loadRegistry).mockReturnValue({ version: 1, providers: [] });
    vi.mocked(pricing.enrichModelsWithPricing).mockImplementation(
      (models: unknown) => models as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('falls back to static seed on HTTP 500 and stores key unverified', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'upstream boom',
    } as Response));

    const result = await addProviderFromTemplate(kimi(), 'sk-kimi-live');
    expect(result.added).toBe(true);
    expect(result.keyVerified).toBe(false);
    expect(result.modelCount).toBeGreaterThan(0);
    expect(result.hint).toMatch(/listing.*unavailable|stored.*without verify|did not verify/i);

    const saved = vi.mocked(io.saveRegistry).mock.calls[0]?.[0] as ProviderRegistry;
    const k3 = saved.providers[0]?.modelsCache?.models.find(m => m.id === 'k3');
    expect(k3?.contextWindow).toBe(1_048_576);
    expect(env.saveProviderCredential).toHaveBeenCalledWith('keyring:provider:kimi', 'sk-kimi-live');
  });

  it('caches declared Kimi context over conflicting live metadata and verifies the key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [
          {
            id: 'k3',
            name: 'K3 from live API',
            context_length: 200_000,
            supported_parameters: ['tools'],
          },
          { id: 'future-kimi', name: 'Future Kimi', context_length: 300_000 },
        ],
      }),
    } as Response));

    const result = await addProviderFromTemplate(kimi(), 'sk-kimi-verified');

    expect(result.added).toBe(true);
    expect(result.keyVerified).toBe(true);
    const cachedModels = result.provider?.modelsCache?.models;
    expect(cachedModels?.find(model => model.id === 'k3')).toMatchObject({
      name: 'K3 from live API',
      contextWindow: 1_048_576,
      supportedParameters: ['tools'],
    });
    expect(cachedModels?.find(model => model.id === 'future-kimi')?.contextWindow).toBe(300_000);
  });

  it('falls back to static seed on network failure and stores key unverified', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      throw new Error('fetch failed');
    }));

    const result = await addProviderFromTemplate(kimi(), 'sk-kimi-net');
    expect(result.added).toBe(true);
    expect(result.keyVerified).toBe(false);

    const saved = vi.mocked(io.saveRegistry).mock.calls[0]?.[0] as ProviderRegistry;
    const k3 = saved.providers[0]?.modelsCache?.models.find(m => m.id === 'k3');
    expect(k3?.contextWindow).toBe(1_048_576);
  });

  it('falls back to static seed on empty successful list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [] }),
    } as Response));

    const result = await addProviderFromTemplate(kimi(), 'sk-kimi-empty');
    expect(result.added).toBe(true);
    expect(result.keyVerified).toBe(false);
    expect(result.modelCount).toBe(kimi().staticModels?.length ?? 0);
  });

  it('does NOT fall back on 401 auth rejection; rejects and persists nothing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid api key',
    } as Response));

    const result = await addProviderFromTemplate(kimi(), 'sk-kimi-bad');
    expect(result.added).toBe(false);
    expect(result.error).toMatch(/rejected/i);
    expect(env.saveProviderCredential).not.toHaveBeenCalled();
    expect(io.saveRegistry).not.toHaveBeenCalled();
  });

  it('does NOT fall back on 403 auth rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'forbidden',
    } as Response));

    const result = await addProviderFromTemplate(kimi(), 'sk-kimi-403');
    expect(result.added).toBe(false);
    expect(result.error).toMatch(/rejected/i);
    expect(env.saveProviderCredential).not.toHaveBeenCalled();
  });

  it.each([
    ['redirect', 302],
    ['non-auth client error', 429],
  ])('does NOT fall back on %s', async (_label, status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status,
      text: async () => 'not eligible for fallback',
    } as Response));

    const result = await addProviderFromTemplate(kimi(), `sk-kimi-${status}`);
    expect(result.added).toBe(false);
    expect(env.saveProviderCredential).not.toHaveBeenCalled();
    expect(io.saveRegistry).not.toHaveBeenCalled();
  });
});

describe('Kimi api-list fallback to staticModels (fetchTemplateModels)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the Coding Plan models endpoint and preserves the exact live IDs', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [
          { id: 'k3' },
          { id: 'kimi-for-coding' },
          { id: 'kimi-for-coding-highspeed' },
        ],
      }),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchTemplateModels(kimi(), 'test-membership-key');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.kimi.com/coding/v1/models',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    );
    expect(result.usedStaticFallback).toBeUndefined();
    expect(result.models.map(model => model.id)).toEqual([
      'k3',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ]);
    expect(result.models[0]?.contextWindow).toBe(1_048_576);
  });

  it('returns usedStaticFallback=true on 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
    } as Response));

    const result = await fetchTemplateModels(kimi(), 'sk-kimi-503');
    expect(result.usedStaticFallback).toBe(true);
    expect(result.models.map(m => m.id)).toEqual(['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed']);
    expect(result.models.find(m => m.id === 'k3')?.contextWindow).toBe(1_048_576);
    expect(result.error).toBeUndefined();
  });

  it('returns usedStaticFallback=true on network throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      throw new Error('network unreachable');
    }));

    const result = await fetchTemplateModels(kimi(), 'sk-kimi-throw');
    expect(result.usedStaticFallback).toBe(true);
    expect(result.models.length).toBeGreaterThan(0);
  });

  it('returns usedStaticFallback=true on empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [] }),
    } as Response));

    const result = await fetchTemplateModels(kimi(), 'sk-kimi-emptylist');
    expect(result.usedStaticFallback).toBe(true);
    expect(result.models.length).toBeGreaterThan(0);
  });

  it('returns an error, not a fallback, on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'bad',
    } as Response));

    const result = await fetchTemplateModels(kimi(), 'sk-kimi-401-fetch');
    expect(result.usedStaticFallback).toBeUndefined();
    expect(result.models).toHaveLength(0);
    expect(result.error).toMatch(/rejected/i);
  });

  it.each([
    ['redirect', 302],
    ['non-auth client error', 429],
  ])('returns an error, not a fallback, on %s', async (_label, status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status,
      text: async () => 'not eligible for fallback',
    } as Response));

    const result = await fetchTemplateModels(kimi(), `sk-kimi-fetch-${status}`);
    expect(result.usedStaticFallback).toBeUndefined();
    expect(result.models).toHaveLength(0);
    expect(result.error).toBeTruthy();
  });

  it('OpenAI (no staticModels) does NOT fall back on network failure', async () => {
    const openai = getTemplateById('openai')!;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      throw new Error('network down');
    }));

    const result = await fetchTemplateModels(openai, 'sk-openai-net');
    expect(result.usedStaticFallback).toBeUndefined();
    expect(result.models).toHaveLength(0);
    expect(result.error).toMatch(/reach the provider|timed out/i);
  });
});
