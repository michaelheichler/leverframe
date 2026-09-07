import { describe, expect, it } from 'vitest';
import { filterFreshProviderCatalog } from '../src/provider-catalog.js';
import type { LocalProvider } from '../src/types.js';

function provider(): LocalProvider {
  return {
    id: 'openai-oauth',
    name: 'OpenAI (ChatGPT)',
    apiKey: '',
    authType: 'oauth',
    models: [
      {
        id: 'gpt-6-astra',
        name: 'GPT-6 Astra',
        family: 'gpt',
        brand: 'OpenAI',
        modelFormat: 'openai',
        upstreamModelId: 'gpt-6-astra',
        contextWindow: 272_000,
      },
    ],
  };
}

function anthropicProvider(id = 'anthropic'): LocalProvider {
  return {
    id,
    name: id === 'anthropic' ? 'Anthropic' : 'Custom Anthropic',
    apiKey: 'test-key',
    authType: 'api',
    models: [{
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      family: 'claude',
      brand: 'Anthropic',
      modelFormat: 'anthropic',
      upstreamModelId: 'claude-sonnet-4-6',
    }],
  };
}

describe('fresh provider catalog', () => {
  it('keeps externally discovered models only after a live refresh', () => {
    const result = filterFreshProviderCatalog(
      [provider()],
      { refreshed: [{ id: 'openai-oauth', name: 'OpenAI (ChatGPT)', ok: true, modelSource: 'live' }] },
    );

    expect(result.providers[0]?.models.map(model => model.id)).toEqual([
      'gpt-6-astra',
    ]);
    expect(result.unavailable).toEqual([]);
  });

  it.each(['cache', 'seed', 'fallback', undefined] as const)(
    'rejects confirmed external models when refresh provenance is %s',
    modelSource => {
      const result = filterFreshProviderCatalog(
        [provider()],
        {
          refreshed: [{
            id: 'openai-oauth',
            name: 'OpenAI (ChatGPT)',
            ok: true,
            ...(modelSource === undefined ? {} : { modelSource }),
          }],
        },
      );

      expect(result.providers).toEqual([]);
      expect(result.unavailable).toMatchObject([{
        providerId: 'openai-oauth',
        modelIds: ['gpt-6-astra'],
      }]);
      expect(result.unavailable[0]?.reason).toContain('live provider model list');
    },
  );

  it('rejects external models whose context is marked unconfirmed', () => {
    const candidate = provider();
    candidate.models[0]!.contextWindowUnconfirmed = true;

    const result = filterFreshProviderCatalog(
      [candidate],
      { refreshed: [{ id: 'openai-oauth', name: 'OpenAI (ChatGPT)', ok: true, modelSource: 'live' }] },
    );

    expect(result.providers).toEqual([]);
    expect(result.unavailable[0]?.reason).toContain('confirmed context window');
  });

  it('keeps only first-party Anthropic passthrough models without a model refresh', () => {
    const result = filterFreshProviderCatalog(
      [anthropicProvider()],
      { refreshed: [] },
    );

    expect(result.providers[0]?.models.map(model => model.id)).toEqual(['claude-sonnet-4-6']);
    expect(result.unavailable).toEqual([]);
  });

  it('requires live confirmed metadata for third-party Anthropic-format models', () => {
    const result = filterFreshProviderCatalog(
      [anthropicProvider('custom-anthropic')],
      {
        refreshed: [{
          id: 'custom-anthropic',
          name: 'Custom Anthropic',
          ok: true,
          modelSource: 'live',
        }],
      },
    );

    expect(result.providers).toEqual([]);
    expect(result.unavailable).toMatchObject([{
      providerId: 'custom-anthropic',
      modelIds: ['claude-sonnet-4-6'],
    }]);
  });
});
