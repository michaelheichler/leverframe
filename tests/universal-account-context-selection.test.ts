import http from 'node:http';
import { expect, it } from 'vitest';
import { handleContextSelectionRequest } from '../src/proxy-context-selection.js';
import type { ProxyRoute } from '../src/proxy-request.js';
import { listen } from './fixtures/account-pool-proxy.js';

it('refreshes context from the account selected by the active route', async () => {
  const route: ProxyRoute = {
    aliasId: 'leverframe:kimi:fixture-model@secondary', realModelId: 'fixture-model',
    displayName: 'Fixture model [HOME]', upstreamUrl: '', apiKey: 'route-key',
    modelFormat: 'openai', providerId: 'kimi', accountId: 'secondary',
  };
  const freshCatalog = {
    providers: [{
      id: 'kimi', name: 'Kimi', apiKey: 'fresh-key', models: [
        { id: 'fixture-model@primary', upstreamModelId: 'fixture-model', accountId: 'primary', name: 'Fixture', family: 'fixture', brand: 'Fixture', modelFormat: 'openai' as const, contextWindow: 90_000 },
        { id: 'fixture-model@secondary', upstreamModelId: 'fixture-model', accountId: 'secondary', name: 'Fixture', family: 'fixture', brand: 'Fixture', modelFormat: 'openai' as const, contextWindow: 210_000 },
      ],
    }],
    unavailable: [],
  };
  const server = http.createServer((request, response) => {
    void handleContextSelectionRequest(request, response, {
      proxyToken: 'proxy-token', byAlias: new Map([[route.aliasId, route]]),
      fetchFreshCatalog: async () => freshCatalog,
    });
  });
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/leverframe/context-selection?model=${encodeURIComponent(route.aliasId)}`, {
      headers: { Authorization: 'Bearer proxy-token' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      model: 'fixture-model',
      options: [{ mode: 'default', contextWindow: 210_000 }],
    });
    expect(route.contextWindow).toBe(210_000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
