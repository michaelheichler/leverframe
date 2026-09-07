import { describe, expect, it } from 'vitest';
import { localModelToRoute } from '../src/catalog.js';
import { localProvidersToServerModels } from '../src/provider-catalog.js';
import type { LocalProvider } from '../src/types.js';

const provider: LocalProvider = {
  id: 'openai-oauth',
  name: 'OpenAI OAuth',
  apiKey: 'test-key',
  authType: 'oauth',
  models: [{
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    family: 'gpt',
    brand: 'OpenAI',
    modelFormat: 'openai',
    upstreamModelId: 'gpt-6-astra',
    npm: '@ai-sdk/openai',
    apiBaseUrl: 'https://example.test/v1',
    contextWindow: 272_000,
    maxContextWindow: 872_000,
  }],
};

describe('context metadata propagation', () => {
  it('carries the reported maximum into proxy routes and server models', () => {
    const model = provider.models[0]!;
    expect(localModelToRoute(provider, model)).toMatchObject({
      contextWindow: 272_000,
      maxContextWindow: 872_000,
    });
    expect(localProvidersToServerModels([provider])[0]).toMatchObject({
      contextWindow: 272_000,
      maxContextWindow: 872_000,
    });
  });
});
