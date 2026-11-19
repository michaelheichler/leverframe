import { createGoogle } from '@ai-sdk/google';
import type { LanguageModelV4Usage, SharedV4ProviderMetadata } from '@ai-sdk/provider';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import { resolveAntigravityAuth } from './auth.js';
import { createAntigravityFetch } from './backend.js';
import { ANTIGRAVITY_ORIGIN, AntigravityError } from './types.js';

function withReportedCacheUsage<T extends {
  usage: LanguageModelV4Usage;
  providerMetadata?: SharedV4ProviderMetadata;
}>(result: T): T {
  const { usage, providerMetadata } = result;
  const inputTokens = usage.raw?.cachedContentTokenCount == null
    ? { ...usage.inputTokens, noCache: undefined, cacheRead: undefined } : usage.inputTokens;
  const totalInputTokens = usage.raw?.promptTokenCount;
  if (typeof totalInputTokens !== 'number' || !Number.isSafeInteger(totalInputTokens) || totalInputTokens < 0) {
    return { ...result, usage: { ...usage, inputTokens } };
  }
  return {
    ...result,
    usage: { ...usage, inputTokens },
    providerMetadata: {
      ...providerMetadata,
      leverframeCacheUsage: { ...providerMetadata?.leverframeCacheUsage, totalInputTokens },
    },
  };
}

export function createAntigravityLanguageModel(input: {
  modelId: string;
  expectedAccountId: string;
  registryAccountId?: string;
  fetchImpl?: typeof fetch;
}): LanguageModel {
  if (!input.expectedAccountId) throw new AntigravityError('Antigravity requires a subscription account.', 401);
  const model = createGoogle({
    apiKey: '', baseURL: `${ANTIGRAVITY_ORIGIN}/v1beta`,
    fetch: createAntigravityFetch({
      fetchImpl: input.fetchImpl,
      resolveAuth: async () => {
        const auth = await resolveAntigravityAuth(input.expectedAccountId, { registryAccountId: input.registryAccountId });
        if (auth.accountId !== input.expectedAccountId) throw new AntigravityError('Antigravity account changed. Select a model again.', 409);
        return auth;
      },
    }),
  })(input.modelId);
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => ({
        ...params,
        prompt: [
          ...params.prompt.filter(message => message.role === 'system'),
          ...params.prompt.filter(message => message.role !== 'system'),
        ],
      }),
      wrapGenerate: async ({ doGenerate }) => withReportedCacheUsage(await doGenerate()),
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        return { ...result, stream: result.stream.pipeThrough(new TransformStream({
          transform(part, controller) {
            controller.enqueue(part.type === 'finish' ? withReportedCacheUsage(part) : part);
          },
        })) };
      },
    },
  });
}
