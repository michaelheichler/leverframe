/** Because dispatch must not mix authentication rules. */
import type { LanguageModel } from 'ai';
import type { ProviderModelSpec } from './language-model-factory.js';
import { CODEX_API_BASE_URL, CODEX_RESPONSES_LITE_VERSION, CODEX_RESPONSES_LITE_WS_URL } from './constants.js';
import { extractOpenAiAccountId } from './oauth/openai.js';
import { createResponsesWebSocketFetch } from './oauth/responses-websocket.js';
import { CLAUDE_CODE_USER_AGENT, injectClaudeIdentity } from './oauth/claude-identity.js';
import { createAnthropicCacheTransport } from './anthropic-cache-transport.js';
import { recordOpenAiEndpoint } from './openai-endpoint-provenance.js';

/** Because version headers require numeric components. */
function validResponsesLiteVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const version = value.trim();
  if (!/^\d+(?:\.\d+){0,2}$/.test(version)) return undefined;
  return version.localeCompare(CODEX_RESPONSES_LITE_VERSION, 'en', { numeric: true }) > 0
    ? version : undefined;
}

/** Because Codex subscriptions use a separate endpoint. */
function openAiOptions(spec: ProviderModelSpec, useResponsesEndpoint: boolean) {
  if (spec.authType !== 'oauth') return {
    apiKey: spec.apiKey,
    ...(spec.baseURL ? { baseURL: spec.baseURL } : {}),
    ...(spec.headers ? { headers: spec.headers } : {}),
    ...(spec.fetch ? { fetch: spec.fetch } : {}),
  };
  const tokenAccountId = extractOpenAiAccountId({ access_token: spec.apiKey })?.trim();
  const accountId = tokenAccountId || spec.oauthAccountId;
  return {
    apiKey: spec.apiKey,
    baseURL: CODEX_API_BASE_URL,
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
    } : spec.fetch ? { fetch: spec.fetch } : {}),
  };
}

/** Because OpenAI keeps distinct chat and Responses APIs. */
export async function createBuiltinOpenAiModel(spec: ProviderModelSpec, useResponsesEndpoint: boolean): Promise<LanguageModel> {
  const { createOpenAI } = await import('@ai-sdk/openai');
  const options = openAiOptions(spec, useResponsesEndpoint);
  const openai = createOpenAI(options);
  const model = useResponsesEndpoint ? openai.responses(spec.modelId) : openai.chat(spec.modelId);
  if (spec.authType !== 'oauth') recordOpenAiEndpoint(model, options.baseURL);
  return model;
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
  const transport = createAnthropicCacheTransport(spec.fetch ?? globalThis.fetch);
  options.fetch = transport.fetch;
  if (!root || root === 'https://api.anthropic.com') return transport.wrap(createAnthropic(options)(modelId));
  const sdkBase = baseURL!.endsWith('/v1') ? baseURL : `${root}/v1`;
  return transport.wrap(createAnthropic({ ...options, baseURL: sdkBase })(modelId));
}
