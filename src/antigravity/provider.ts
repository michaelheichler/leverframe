import { createGoogle } from '@ai-sdk/google';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import { resolveAntigravityAuth } from './auth.js';
import { createAntigravityFetch } from './backend.js';
import { ANTIGRAVITY_ORIGIN, AntigravityError } from './types.js';

export function createAntigravityLanguageModel(input: {
  modelId: string;
  expectedAccountId: string;
  fetchImpl?: typeof fetch;
}): LanguageModel {
  if (!input.expectedAccountId) throw new AntigravityError('Antigravity requires a subscription account.', 401);
  const model = createGoogle({
    apiKey: '', baseURL: `${ANTIGRAVITY_ORIGIN}/v1beta`,
    fetch: createAntigravityFetch({
      fetchImpl: input.fetchImpl,
      resolveAuth: async () => {
        const auth = await resolveAntigravityAuth(input.expectedAccountId);
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
    },
  });
}
