import { z } from 'zod';
import { OPENCODE_ZEN_BASE_URL } from '../opencode-zen.js';
import { deriveBrand } from '../models.js';
import type { CachedModel } from './types.js';

const zeroCache = z.object({ read: z.literal(0).optional(), write: z.literal(0).optional() });
const supported = z.object({ supported: z.boolean().optional() });
const freeChatModel = z.object({
  id: z.string().trim().min(1), name: z.string().optional(), family: z.string().optional(),
  type: z.literal('chat'),
  cost: z.object({ text: z.object({
    input: z.object({ price: z.literal(0), cache: zeroCache.optional() }),
    output: z.object({ price: z.literal(0) }),
  }) }),
  api: z.object({ 'chat-completions': z.object({
    base_url: z.literal(OPENCODE_ZEN_BASE_URL),
    compatibility: z.object({ reasoning_field: z.string().optional() }).optional(),
  }) }),
  limit: z.object({ context: z.number().int().positive().optional(),
    input: z.number().int().positive().optional(), output: z.number().int().positive().optional() }).optional(),
  capabilities: z.object({ reasoning: supported.optional(), tools: supported.optional(),
    temperature: z.boolean().optional() }).optional(),
});

export function parseOpenCodeZenModels(body: unknown): CachedModel[] {
  const inventory = z.object({ data: z.array(z.unknown()) }).safeParse(body);
  if (!inventory.success) return [];
  return inventory.data.data.flatMap(row => {
    const parsed = freeChatModel.safeParse(row);
    if (!parsed.success) return [];
    const model = parsed.data;
    const family = model.family ?? model.id.split(/[-/:]/)[0];
    return [{
      id: model.id, upstreamModelId: model.id, name: model.name ?? model.id, family, brand: deriveBrand(family),
      npm: '@ai-sdk/openai-compatible', modelFormat: 'openai',
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, source: 'endpoint' },
      isFree: true, freeStatus: 'verified_free',
      contextWindow: model.limit?.context, inputTokenLimit: model.limit?.input, outputTokenLimit: model.limit?.output,
      reasoning: model.capabilities?.reasoning?.supported, supportsTemperature: model.capabilities?.temperature,
      supportedParameters: model.capabilities?.tools?.supported ? ['tools'] : undefined,
      interleavedReasoningField: model.api['chat-completions'].compatibility?.reasoning_field,
    } satisfies CachedModel];
  });
}
