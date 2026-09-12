import { describe, expect, it } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { streamAnthropicResponse } from '../src/sdk-streaming-response.js';
import { generateAnthropicResponse } from '../src/sdk-non-streaming-response.js';

describe.each([false, true])('Responses SDK completion with collection=%s', collect => {
  it.each([
    ['completed', 0, undefined],
    ['completed', 100, undefined],
    ['failed', 100, undefined],
    ['incomplete', 100, 'provider_reason'],
  ] as const)('rejects empty %s with output usage %s', async (status, outputTokens, reason) => {
    const provider = createOpenAI({
      apiKey: 'fixture-key',
      fetch: async () => new Response(`data: ${JSON.stringify({
        type: `response.${status}`, sequence_number: 1,
        response: {
          id: 'fixture-response', status, output: [],
          incomplete_details: reason ? { reason } : undefined,
          usage: {
            input_tokens: 115_000, input_tokens_details: { cached_tokens: 114_500 },
            output_tokens: outputTokens, output_tokens_details: { reasoning_tokens: outputTokens },
          },
        },
      })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }),
    });
    const model = provider.responses('test-model');
    const params = { messages: [{ role: 'user' as const, content: 'hello' }], maxRetries: 0 };
    const chunks: string[] = [];
    const result = collect
      ? generateAnthropicResponse(model, params, 'test-model', { forceStream: true, contextWindow: 272_000 })
      : streamAnthropicResponse(model, params, 'test-model', chunk => { chunks.push(chunk); }, undefined,
        { contextWindow: 272_000 });
    await expect(result).rejects.toMatchObject({ httpStatus: 502, retryable: true, outputEmitted: false });
    expect(chunks).toEqual([]);
  });
});
