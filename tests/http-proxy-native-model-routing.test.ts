import { describe, expect, it } from 'vitest';
import type { ProxyRoute } from '../src/proxy.js';
import { decideHttpProxyRoute } from '../src/http-proxy/routing-decision.js';
import { buildProxyRoutesById } from '../src/http-proxy/server.js';

function vendorClaudeRoute(modelId: string): ProxyRoute {
  return {
    aliasId: `leverframe:vendor:${modelId}`,
    realModelId: modelId,
    displayName: 'Vendor Claude',
    upstreamUrl: 'https://vendor.invalid/v1/messages',
    apiKey: 'vendor-fixture-key',
    modelFormat: 'anthropic',
    npm: '@ai-sdk/anthropic',
    providerId: 'vendor',
  };
}

function decideModelRoute(model: string, routesById: Map<string, ProxyRoute>) {
  return decideHttpProxyRoute({
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer subscription-fixture' },
    rawBody: Buffer.from(JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Hello.' }],
    })),
    routesById,
    hasAdapter: true,
  });
}

describe('native Claude subscription routing', () => {
  it.each(['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-fable-fixture'])(
    'keeps %s on subscription passthrough when a vendor exposes the same model ID',
    modelId => {
      const routesById = buildProxyRoutesById([vendorClaudeRoute(modelId)]);

      expect(decideModelRoute(modelId, routesById).action).toBe('passthrough-messages');
      expect(decideModelRoute(`${modelId}[1m]`, routesById).action).toBe('passthrough-messages');
    },
  );

  it('routes an explicit Leverframe Claude model to the selected vendor', () => {
    const route = vendorClaudeRoute('claude-sonnet-4-6');
    const routesById = buildProxyRoutesById([route]);

    expect(decideModelRoute(route.aliasId, routesById))
      .toMatchObject({ action: 'translated', route });
  });

  it('routes a custom nonnative alias to the selected vendor', () => {
    const route = vendorClaudeRoute('claude-sonnet-4-6');
    const routesById = buildProxyRoutesById([route], [{
      name: 'vendor-sonnet',
      routeId: route.aliasId,
      displayName: 'Vendor Sonnet',
    }]);

    expect(decideModelRoute('vendor-sonnet', routesById))
      .toMatchObject({ action: 'translated', route });
  });
});
