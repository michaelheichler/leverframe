import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchFreshProviderCatalog: vi.fn(),
  fetchProviderCatalog: vi.fn(async () => []),
  localProvidersToServerModels: vi.fn(() => [{
    id: 'claude-native',
    name: 'Claude Native',
    providerId: 'anthropic',
    providerLabel: 'Anthropic',
    sourceBackend: 'anthropic',
    modelFormat: 'anthropic',
    upstreamModelId: 'claude-native',
  }]),
  getReasoningCapabilities: vi.fn(() => ({ defaultLevel: undefined })),
}));

vi.mock('../src/provider-catalog.js', () => ({
  fetchFreshProviderCatalog: mocks.fetchFreshProviderCatalog,
  fetchProviderCatalog: mocks.fetchProviderCatalog,
  localProvidersToServerModels: mocks.localProvidersToServerModels,
}));

vi.mock('../src/provider-factory.js', () => ({
  getReasoningCapabilities: mocks.getReasoningCapabilities,
}));

import { loadServerModels } from '../src/server/index.js';

describe('server startup catalog', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses the fresh catalog while retaining native Anthropic passthrough models', async () => {
    mocks.fetchFreshProviderCatalog.mockResolvedValue({
      providers: [{
        id: 'anthropic',
        name: 'Anthropic',
        apiKey: '',
        models: [{
          id: 'claude-native',
          name: 'Claude Native',
          family: 'claude',
          brand: 'Anthropic',
          modelFormat: 'anthropic',
          upstreamModelId: 'claude-native',
        }],
      }],
      unavailable: [],
    });

    const models = await loadServerModels();

    expect(mocks.fetchFreshProviderCatalog).toHaveBeenCalledWith({ agent: 'server' });
    expect(mocks.fetchProviderCatalog).not.toHaveBeenCalled();
    expect(models.map(model => model.id)).toEqual(['claude-native']);
  });
});
