import { wrapLanguageModel } from 'ai';
import type { MetadataExtractor } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4, LanguageModelV4Middleware, LanguageModelV4Usage, SharedV4ProviderMetadata } from '@ai-sdk/provider';

const metadataKey = 'leverframeCompatibleCacheUsage';
type Counts = { input?: number; read?: number; write?: number; write5m?: number; write1h?: number;
  output?: number; standardOutput?: number; goPartition?: number; goRead?: number };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function defined(values: Counts): Counts {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function usageCounts(value: unknown, endpoint: string | undefined): Counts {
  const usage = object(object(value).usage);
  const details = object(usage.prompt_tokens_details);
  const base = { read: count(details.cached_tokens) };
  if (endpoint === 'https://opencode.ai/zen/go/v1') {
    const opencode = object(usage.opencode);
    const rawTokens = opencode.tokens;
    const tokens = object(rawTokens);
    const goPartition = 'tokens' in opencode ? 1 : undefined;
    return defined({ ...base, goPartition, input: count(tokens.input), goRead: count(tokens.cache_read),
      output: count(tokens.output), standardOutput: count(usage.completion_tokens),
      write5m: count(tokens.cache_write_5m), write1h: count(tokens.cache_write_1h) });
  }
  if (endpoint === 'https://api.moonshot.ai/v1') {
    return defined({ ...base, write: count(details.cache_write_tokens) });
  }
  return defined(base);
}

function metadata(counts: Counts): SharedV4ProviderMetadata {
  return { [metadataKey]: counts };
}

function applyCounts(usage: LanguageModelV4Usage, providerMetadata: SharedV4ProviderMetadata | undefined) {
  const counts = object(providerMetadata?.[metadataKey]);
  const input = count(counts.input);
  const goPartition = counts.goPartition === 1;
  const goRead = count(counts.goRead);
  const read = goRead ?? count(counts.read);
  const first = count(counts.write5m);
  const second = count(counts.write1h);
  const sum = first !== undefined && second !== undefined ? count(first + second) : undefined;
  const write = count(counts.write) ?? sum;
  const extendedTotal = input !== undefined && goRead !== undefined && sum !== undefined ? count(input + goRead + sum) : undefined;
  const total = goPartition ? extendedTotal : count(usage.inputTokens.total);
  const output = count(counts.standardOutput) === undefined ? count(counts.output) : undefined;
  const noCache = goPartition ? input : (total !== undefined && read !== undefined && write !== undefined && total >= read + write
    ? total - read - write : undefined);
  const { [metadataKey]: _private, ...rest } = providerMetadata ?? {};
  const ttl = { ...(first === undefined ? {} : { cacheCreation5mInputTokens: first }),
    ...(second === undefined ? {} : { cacheCreation1hInputTokens: second }) };
  return { usage: { ...usage, inputTokens: { ...usage.inputTokens, total, noCache, cacheRead: read, cacheWrite: write },
    outputTokens: output === undefined ? usage.outputTokens : { total: output, text: undefined, reasoning: undefined } },
    providerMetadata: Object.keys(ttl).length ? { ...rest, leverframeCacheUsage: ttl } : rest };
}

export function createCompatibleCacheUsage(baseURL: string | undefined) {
  const endpoint = baseURL?.replace(/\/$/, '');
  const metadataExtractor: MetadataExtractor = {
    extractMetadata: async ({ parsedBody }) => metadata(usageCounts(parsedBody, endpoint)),
    createStreamExtractor: () => {
      let counts: Counts = {};
      return {
        processChunk: chunk => { counts = { ...counts, ...usageCounts(chunk, endpoint) }; },
        buildMetadata: () => metadata(counts),
      };
    },
  };
  const middleware: LanguageModelV4Middleware = {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      return { ...result, ...applyCounts(result.usage, result.providerMetadata) };
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      return { ...result, stream: result.stream.pipeThrough(new TransformStream({
        transform(part, controller) {
          controller.enqueue(part.type === 'finish' ? { ...part, ...applyCounts(part.usage, part.providerMetadata) } : part);
        },
      })) };
    },
  };
  return { metadataExtractor, wrap: (model: LanguageModelV4) => wrapLanguageModel({ model, middleware }) };
}
