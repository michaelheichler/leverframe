import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPreferences } from '../src/config.js';
import { formatHttpProxyModelLines, loadHttpProxyRoutes } from '../src/http-proxy/index.js';
import { fetchFreshProviderCatalog } from '../src/provider-catalog.js';
import type { ProxyRoute } from '../src/proxy.js';

vi.mock('../src/config.js', () => ({
  loadPreferences: vi.fn(() => ({
    favoriteModels: [{ providerId: 'openai', modelId: 'gpt-5.6-sol' }],
    modelAliases: [{ name: 'sol', providerId: 'openai', modelId: 'gpt-5.6-sol' }],
  })),
}));

vi.mock('../src/provider-catalog.js', () => ({
  fetchFreshProviderCatalog: vi.fn(async () => ({
    providers: [{
      id: 'openai',
      name: 'OpenAI',
      apiKey: '',
      models: [{
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        modelFormat: 'openai',
        npm: '@ai-sdk/openai',
        contextWindow: 272_000,
      }],
    }],
    unavailable: [],
  })),
  resolveLocalProviderApiKey: vi.fn(async () => 'test-key'),
}));

vi.mock('../src/target-compatibility.js', () => ({
  providersForTarget: vi.fn((providers: unknown[]) => providers),
}));

describe('loadHttpProxyRoutes', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('builds routes and wires alias names from favorites and saved aliases', async () => {
    const loaded = await loadHttpProxyRoutes();
    expect(loaded.favoriteCount).toBe(1);
    expect(loaded.routes).toHaveLength(1);
    expect(loaded.routes[0]?.aliasId).toContain('gpt-5.6-sol');
    expect(loaded.aliases).toEqual([{
      name: 'sol',
      routeId: loaded.routes[0]!.aliasId,
      displayName: expect.any(String),
    }]);
    expect(loaded.providers).toHaveLength(1);
    expect(loaded.freshUnavailable).toEqual([]);
  });

  it('uses the fresh catalog when no favorites are saved', async () => {
    vi.mocked(loadPreferences).mockReturnValueOnce({ modelAliases: [] });

    const loaded = await loadHttpProxyRoutes();

    expect(loaded.favoriteCount).toBe(0);
    expect(loaded.routes).toHaveLength(1);
    expect(loaded.routes[0]?.aliasId).toContain('gpt-5.6-sol');
  });

  it('does not expose stale routes when fresh discovery reports unavailable', async () => {
    vi.mocked(fetchFreshProviderCatalog).mockResolvedValueOnce({
      providers: [],
      unavailable: [{
        providerId: 'openai',
        providerName: 'OpenAI',
        modelIds: ['gpt-5.6-sol'],
        reason: 'Provider authentication expired',
      }],
    });

    const loaded = await loadHttpProxyRoutes();

    expect(loaded.routes).toEqual([]);
    expect(loaded.providers).toEqual([]);
    expect(loaded.freshUnavailable).toMatchObject([{
      providerId: 'openai',
      modelIds: ['gpt-5.6-sol'],
    }]);
  });

  it('exposes only models that have an active HTTP-proxy route', async () => {
    vi.mocked(fetchFreshProviderCatalog).mockResolvedValueOnce({
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          apiKey: '',
          models: [{
            id: 'gpt-5.6-sol',
            name: 'GPT-5.6 Sol',
            family: 'gpt',
            brand: 'OpenAI',
            modelFormat: 'openai',
            upstreamModelId: 'gpt-5.6-sol',
            npm: '@ai-sdk/openai',
            contextWindow: 272_000,
          }],
        },
        {
          id: 'anthropic',
          name: 'Anthropic',
          apiKey: '',
          models: [{
            id: 'claude-sonnet',
            name: 'Claude Sonnet',
            family: 'claude',
            brand: 'Anthropic',
            modelFormat: 'anthropic',
            upstreamModelId: 'claude-sonnet',
            baseUrl: 'https://api.anthropic.com',
            contextWindow: 272_000,
          }],
        },
      ],
      unavailable: [],
    });
    vi.mocked(loadPreferences).mockReturnValueOnce({ favoriteModels: [] });

    const loaded = await loadHttpProxyRoutes();

    expect(loaded.routes).toHaveLength(1);
    expect(loaded.providers.flatMap(provider => provider.models.map(model => model.id))).toEqual(['gpt-5.6-sol']);
  });
});

describe('HTTP proxy startup model list', () => {
  it('does not label unavailable favorites as incompatible when no route is available', () => {
    expect(formatHttpProxyModelLines([])).toEqual(['  (no routable external models)']);
  });

  it('prints the available context beside the full model name', () => {
    const route: ProxyRoute = {
      aliasId: 'leverframe:openai-oauth:gpt-5.6-sol',
      realModelId: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol (OpenAI (ChatGPT))',
      upstreamUrl: '',
      apiKey: 'oauth-token',
      modelFormat: 'openai',
      contextWindow: 272_000,
    };
    const lines = formatHttpProxyModelLines([route], [{
      name: 'sol',
      routeId: route.aliasId,
      displayName: route.displayName,
    }]);

    expect(lines[0]).toContain('GPT-5.6 Sol (OpenAI (ChatGPT)) (272K context)');
    expect(lines[1]).toContain('GPT-5.6 Sol (OpenAI (ChatGPT)) (272K context)');
  });
});
