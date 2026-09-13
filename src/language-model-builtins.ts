/** Because dispatch must not mix authentication rules. */
import type { LanguageModel } from 'ai';
import type { ProviderModelSpec } from './language-model-factory.js';
import { CODEX_RESPONSES_LITE_VERSION, CODEX_RESPONSES_LITE_WS_URL } from './constants.js';
import { extractOpenAiAccountId } from './oauth/openai.js';
import { createResponsesWebSocketFetch } from './oauth/responses-websocket.js';
import { CLAUDE_CODE_USER_AGENT, injectClaudeIdentity } from './oauth/claude-identity.js';

/** Because version headers require numeric components. */
function validResponsesLiteVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const version = value.trim();
  return /^\d+(?:\.\d+){0,2}$/.test(version) ? version : undefined;
}

/** Because Codex subscriptions use a separate endpoint. */
function openAiOptions(spec: ProviderModelSpec, useResponsesEndpoint: boolean) {
  if (spec.authType !== 'oauth') return { apiKey: spec.apiKey };
  const tokenAccountId = extractOpenAiAccountId({ access_token: spec.apiKey })?.trim();
  const accountId = tokenAccountId || spec.oauthAccountId;
  return {
    apiKey: spec.apiKey,
    baseURL: 'https://chatgpt.com/backend-api/codex',
    headers: {
      ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
      originator: 'leverframe',
      ...(spec.useResponsesLite ? {
        version: validResponsesLiteVersion(spec.minimalClientVersion) ?? CODEX_RESPONSES_LITE_VERSION,
        'x-openai-internal-codex-responses-lite': 'true',
      } : {}),
    },
    ...(useResponsesEndpoint && spec.preferWebSockets === true ? {
      fetch: createResponsesWebSocketFetch(CODEX_RESPONSES_LITE_WS_URL, spec.onDebug, {
        providerId: spec.providerId ?? 'openai', accountId, onDiagnostic: spec.onWebSocketDiagnostic,
      }),
    } : {}),
  };
}

/** Because OpenAI keeps distinct chat and Responses APIs. */
export async function createBuiltinOpenAiModel(spec: ProviderModelSpec, useResponsesEndpoint: boolean): Promise<LanguageModel> {
  const { createOpenAI } = await import('@ai-sdk/openai');
  const openai = createOpenAI(openAiOptions(spec, useResponsesEndpoint));
  return useResponsesEndpoint ? openai.responses(spec.modelId) : openai.chat(spec.modelId);
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
  if (!root || root === 'https://api.anthropic.com') return createAnthropic(options)(modelId);
  const sdkBase = baseURL!.endsWith('/v1') ? baseURL : `${root}/v1`;
  return createAnthropic({ ...options, baseURL: sdkBase })(modelId);
}
