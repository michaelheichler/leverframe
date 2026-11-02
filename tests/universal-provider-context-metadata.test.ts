import { afterEach, expect, it, vi } from 'vitest';
import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';
import type { ProviderTemplate } from '../src/provider-templates.js';

function template(npm = '@ai-sdk/openai-compatible'): ProviderTemplate {
  return {
    id: 'metadata-fixture', name: 'Metadata fixture', authType: 'api', npm,
    defaultBaseUrl: 'https://provider.example/v1', modelSource: 'api-list', supported: true,
  };
}

function modelList(body: unknown): void {
  vi.stubGlobal('fetch', async () => Response.json(body));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('uses provider context, maximum, input, and output limits from standard fields', async () => {
  modelList({ data: [{
    id: 'fixture-model', context_length: 410_001, max_context_window: 510_003,
    inputTokenLimit: 310_001, outputTokenLimit: 32_001,
  }] });

  const result = await fetchTemplateModels(template(), 'fixture-key');

  expect(result.models[0]).toMatchObject({
    id: 'fixture-model', contextWindow: 410_001, maxContextWindow: 510_003,
    inputTokenLimit: 310_001, outputTokenLimit: 32_001,
  });
  expect(result.models[0]?.contextWindowUnconfirmed).not.toBe(true);
});

it('uses nested provider limits when top-level context fields are absent', async () => {
  modelList({ models: [{
    id: 'nested-limit-model', limit: { context: 456_789, input: 123_456, output: 8_192 },
  }] });

  const result = await fetchTemplateModels(template(), 'fixture-key');

  expect(result.models[0]).toMatchObject({
    id: 'nested-limit-model', contextWindow: 456_789,
    inputTokenLimit: 123_456, outputTokenLimit: 8_192,
  });
});

it('keeps malformed and fractional context metadata unconfirmed', async () => {
  modelList({ data: [{
    id: 'uncertain-model', context_length: 1.5, max_context_window: '999999',
    limit: { context: '888000', input: 1.5, output: '12000' },
  }] });

  const result = await fetchTemplateModels(template(), 'fixture-key');

  expect(result.models[0]).toMatchObject({ contextWindow: undefined, contextWindowUnconfirmed: true });
  expect(result.models[0]).not.toHaveProperty('maxContextWindow');
  expect(result.models[0]).not.toHaveProperty('inputTokenLimit');
  expect(result.models[0]).not.toHaveProperty('outputTokenLimit');
});

it('normalizes Google model names and reads their reported input context', async () => {
  modelList({ models: [{ name: 'models/gemini-context-fixture', inputTokenLimit: 234_567, outputTokenLimit: 12_345 }] });

  const result = await fetchTemplateModels(template('@ai-sdk/google'), 'fixture-key');

  expect(result.models[0]).toMatchObject({
    id: 'gemini-context-fixture', upstreamModelId: 'gemini-context-fixture',
    contextWindow: 234_567, inputTokenLimit: 234_567, outputTokenLimit: 12_345,
  });
});
