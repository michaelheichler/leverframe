
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

  cachedInputTokens?: number;
}
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

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

export interface AnthropicUsageTrace extends Partial<AnthropicUsage> {
  model: string;
  promptCacheKeyHash?: string;
}

export function measuredAnthropicUsage(usage: SdkUsage | undefined, inputTokensIncludeCache: boolean): Partial<AnthropicUsage> {
  const valid = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const total = valid(usage?.inputTokens);
  const read = valid(usage?.inputTokenDetails?.cacheReadTokens ?? usage?.cachedInputTokens);
  const write = valid(usage?.inputTokenDetails?.cacheWriteTokens);
  const noCache = valid(usage?.inputTokenDetails?.noCacheTokens);
  const input = noCache ?? (inputTokensIncludeCache
    ? total !== undefined && read !== undefined && write !== undefined && total >= read + write ? total - read - write : undefined
    : total);
  const output = valid(usage?.outputTokens);
  return {
    ...(input === undefined ? {} : { input_tokens: input }),
    ...(output === undefined ? {} : { output_tokens: output }),
    ...(write === undefined ? {} : { cache_creation_input_tokens: write }),
    ...(read === undefined ? {} : { cache_read_input_tokens: read }),
  };
}

export function sdkPromptCacheKeyHash(params: SdkCallParams): string | undefined {
  const key = params.providerOptions?.openai?.promptCacheKey;
  return typeof key === 'string'
    ? createHash('sha256').update(key).digest('hex').slice(0, 16)
    : undefined;
}
