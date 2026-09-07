import { describe, expect, it } from 'vitest';
import { applyFreshContextSelection } from '../src/proxy-context-selection.js';
import { lookupRoute, proxyRuntimeRouteKey, type ProxyRoute } from '../src/proxy-request.js';

function route(): ProxyRoute {
  return {
    aliasId: 'leverframe:provider:model',
    realModelId: 'model',
    displayName: 'Model',
    upstreamUrl: 'https://example.test/v1',
    apiKey: 'secret',
    modelFormat: 'openai',
    providerId: 'provider',
    contextWindow: 272_000,
    maxContextWindow: 872_000,
  };
}

describe('fresh proxy context selection', () => {
  it('updates the live route when fresh limits change between picker opens', () => {
    const active = route();
    expect(applyFreshContextSelection(active, {
      contextWindow: 300_000,
      maxContextWindow: 900_000,
    })).toEqual([
      { mode: 'default', contextWindow: 300_000, label: 'Default (300,000)' },
      { mode: 'maximum', contextWindow: 900_000, label: 'Maximum (900,000)' },
    ]);
    expect(active.contextWindow).toBe(300_000);
    expect(active.maxContextWindow).toBe(900_000);

    expect(applyFreshContextSelection(active, {
      contextWindow: 400_000,
      maxContextWindow: 1_200_000,
    })).toEqual([
      { mode: 'default', contextWindow: 400_000, label: 'Default (400,000)' },
      { mode: 'maximum', contextWindow: 1_200_000, label: 'Maximum (1,200,000)' },
    ]);
    const byAlias = new Map([[active.aliasId, active]]);
    expect(lookupRoute(byAlias, active.aliasId + '[maximum]')?.contextWindow).toBe(1_200_000);
  });

  it('does not mutate a route when fresh context is unconfirmed', () => {
    const active = route();
    expect(applyFreshContextSelection(active, {
      contextWindow: 300_000,
      maxContextWindow: 900_000,
      contextWindowUnconfirmed: true,
    })).toEqual([]);
    expect(active.contextWindow).toBe(272_000);
    expect(active.maxContextWindow).toBe(872_000);
  });

  it('shares credential runtime state across default and maximum aliases', () => {
    const active = route();
    expect(proxyRuntimeRouteKey(active)).toBe(proxyRuntimeRouteKey({
      ...active,
      aliasId: `${active.aliasId}[maximum]`,
      contextWindow: 872_000,
    }));
    expect(proxyRuntimeRouteKey(active)).toBe(proxyRuntimeRouteKey({
      ...active,
      aliasId: `${active.aliasId}[default]`,
    }));
    const withoutProvider = { ...active, providerId: undefined };
    expect(proxyRuntimeRouteKey(withoutProvider)).toBe(proxyRuntimeRouteKey({
      ...withoutProvider,
      aliasId: `${withoutProvider.aliasId}[maximum]`,
    }));
  });
});
