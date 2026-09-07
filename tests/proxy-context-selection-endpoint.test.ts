import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';

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
