import { estimateAnthropicOutputTokens } from './anthropic-endpoints.js';
import { measuredAnthropicUsage, toAnthropicUsage, type AnthropicUsage, type AnthropicUsageTrace, type SdkUsage } from './sdk-usage.js';

export function finishStreamUsage(options: {
  usage: AnthropicUsage;
  providerUsage?: SdkUsage;
  outputContentBytes: number;
  inputTokensIncludeCache: boolean;
  modelId: string;
  promptCacheKeyHash?: string;
  onUsage?: (usage: AnthropicUsageTrace) => void;
}): AnthropicUsage {
  const { providerUsage, inputTokensIncludeCache } = options;
  const estimate = estimateAnthropicOutputTokens(options.outputContentBytes);
  let usage = options.usage;
  if (providerUsage) {
    const final = toAnthropicUsage(providerUsage, inputTokensIncludeCache);
    const hasInput = final.input_tokens + final.cache_creation_input_tokens + final.cache_read_input_tokens > 0;
    const output = providerUsage.outputTokens === undefined && estimate > 0 ? estimate : final.output_tokens;
    usage = hasInput ? { ...final, output_tokens: output } : { ...usage, output_tokens: output };
  } else if (estimate > 0) {
    usage = { ...usage, output_tokens: estimate };
  }
  options.onUsage?.({
    model: options.modelId, ...measuredAnthropicUsage(providerUsage, inputTokensIncludeCache),
    ...(options.promptCacheKeyHash ? { promptCacheKeyHash: options.promptCacheKeyHash } : {}),
  });
  return usage;
}
