import { describe, expect, it } from 'vitest';
import { contextModeModelId } from '../src/context-model-id.js';
import { lookupRoute, type ProxyRoute } from '../src/proxy-request.js';

function route(overrides: Partial<ProxyRoute> = {}): ProxyRoute {
  return {
    aliasId: 'anthropic-openai__gpt-6-astra',
    realModelId: 'gpt-6-astra',
    displayName: 'GPT-6 Astra (OpenAI)',
    upstreamUrl: 'https://example.test/v1/chat/completions',
    apiKey: 'test-key',
    modelFormat: 'openai',
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    npm: '@ai-sdk/openai',
    ...overrides,
  };
}

describe('lookupRoute context mode', () => {
  it('resolves the maximum mode against route metadata while keeping the upstream id', () => {
    const selected = lookupRoute(new Map([[route().aliasId, route()]]), contextModeModelId(route().aliasId, 'maximum'));
    expect(selected).toMatchObject({
      contextWindow: 872_000,
      realModelId: 'gpt-6-astra',
      aliasId: 'anthropic-openai__gpt-6-astra[maximum]',
    });
  });

  it('maps the legacy [1m] suffix to the reported maximum when the default is smaller', () => {
    const base = route({ contextWindow: 413_579, maxContextWindow: 1_203_017 });
    const legacyId = `${base.aliasId}[1m]`;
    const selected = lookupRoute(new Map([[base.aliasId, base]]), legacyId);

    expect(selected).toMatchObject({
      aliasId: legacyId,
      contextWindow: 1_203_017,
      realModelId: base.realModelId,
    });
  });

  it('keeps the reported default for a legacy [1m] suffix when that default reaches 1M', () => {
    const base = route({ contextWindow: 1_048_576, maxContextWindow: 1_203_017 });
    const selected = lookupRoute(new Map([[base.aliasId, base]]), `${base.aliasId}[1m]`);

    expect(selected?.contextWindow).toBe(1_048_576);
  });

  it('rejects a legacy [1m] suffix when neither reported context choice reaches 1M', () => {
    const base = route({ contextWindow: 413_579, maxContextWindow: 872_000 });

    expect(lookupRoute(new Map([[base.aliasId, base]]), `${base.aliasId}[1m]`)).toBeUndefined();
  });

  it('rejects a maximum mode when the route does not report a larger maximum', () => {
    const base = route({ maxContextWindow: undefined });
    expect(lookupRoute(new Map([[base.aliasId, base]]), contextModeModelId(base.aliasId, 'maximum'))).toBeUndefined();
  });
});
