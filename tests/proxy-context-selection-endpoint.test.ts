import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { fetchFreshProviderCatalog } from '../src/provider-catalog.js';

vi.mock('../src/execution-tracking.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/execution-tracking.js')>(),
  reconcileExecutionsAtStartup: vi.fn(() => []),
}));

vi.mock('../src/provider-catalog.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/provider-catalog.js')>();
  return {
    ...actual,
    fetchFreshProviderCatalog: vi.fn(async () => ({
      providers: [{
        id: 'openai-oauth',
        name: 'OpenAI OAuth',
        apiKey: 'provider-key',
        models: [{
          id: 'gpt-5.6-luna',
          name: 'GPT-5.6 Luna',
          family: 'gpt',
          brand: 'GPT',
          modelFormat: 'openai' as const,
          upstreamModelId: 'gpt-5.6-luna',
          contextWindow: 400_000,
          maxContextWindow: 1_200_000,
        }],
      }],
      unavailable: [],
    })),
  };
});

function getJson(port: number, token: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port,
      path,
      headers: { Authorization: `Bearer ${token}` },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
  });
}

describe('context selection endpoint', () => {
  it.each(['unconfirmed', 'missing'] as const)('explicitly confirms live identity with %s context and clears old route metadata', async context => {
    const route: ProxyRoute = {
      aliasId: 'anthropic-openai-oauth__gpt-5.6-luna',
      realModelId: 'gpt-5.6-luna',
      displayName: 'GPT-5.6 Luna',
      upstreamUrl: 'https://api.openai.com/v1',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      providerId: 'openai-oauth',
      contextWindow: 400_000,
      maxContextWindow: 1_200_000,
    };
    const catalog = await fetchFreshProviderCatalog({ agent: 'claude' });
    const model = catalog.providers[0]!.models[0]!;
    if (context === 'unconfirmed') model.contextWindowUnconfirmed = true;
    else {
      model.contextWindow = undefined;
      model.maxContextWindow = undefined;
    }
    vi.mocked(fetchFreshProviderCatalog).mockResolvedValueOnce(catalog);
    const proxy = await startProxyCatalog([route], route.aliasId, false);
    try {
      const response = await getJson(proxy.port, proxy.token,
        '/v1/leverframe/context-selection?model=' + encodeURIComponent(route.aliasId + '[maximum]'));
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        model: route.realModelId,
        contextWindowUnconfirmed: true,
        options: [],
      });
      const metadata = await getJson(proxy.port, proxy.token, '/v1/leverframe/context-metadata');
      expect(JSON.parse(metadata.body)).toEqual({ contextWindows: {} });
      const models = await getJson(proxy.port, proxy.token, '/v1/models');
      expect(JSON.parse(models.body).data[0].context_window).toBeUndefined();
    } finally {
      await proxy.close();
    }
  });

  it.each(['failed', 'missing', 'unavailable'] as const)(
    'keeps %s live discovery an error rather than offering provider default',
    async failure => {
      const route: ProxyRoute = {
        aliasId: 'anthropic-openai-oauth__gpt-5.6-luna',
        realModelId: 'gpt-5.6-luna',
        displayName: 'GPT-5.6 Luna',
        upstreamUrl: 'https://api.openai.com/v1',
        apiKey: 'provider-key',
        modelFormat: 'openai',
        providerId: 'openai-oauth',
      };
      const catalog = await fetchFreshProviderCatalog({ agent: 'claude' });
      if (failure === 'failed') vi.mocked(fetchFreshProviderCatalog).mockRejectedValueOnce(new Error('offline'));
      else if (failure === 'missing') vi.mocked(fetchFreshProviderCatalog).mockResolvedValueOnce({ providers: [], unavailable: [] });
      else {
        vi.mocked(fetchFreshProviderCatalog).mockResolvedValueOnce({
          ...catalog,
          unavailable: [{ providerId: 'openai-oauth', providerName: 'OpenAI OAuth', reason: 'offline' }],
        });
      }
      const proxy = await startProxyCatalog([route], route.aliasId, false);
      try {
        const response = await getJson(proxy.port, proxy.token,
          '/v1/leverframe/context-selection?model=' + encodeURIComponent(route.aliasId));
        expect(response.status).toBe(503);
        expect(JSON.parse(response.body)).toHaveProperty('error');
        expect(JSON.parse(response.body)).not.toHaveProperty('contextWindowUnconfirmed');
      } finally {
        await proxy.close();
      }
    },
  );

  it('resolves the canonical picker identity through the live proxy route', async () => {
    const route: ProxyRoute = {
      aliasId: 'anthropic-openai-oauth__gpt-5.6-luna',
      realModelId: 'gpt-5.6-luna',
      displayName: 'GPT-5.6 Luna (OpenAI OAuth)',
      upstreamUrl: 'https://api.openai.com/v1',
      apiKey: 'provider-key',
      modelFormat: 'openai',
      providerId: 'openai-oauth',
      contextWindow: 272_000,
      maxContextWindow: 872_000,
    };
    const proxy = await startProxyCatalog(
      [route],
      route.aliasId,
      false,
      undefined,
      undefined,
      undefined,
      [
        { name: 'leverframe:openai-oauth:gpt-5.6-luna', routeId: route.aliasId },
        { name: 'atlas', routeId: route.aliasId },
      ],
    );
    try {
      const response = await getJson(
        proxy.port,
        proxy.token,
        '/v1/leverframe/context-selection?model=' + encodeURIComponent('leverframe:openai-oauth:gpt-5.6-luna'),
      );
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        model: 'gpt-5.6-luna',
        options: [
          { mode: 'default', contextWindow: 400_000, label: 'Default (400,000)' },
          { mode: 'maximum', contextWindow: 1_200_000, label: 'Maximum (1,200,000)' },
        ],
      });
      const customAlias = await getJson(
        proxy.port,
        proxy.token,
        '/v1/leverframe/context-selection?model=atlas',
      );
      expect(customAlias.status).toBe(200);
      expect(JSON.parse(customAlias.body)).toEqual(JSON.parse(response.body));
      const maximum = await getJson(
        proxy.port,
        proxy.token,
        '/v1/leverframe/context-selection?model=' + encodeURIComponent('leverframe:openai-oauth:gpt-5.6-luna[maximum]'),
      );
      expect(maximum.status).toBe(200);
      const models = await getJson(proxy.port, proxy.token, '/v1/models');
      expect(JSON.parse(models.body).data[0]).toMatchObject({ context_window: 400_000 });
    } finally {
      await proxy.close();
    }
  });
});
