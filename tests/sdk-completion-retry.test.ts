import { describe, expect, it } from 'vitest';
import { emptyCompletionError } from '../src/sdk-completion.js';
import { isTransientSdkStreamFailure } from '../src/proxy-retry.js';

const usage = {
  input_tokens: 500,
  cache_read_input_tokens: 114_500,
  cache_creation_input_tokens: 0,
  output_tokens: 100,
};

describe('completion retry policy', () => {
  it('permits replay for empty upstream completions before output', () => {
    const error = emptyCompletionError('test-model', usage, 272_000, 'stop');
    expect(isTransientSdkStreamFailure(error)).toBe(true);
  });

  it('refuses replay for failed completions after output', () => {
    const error = emptyCompletionError('test-model', usage, 272_000, 'error', true);
    expect(isTransientSdkStreamFailure(error)).toBe(false);
  });

  it('refuses replay when total input exceeds the known context limit', () => {
    const error = emptyCompletionError('test-model', usage, 100_000, 'stop');
    expect(isTransientSdkStreamFailure(error)).toBe(false);
  });

  it('keeps the provider reason distinct from normalized finish and uncached usage', () => {
    const error = emptyCompletionError('test-model', usage, 272_000, 'other', false, 'provider_reason');
    expect(JSON.parse(error.diagnosticDetail ?? '')).toEqual({
      finishReason: 'other', rawFinishReason: 'provider_reason', totalInputTokens: 115_000,
      uncachedInputTokens: 500, cachedInputTokens: 114_500, outputTokens: 100,
    });
  });
});
