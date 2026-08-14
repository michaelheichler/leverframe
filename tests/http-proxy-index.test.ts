import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatHttpProxyModelLines, loadHttpProxyRoutes } from '../src/http-proxy/index.js';
import type { ProxyRoute } from '../src/proxy.js';

vi.mock('../src/config.js', () => ({
  loadPreferences: vi.fn(() => ({
    favoriteModels: [{ providerId: 'openai', modelId: 'gpt-5.6-sol' }],
    modelAliases: [{ name: 'sol', providerId: 'openai', modelId: 'gpt-5.6-sol' }],
  })),
}));

vi.mock('../src/provider-catalog.js', () => ({
  fetchProviderCatalog: vi.fn(async () => ([{
    id: 'openai',
    name: 'OpenAI',
    models: [{
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      contextWindow: 272_000,
    }],
  }])),
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
  });
});

describe('HTTP proxy startup model list', () => {
  it('does not label unavailable favorites as incompatible when no route is available', () => {
    expect(formatHttpProxyModelLines([])).toEqual(['  (no routable favorite models)']);
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
