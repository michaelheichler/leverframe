import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTemplateById } from '../src/provider-templates.js';
import { addProviderFromTemplate } from '../src/registry/add-template.js';
import * as env from '../src/env.js';
import * as io from '../src/registry/io.js';
import * as pricing from '../src/registry/pricing.js';

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

const zai = () => getTemplateById('zai')!;

describe('z.ai Coding Plan live key verification', () => {
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

  it('validates the key against the live Coding Plan models endpoint and caches its models', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [
          { id: 'glm-4.7' },
          { id: 'glm-5-turbo' },
          { id: 'glm-5.2' },
        ],
      }),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await addProviderFromTemplate(zai(), 'test-key');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.z.ai/api/coding/paas/v4/models',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    );
    expect(result.added).toBe(true);
    expect(result.keyVerified).toBe(true);
    expect(result.provider?.modelsCache?.models.map(model => model.id)).toEqual([
      'glm-4.7',
      'glm-5-turbo',
      'glm-5.2',
    ]);
  });

  it('overlays the declared one-million-token context on conflicting live GLM-5.2 metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{ id: 'glm-5.2', name: 'GLM-5.2 live', context_length: 128_000 }],
      }),
    } as Response));

    const result = await addProviderFromTemplate(zai(), 'test-key');

    expect(result.keyVerified).toBe(true);
    expect(result.provider?.modelsCache?.models[0]).toMatchObject({
      id: 'glm-5.2',
      name: 'GLM-5.2 live',
      contextWindow: 1_000_000,
    });
  });

  it('rejects a 401 response without persisting the credential or registry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid api key',
    } as Response));

    const result = await addProviderFromTemplate(zai(), 'test-key');

    expect(result.added).toBe(false);
    expect(result.error).toMatch(/rejected/i);
    expect(env.saveProviderCredential).not.toHaveBeenCalled();
    expect(io.saveRegistry).not.toHaveBeenCalled();
  });

  it('uses the documented static models after a 5xx response and stores the key unverified', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
    } as Response));

    const result = await addProviderFromTemplate(zai(), 'test-key');

    expect(result.added).toBe(true);
    expect(result.keyVerified).toBe(false);
    expect(result.provider?.modelsCache?.models.map(model => model.id)).toEqual([
      'glm-5.2',
      'glm-5-turbo',
      'glm-4.7',
    ]);
    expect(result.provider?.modelsCache?.models[0]?.contextWindow).toBe(1_000_000);
    expect(result.hint).toMatch(/listing.*unavailable|did not verify/i);
  });
});
