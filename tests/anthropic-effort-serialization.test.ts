import { createAnthropic } from '@ai-sdk/anthropic';
import type { SharedV4ProviderOptions } from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';
import { effortProviderOptions } from '../src/reasoning-capability-detection.js';

describe('Anthropic effort serialization', () => {
  it.each(['low', 'medium', 'high', 'max'])('sends selected %s effort through the installed provider', async effort => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
      id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'fixture response' }], stop_reason: 'end_turn',
      stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const model = createAnthropic({ apiKey: 'fixture-key', fetch })('claude-opus-4-6');
    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'fixture prompt' }] }],
      maxOutputTokens: 128,
      providerOptions: effortProviderOptions('@ai-sdk/anthropic', effort, 'claude-opus-4-6') as SharedV4ProviderOptions,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    expect(body.output_config).toMatchObject({ effort });
    expect(body.thinking).toEqual({ type: 'adaptive' });
  });
});
