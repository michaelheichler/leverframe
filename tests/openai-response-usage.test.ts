import { expect, it } from 'vitest';
import { formatOpenAiResponse } from '../src/openai-response-format.js';

it('derives total tokens when the provider supplies only component counts', () => {
  const result = formatOpenAiResponse({ text: 'reply', usage: { inputTokens: 7, outputTokens: 3 } }, 'alias');
  expect(result.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
});

it('preserves an explicit total token count including zero', () => {
  expect(formatOpenAiResponse({ text: '', usage: { inputTokens: 7, totalTokens: 0 } }, 'alias').usage.total_tokens).toBe(0);
});
