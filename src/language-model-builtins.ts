/** Because dispatch must not mix authentication rules. */
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import type { ProviderModelSpec } from './language-model-factory.js';
import { OPENAI_CHATGPT_PLAN_BASE_URL, OPENAI_CHATGPT_PLAN_PROVIDER_ID } from './constants.js';
import { CLAUDE_CODE_USER_AGENT, injectClaudeIdentity } from './oauth/claude-identity.js';
import { createAnthropicCacheTransport } from './anthropic-cache-transport.js';
import { isCanonicalOpenAiBaseUrl, recordOpenAiEndpoint } from './openai-endpoint-provenance.js';
import { createChatGptPlanFetch, requireChatGptPlanTerminalEvent } from './openai-chatgpt-plan-transport.js';
import { createChatGptPlanCacheDiagnostics } from './openai-chatgpt-plan-cache-diagnostics.js';

function withDeveloperInstructions(model: LanguageModelV4): LanguageModelV4 {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => {
        const openai = params.providerOptions?.openai;
        if (openai?.systemMessageMode !== undefined) return params;
        return {
          ...params,
          providerOptions: { ...params.providerOptions, openai: { ...openai, systemMessageMode: 'developer' } },
        };
      },
    },
  });
}

/** Because OpenAI keeps distinct chat and Responses APIs. */
export async function createBuiltinOpenAiModel(spec: ProviderModelSpec, useResponsesEndpoint: boolean): Promise<LanguageModel> {
  const { createOpenAI } = await import('@ai-sdk/openai');
  if (spec.providerId === OPENAI_CHATGPT_PLAN_PROVIDER_ID) {
    if (spec.authType !== 'oauth' || !spec.apiKey.trim()) {
      throw new TypeError('ChatGPT plan inference requires Sign in with ChatGPT.');
    }
    const cacheDiagnostics = process.env['LEVERFRAME_OPENAI_CACHE_DIAGNOSTICS'];
    const diagnostics = cacheDiagnostics === '0' ? undefined : createChatGptPlanCacheDiagnostics(
      spec.modelId, cacheDiagnostics === '1' && /^gpt-6\.2(?:-|$)/.test(spec.modelId),
    );
    const model = createOpenAI({
      apiKey: spec.apiKey, baseURL: OPENAI_CHATGPT_PLAN_BASE_URL, fetch: createChatGptPlanFetch(spec.apiKey, spec.fetch, diagnostics),
    }).responses(spec.modelId);
    return requireChatGptPlanTerminalEvent(model, diagnostics);
  }
  if (spec.authType === 'oauth') {
    throw new TypeError('Use openai-chatgpt-plan for OpenAI OAuth.');
  }
  const openai = createOpenAI({
    apiKey: spec.apiKey,
    ...(spec.baseURL ? { baseURL: spec.baseURL } : {}),
    ...(spec.headers ? { headers: spec.headers } : {}),
    ...(spec.fetch ? { fetch: spec.fetch } : {}),
  });
  const model = useResponsesEndpoint ? openai.responses(spec.modelId) : openai.chat(spec.modelId);
  const useDeveloperInstructions = useResponsesEndpoint && spec.authType !== 'none'
    && /^gpt-6\.2(?:-|$)/.test(spec.modelId) && isCanonicalOpenAiBaseUrl(spec.baseURL);
  const effectiveModel = useDeveloperInstructions ? withDeveloperInstructions(model) : model;
  recordOpenAiEndpoint(effectiveModel, spec.baseURL);
  return effectiveModel;
}

/** Because Anthropic OAuth must retain Claude identity. */
export async function createBuiltinAnthropicModel(spec: ProviderModelSpec): Promise<LanguageModel> {
  const { createAnthropic } = await import('@ai-sdk/anthropic');
  const { apiKey, modelId, baseURL } = spec;
  const root = baseURL?.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const options: Parameters<typeof createAnthropic>[0] = spec.authType === 'oauth'
    ? {
        authToken: apiKey,
        ...(spec.providerId === 'claude-code' ? {
          headers: {
            'User-Agent': CLAUDE_CODE_USER_AGENT,
            'x-app': 'cli',
            'X-Claude-Code-Session-Id': injectClaudeIdentity({}, spec.providerData, spec.oauthAccountId ?? apiKey).sessionId,
          },
        } : {}),
      }
    : { apiKey };
  if (spec.headers) options.headers = { ...options.headers, ...spec.headers };
  const transport = createAnthropicCacheTransport(spec.fetch ?? ((input, init) => globalThis.fetch(input, init)));
  options.fetch = transport.fetch;
  if (!root || root === 'https://api.anthropic.com') return transport.wrap(createAnthropic(options)(modelId));
  const sdkBase = baseURL!.endsWith('/v1') ? baseURL : `${root}/v1`;
  return transport.wrap(createAnthropic({ ...options, baseURL: sdkBase })(modelId));
}
