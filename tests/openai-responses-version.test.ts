import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuiltinOpenAiModel } from '../src/language-model-builtins.js';

const capture = vi.hoisted(() => ({ options: vi.fn() }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: (options: unknown) => {
  capture.options(options);
  return { responses: () => ({}) };
} }));
afterEach(() => capture.options.mockReset());

describe('OpenAI OAuth protocol version', () => {
  it.each([undefined, '0.144.1', '0.153.0', 'bad version'])('keeps the supported version above an older minimum %s', async minimum => {
    await createBuiltinOpenAiModel({
      npm: '@ai-sdk/openai', modelId: 'gpt-6.1-sol', apiKey: 'test-token',
      authType: 'oauth', useResponsesLite: true, minimalClientVersion: minimum,
    }, true);

    expect(capture.options.mock.calls[0]![0].headers.version).toBe('0.159.2');
  });

  it('retains a newer minimum supplied by the model catalog', async () => {
    await createBuiltinOpenAiModel({
      npm: '@ai-sdk/openai', modelId: 'future-model', apiKey: 'test-token',
      authType: 'oauth', useResponsesLite: true, minimalClientVersion: '0.160.0',
    }, true);

    expect(capture.options.mock.calls[0]![0].headers.version).toBe('0.160.0');
  });
});
