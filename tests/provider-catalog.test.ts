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

  it('keeps the provider-specific refresh reason when live discovery fails', () => {
    const result = filterFreshProviderCatalog(
      [provider()],
      {
        refreshed: [{
          id: 'openai-oauth',
          name: 'OpenAI (ChatGPT)',
          ok: false,
          modelSource: 'live',
          reason: 'Provider authentication expired',
        }],
      },
      'generic refresh failure',
    );

    expect(result.unavailable[0]?.reason).toBe('Provider authentication expired');
  });

  it('keeps live external models with unconfirmed context without publishing stale limits', () => {
    const candidate = provider();
    candidate.models[0]!.contextWindowUnconfirmed = true;
    candidate.models[0]!.maxContextWindow = 1_000_000;

    const result = filterFreshProviderCatalog(
      [candidate],
      { refreshed: [{ id: 'openai-oauth', name: 'OpenAI (ChatGPT)', ok: true, modelSource: 'live' }] },
    );

    expect(result.providers[0]?.models).toMatchObject([{
      id: 'gpt-6-astra',
      contextWindow: undefined,
      maxContextWindow: undefined,
      contextWindowUnconfirmed: true,
    }]);
    expect(result.unavailable).toEqual([]);
  });

  it.each([undefined, 0, -1, 1.5, Number.NaN])('retains live identities with invalid or absent context %s', contextWindow => {
    const candidate = provider();
    candidate.models[0]!.contextWindow = contextWindow;
    const result = filterFreshProviderCatalog([candidate], {
      refreshed: [{ id: candidate.id, name: candidate.name, ok: true, modelSource: 'live' }],
    });
    expect(result.providers[0]?.models[0]).toMatchObject({
      id: 'gpt-6-astra', contextWindow: undefined, contextWindowUnconfirmed: true,
    });
    expect(result.unavailable).toEqual([]);
  });

  it('keeps only first-party Anthropic passthrough models without a model refresh', () => {
    const result = filterFreshProviderCatalog(
      [anthropicProvider()],
      { refreshed: [] },
    );

    expect(result.providers[0]?.models.map(model => model.id)).toEqual(['claude-sonnet-4-6']);
    expect(result.unavailable).toEqual([]);
  });

  it('keeps live third-party Anthropic-format models without inventing context metadata', () => {
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

    expect(result.providers[0]?.models[0]).toMatchObject({
      id: 'claude-sonnet-4-6',
      contextWindowUnconfirmed: true,
    });
    expect(result.unavailable).toEqual([]);
  });
});
