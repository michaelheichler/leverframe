import { createAnthropic } from '@ai-sdk/anthropic';
import type { SharedV4ProviderOptions } from '@ai-sdk/provider';
import { streamText } from 'ai';
import { expect, it, vi } from 'vitest';
import { createBuiltinOpenAiModel } from '../src/language-model-builtins.js';
import { effortProviderOptions, getReasoningCapabilities } from '../src/reasoning-capability-detection.js';
import { anthropicRowToCachedModel } from '../src/registry/anthropic-model-list.js';
import { translateRequest } from '../src/sdk-request-translation.js';

const openai = '@ai-sdk/openai';
const anthropic = '@ai-sdk/anthropic';
const publicEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const publicOpenAi = { providerId: 'openai', apiBaseUrl: 'https://api.openai.com/v1' };

it.each(['gpt-6.2-astra', 'gpt-6.2-sol'])('exposes documented public API efforts for %s without a catalog list', model => {
  expect(getReasoningCapabilities(openai, model, publicOpenAi)).toMatchObject({
    mode: 'controllable', levels: publicEfforts, defaultLevel: 'medium',
  });
});

it.each(publicEfforts)('forwards the %s effort for canonical OpenAI without a catalog list', effort => {
  expect(effortProviderOptions(openai, effort, 'gpt-6.2-astra', publicOpenAi)).toMatchObject({
    openai: { reasoningEffort: effort },
  });
});

it.each([
  { label: 'an explicit empty list', metadata: { ...publicOpenAi, supportedReasoningEfforts: [] } },
  { label: 'an explicit narrower list', metadata: { ...publicOpenAi, supportedReasoningEfforts: ['low'] } },
  { label: 'reasoning explicitly disabled', metadata: { ...publicOpenAi, reasoning: false } },
  { label: 'a custom API endpoint', metadata: { ...publicOpenAi, apiBaseUrl: 'https://models.example.test/v1' } },
  { label: 'the ChatGPT Plan route', metadata: { ...publicOpenAi, providerId: 'openai-chatgpt-plan' } },
])('omits a public API effort fallback for $label', ({ metadata }) => {
  expect(effortProviderOptions(openai, 'max', 'gpt-6.2-astra', metadata)).toBeUndefined();
});

it('omits a public API effort fallback for an unlisted model', () => {
  expect(effortProviderOptions(openai, 'max', 'gpt-6.2-custom', publicOpenAi)).toBeUndefined();
});

it('preserves an effort the ChatGPT Plan catalog reports', () => {
  expect(effortProviderOptions(openai, 'ultra', 'gpt-6.2-astra', {
    providerId: 'openai-chatgpt-plan', supportedReasoningEfforts: ['low', 'high', 'ultra'],
  })).toMatchObject({ openai: { reasoningEffort: 'ultra' } });
});

it('sends the effort selected in Claude Code to canonical OpenAI Responses', async () => {
  const modelId = 'gpt-6.2-sol';
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
    Response.json({ error: { message: 'Fixture rejection' } }, { status: 400 }));
  const model = await createBuiltinOpenAiModel({
    npm: openai, providerId: publicOpenAi.providerId, authType: 'api',
    baseURL: publicOpenAi.apiBaseUrl, modelId, apiKey: 'fixture-key', fetch,
  }, true);
  const params = translateRequest({
    model: modelId, output_config: { effort: 'xhigh' },
    messages: [{ role: 'user', content: 'Inspect the report.' }],
  }, openai, { reasoningMetadata: publicOpenAi });

  await streamText({
    model, messages: params.messages, providerOptions: params.providerOptions as SharedV4ProviderOptions,
    maxRetries: 0, onError: () => {},
  }).consumeStream();

  expect(fetch.mock.calls).toEqual([[
    'https://api.openai.com/v1/responses',
    expect.objectContaining({ method: 'POST', body: expect.any(String) }),
  ]]);
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
    model: modelId, reasoning: { effort: 'xhigh' },
  });
});

it('reads supported effort levels from the Anthropic model catalog', () => {
  const row = {
    id: 'claude-opus-5-5',
    capabilities: { effort: {
      supported: true, low: { supported: true }, medium: { supported: true },
      high: { supported: false }, xhigh: { supported: true }, max: { supported: false },
    } },
  };

  expect(anthropicRowToCachedModel(row, 'https://api.anthropic.com')).toMatchObject({
    supportedReasoningEfforts: ['low', 'medium', 'xhigh'],
  });
});

it('retains an explicit unsupported Anthropic effort capability', () => {
  const row = {
    id: 'claude-opus-5-5',
    capabilities: { effort: { supported: false, xhigh: { supported: true } } },
  };

  expect(anthropicRowToCachedModel(row, 'https://api.anthropic.com')).toMatchObject({
    supportedReasoningEfforts: [],
  });
});

it('preserves absent effort capability for older Anthropic model catalogs', () => {
  const model = anthropicRowToCachedModel({ id: 'claude-opus-4-6' }, 'https://api.anthropic.com');
  expect(model?.supportedReasoningEfforts).toBeUndefined();
});

it('exposes the Anthropic effort list supplied by the provider', () => {
  expect(getReasoningCapabilities(anthropic, 'claude-opus-5-5', {
    supportedReasoningEfforts: ['low', 'high', 'xhigh'],
  })).toMatchObject({ mode: 'controllable', levels: ['low', 'high', 'xhigh'] });
});

it('omits Anthropic effort when the catalog explicitly lists no supported levels', () => {
  expect(effortProviderOptions(anthropic, 'high', 'claude-opus-5-5', {
    supportedReasoningEfforts: [],
  })).toBeUndefined();
});

it('forwards a supported effort without metadata for the Opus 5 alias', () => {
  expect(effortProviderOptions(anthropic, 'medium', 'claude-opus-5')).toMatchObject({
    anthropic: { effort: 'medium' },
  });
});

it('uses high when older Opus 4.6 receives an inherited xhigh effort', () => {
  expect(effortProviderOptions(anthropic, 'xhigh', 'claude-opus-4-6')).toMatchObject({
    anthropic: { effort: 'high' },
  });
});

it('sends the reported xhigh effort in the Anthropic Messages request', async () => {
  const modelId = 'claude-opus-5-5';
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
    id: 'msg_fixture', type: 'message', role: 'assistant', model: modelId,
    content: [{ type: 'text', text: 'fixture response' }], stop_reason: 'end_turn',
    stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  }));
  const model = createAnthropic({ apiKey: 'fixture-key', fetch })(modelId);
  const params = translateRequest({
    model: modelId, output_config: { effort: 'xhigh' },
    messages: [{ role: 'user', content: 'fixture prompt' }],
  }, anthropic, { reasoningMetadata: { supportedReasoningEfforts: ['low', 'high', 'xhigh'] } });

  await model.doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'fixture prompt' }] }],
    maxOutputTokens: 128, providerOptions: params.providerOptions as SharedV4ProviderOptions,
  });

  expect(fetch.mock.calls).toEqual([[
    'https://api.anthropic.com/v1/messages',
    expect.objectContaining({ method: 'POST', body: expect.any(String) }),
  ]]);
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
    model: modelId, output_config: { effort: 'xhigh' }, thinking: { type: 'adaptive' },
  });
});
