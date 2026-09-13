import { ProviderTransportError } from './provider-error.js';
import type { AnthropicUsage } from './sdk-usage.js';

export function emptyCompletionError(
  modelId: string,
  usage: AnthropicUsage,
  contextWindow?: number,
  finishReason?: string,
  outputEmitted = false,
  rawFinishReason?: string,
): ProviderTransportError {
  const inputTokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  const overLimit = !outputEmitted && finishReason !== undefined
    && contextWindow !== undefined && inputTokens > contextWindow;
  const failure = finishReason === undefined ? 'Upstream ended without a completion event'
    : finishReason === 'error' ? 'Upstream failed' : 'Upstream returned no content';
  const safeMessage = overLimit
    ? `prompt is too long for model ${modelId} (${inputTokens} > ${contextWindow} context)`
    : `${failure} for model ${modelId} `
      + `(input_tokens=${inputTokens}, finishReason=${finishReason ?? 'unknown'})`;
  return new ProviderTransportError({
    provider: 'sdk-adapter',
    model: modelId,
    phase: 'completion',
    category: overLimit ? 'context_length' : 'upstream',
    httpStatus: overLimit ? 400 : 502,
    retryable: !overLimit && !outputEmitted,
    outputEmitted,
    safeMessage,
    diagnosticDetail: JSON.stringify({
      finishReason,
      rawFinishReason,
      totalInputTokens: inputTokens,
      uncachedInputTokens: usage.input_tokens,
      cachedInputTokens: usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
      outputTokens: usage.output_tokens,
    }),
  });
}
