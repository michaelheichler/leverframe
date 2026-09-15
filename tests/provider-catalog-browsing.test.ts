import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProvider } from '../src/types.js';
import type { ProviderRegistry, RegistryProvider } from '../src/registry/types.js';
import type { RefreshModelsResult } from '../src/registry/refresh-models.js';
import {
  fetchBrowsingProviderCatalog,
  fetchFreshProviderCatalog,
  fetchProviderCatalog,
} from '../src/provider-catalog.js';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  load: vi.fn(),
  registry: vi.fn(),
}));
vi.mock('../src/registry/refresh-models.js', () => ({ refreshAllProviderModels: mocks.refresh }));
vi.mock('../src/registry/load.js', () => ({ loadRegistryProviders: mocks.load }));
vi.mock('../src/registry/io.js', () => ({ loadRegistry: mocks.registry }));

const local: LocalProvider = {
  id: 'github-copilot',
  name: 'GitHub Copilot',
  apiKey: '',
  models: [{
    id: 'new-live-model', upstreamModelId: 'new-live-model', name: 'New live model', family: 'gpt', brand: 'OpenAI',
    modelFormat: 'openai', contextWindowUnconfirmed: true,
  }],
};
const entry: RegistryProvider = {
  id: local.id, templateId: local.id, name: local.name, enabled: true,
  authRef: 'keyring:oauth:provider:github-copilot',
  api: {}, addedAt: '2026-01-01T00:00:00Z',
  modelsCache: {
    fetchedAt: '2026-09-14T12:00:00Z',
    models: [{ id: 'new-live-model', name: 'New live model', upstreamModelId: 'new-live-model', modelFormat: 'openai' }],
  },
};
const live: RefreshModelsResult = {
  refreshed: [{ id: local.id, name: local.name, ok: true, modelSource: 'live' }],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.refresh.mockResolvedValue(live);
  mocks.load.mockResolvedValue([local]);
  mocks.registry.mockReturnValue({ schemaVersion: 1, providers: [entry] } satisfies ProviderRegistry);
});

describe('browsing catalog freshness', () => {
  it('refreshes before loading models and includes the live source and timestamp', async () => {
    const result = await fetchBrowsingProviderCatalog();
    expect(mocks.refresh.mock.invocationCallOrder[0]).toBeLessThan(mocks.load.mock.invocationCallOrder[0]!);
    expect(result.providers).toEqual([local]);
    expect(result.statuses).toEqual([{
      providerId: local.id, providerName: local.name, source: 'live',
      fetchedAt: entry.modelsCache!.fetchedAt, reason: undefined,
    }]);
  });

  it('keeps cached browsing separate from execution routes after a failed refresh', async () => {
    mocks.refresh.mockResolvedValue({
      refreshed: [{ id: local.id, name: local.name, ok: false, modelSource: 'cache', reason: 'Authentication expired' }],
    });
    const [browsing, execution] = await Promise.all([
      fetchBrowsingProviderCatalog(), fetchFreshProviderCatalog(),
    ]);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(browsing.providers).toEqual([local]);
    expect(browsing.statuses[0]).toMatchObject({ source: 'cache', reason: 'Authentication expired' });
    expect(execution.providers).toEqual([]);
    expect(execution.unavailable[0]?.reason).toBe('Authentication expired');
  });

  it.each(['seed', 'fallback'] as const)('labels %s results as non-live', async source => {
    mocks.refresh.mockResolvedValue({
      refreshed: [{ id: local.id, name: local.name, ok: true, modelSource: source, reason: 'Discovery unavailable' }],
    });
    expect((await fetchBrowsingProviderCatalog()).statuses[0]).toMatchObject({ source, reason: 'Discovery unavailable' });
  });

  it('reports refresh exceptions explicitly rather than claiming cache is live', async () => {
    mocks.refresh.mockRejectedValue(new Error('Refresh failed'));
    expect((await fetchBrowsingProviderCatalog()).statuses[0]).toMatchObject({
      source: 'cache', reason: 'Refresh failed',
    });
  });

  it('reports unavailability when a configured provider has no cached models', async () => {
    mocks.registry.mockReturnValue({ schemaVersion: 1, providers: [{ ...entry, modelsCache: undefined }] });
    mocks.load.mockResolvedValue([]);
    mocks.refresh.mockResolvedValue({ refreshed: [] });
    expect((await fetchBrowsingProviderCatalog()).statuses[0]).toMatchObject({ source: 'unavailable' });
  });

  it('does not expose disabled providers in the browsing status', async () => {
    mocks.registry.mockReturnValue({ schemaVersion: 1, providers: [{ ...entry, enabled: false }] });
    mocks.load.mockResolvedValue([]);
    expect(await fetchBrowsingProviderCatalog()).toEqual({ providers: [], statuses: [] });
  });

  it('shares only refresh work across agent-specific catalogs and refreshes again later', async () => {
    let release!: (result: RefreshModelsResult) => void;
    mocks.refresh.mockImplementationOnce(() => new Promise<RefreshModelsResult>(resolve => { release = resolve; }));
    mocks.load.mockImplementation(async (_diag, opts) => opts?.agent === 'server' ? [] : [local]);
    const claude = fetchFreshProviderCatalog({ agent: 'claude' });
    const server = fetchFreshProviderCatalog({ agent: 'server' });
    const browsing = fetchBrowsingProviderCatalog();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    release(live);
    const results = await Promise.all([claude, server, browsing]);
    expect(results[0].providers[0]?.models[0]?.id).toBe('new-live-model');
    expect(results[1].providers).toEqual([]);
    expect(results[2].providers).toEqual([local]);
    await fetchFreshProviderCatalog();
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });

  it('preserves the cache-only loader contract for existing callers', async () => {
    expect(await fetchProviderCatalog()).toEqual([local]);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
