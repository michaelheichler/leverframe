/** Because Copilot must not own a second agent runtime. */
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { COPILOT_API_BASE_URL, createCopilotFetch } from './backend.js';

/** Because catalog metadata determines the HTTP protocol. */
export async function createCopilotHttpLanguageModel(input: {
  npm: string;
  modelId: string;
  githubToken: string;
  fetchImpl?: typeof fetch;
}): Promise<LanguageModelV4> {
  // Because the fetch boundary owns GitHub authentication.
  const options = { apiKey: '', baseURL: COPILOT_API_BASE_URL, fetch: createCopilotFetch(input.githubToken, input.fetchImpl) };
  if (input.npm === '@ai-sdk/openai-compatible') {
    const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
    return createOpenAICompatible({ ...options, name: 'github-copilot', includeUsage: true })(input.modelId);
  }
  if (input.npm === '@ai-sdk/openai') {
    const { createOpenAI } = await import('@ai-sdk/openai');
    return createOpenAI(options).responses(input.modelId);
  }
  if (input.npm === '@ai-sdk/anthropic') {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    return createAnthropic({ ...options, baseURL: `${COPILOT_API_BASE_URL}/v1` })(input.modelId);
  }
  throw new TypeError('GitHub Copilot model protocol is not supported.');
}
