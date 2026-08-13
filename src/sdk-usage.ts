// SDK usage → Anthropic usage buckets, plus the usage-fallback estimation logic.
import { createHash } from 'node:crypto';
import type { SdkCallParams } from './sdk-request-translation.js';

export interface SdkUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /** AI SDK 6 compatibility for older third-party LanguageModel implementations. */
  cachedInputTokens?: number;
}
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}
/**
 * Normalize SDK usage into disjoint Anthropic buckets. The SDK-normalized
 * `noCacheTokens` value is authoritative when present; provider semantics
 * control the fallback for implementations that omit that breakdown.
 */
export function toAnthropicUsage(
  u: SdkUsage | undefined,
  inputTokensIncludeCache: boolean,
): AnthropicUsage {
  const tokenCount = (value: unknown): number => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : 0
  );
  const total = tokenCount(u?.inputTokens);
  const noCache = u?.inputTokenDetails?.noCacheTokens;
  const cacheRead = tokenCount(
    u?.inputTokenDetails?.cacheReadTokens ?? u?.cachedInputTokens,
  );
  const cacheWrite = tokenCount(u?.inputTokenDetails?.cacheWriteTokens);
  return {
    input_tokens: noCache !== undefined
      ? tokenCount(noCache)
      : inputTokensIncludeCache
        ? Math.max(total - cacheRead - cacheWrite, 0)
        : total,
    output_tokens: tokenCount(u?.outputTokens),
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
  };
}

export interface AnthropicUsageTrace extends AnthropicUsage {
  model: string;
  promptCacheKeyHash?: string;
}

export function sdkPromptCacheKeyHash(params: SdkCallParams): string | undefined {
  const key = params.providerOptions?.openai?.promptCacheKey;
  return typeof key === 'string'
    ? createHash('sha256').update(key).digest('hex').slice(0, 16)
    : undefined;
}
