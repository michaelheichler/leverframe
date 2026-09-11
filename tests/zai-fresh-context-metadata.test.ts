import { afterEach, expect, it, vi } from 'vitest';
import { getTemplateById } from '../src/provider-templates.js';
import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';

const LIVE_MODELS = {
  data: [
    { id: 'glm-5.3-flash', object: 'model', created: 1786636800, owned_by: 'z-ai' },
    { id: 'glm-5.2', context_length: 128_000 },
    { id: 'glm-unknown' },
  ],
};

const SUPPLIER_METADATA = {
  'zai-coding-plan': {
    id: 'zai-coding-plan',
    npm: '@ai-sdk/openai-compatible',
    models: {
      'glm-5.3-flash': {
        limit: { context: 1_000_000, output: 131_072 },
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
      },
      'glm-5.2': { limit: { context: 1_000_000 } },
      'supplier-only-model': { limit: { context: 100_000 } },
    },
  },
};

afterEach(() => { vi.unstubAllGlobals(); });

it('enriches live z.ai model IDs from fresh Coding Plan metadata without guessing missing limits', async () => {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    if (String(input) === 'https://api.z.ai/api/coding/paas/v4/models') {
      return Response.json(LIVE_MODELS);
    }
    if (String(input) === 'https://models.dev/api.json') {
      return Response.json(SUPPLIER_METADATA);
    }
    throw new Error('Unexpected metadata request');
  });
  vi.stubGlobal('fetch', fetchMock);

  const result = await fetchTemplateModels(getTemplateById('zai')!, 'test-key');

  expect(result.error).toBeUndefined();
  expect(result.models.map(model => model.id)).toEqual(['glm-5.3-flash', 'glm-5.2', 'glm-unknown']);
  expect(result.models[0]).toMatchObject({
    id: 'glm-5.3-flash',
    contextWindow: 1_000_000,
    contextWindowUnconfirmed: false,
    outputTokenLimit: 131_072,
    supportedReasoningEfforts: ['low', 'high', 'max'],
  });
  expect(result.models[1]).toMatchObject({ id: 'glm-5.2', contextWindow: 128_000 });
  expect(result.models[2]).toMatchObject({
    id: 'glm-unknown', contextWindow: undefined, contextWindowUnconfirmed: true,
  });
  expect(fetchMock).toHaveBeenCalledWith('https://models.dev/api.json', expect.any(Object));
});
