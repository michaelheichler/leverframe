import type { LanguageModel } from 'ai';
import { CODEX_RESPONSES_LITE_VERSION, CODEX_RESPONSES_LITE_WS_URL } from './constants.js';
import { createDefaultCopilotLanguageModel } from './copilot/language-model-default.js';
import { extractOpenAiAccountId } from './oauth/openai.js';
import {
  createResponsesWebSocketFetch,
  type ResponsesWebSocketDiagnosticEvent,
} from './oauth/responses-websocket.js';
import {
  CLAUDE_CODE_USER_AGENT,
  injectClaudeIdentity,
} from './oauth/claude-identity.js';
import { revalidateCustomEndpointUrl } from './registry/url-security.js';

type SdkProviderFactory = (options: { apiKey: string; baseURL?: string; name?: string; headers?: Record<string, string> }) => {
  (modelId: string): LanguageModel;
  chat: (modelId: string) => LanguageModel;
  responses: (modelId: string) => LanguageModel;
};

const factoryCache = new Map<string, Promise<SdkProviderFactory>>();

export type OpenAiEndpoint = 'responses' | 'chat';

function validResponsesLiteVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const version = value.trim();
  return /^\d+(?:\.\d+){0,2}$/.test(version) ? version : undefined;
}

export function shouldUseOpenAiResponsesEndpoint(
  _modelId: string,
  endpoint?: OpenAiEndpoint,
): boolean {
  return endpoint !== 'chat';
}

export interface VertexProviderConfig {
  project: string;
  location: string;
}

export interface ProviderModelSpec {

  npm: string;
  modelId: string;
  apiKey: string;

  baseURL?: string;

  providerId?: string;

  authType?: 'api' | 'oauth' | 'none';
  oauthAccountId?: string;
  providerData?: Record<string, unknown>;

  vertex?: VertexProviderConfig;

  headers?: Record<string, string>;

  useResponsesLite?: boolean;

  preferWebSockets?: boolean;

  minimalClientVersion?: string;

  openAiEndpoint?: OpenAiEndpoint;

  onDebug?: (msg: string) => void;

  onWebSocketDiagnostic?: (event: ResponsesWebSocketDiagnosticEvent) => void;
}

export function isSdkMigratedNpm(npm: string | undefined): boolean {
  return !!npm && npm !== '@ai-sdk/anthropic';
}

export function maxToolsForNpm(npm: string | undefined): number | undefined {
  return npm === '@ai-sdk/groq' ? 128 : undefined;
}

function findCreateFactory(mod: Record<string, unknown>): SdkProviderFactory {
  for (const value of Object.values(mod)) {
    if (typeof value === 'function' && value.name.startsWith('create')) {
      return value as SdkProviderFactory;
    }
  }
  throw new Error('No create* factory export found in provider package');
}

async function loadSdkProviderFactory(npm: string): Promise<SdkProviderFactory> {
  let cached = factoryCache.get(npm);
  if (!cached) {
    cached = (async () => {
      try {
        const mod = await import(npm);
        return findCreateFactory(mod as Record<string, unknown>);
      } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
        if (code === 'ERR_MODULE_NOT_FOUND') {
          throw new Error(`SDK provider package not installed: ${npm}. Run: npm install ${npm}`);
        }
        throw err;
      }
    })();
    factoryCache.set(npm, cached);
    cached.catch(() => factoryCache.delete(npm));
  }
  return cached;
}

export class EndpointUrlValidationError extends Error {
  constructor(public readonly url: string, message: string) {
    super(message);
    this.name = 'EndpointUrlValidationError';
  }
}

export async function createLanguageModel(spec: ProviderModelSpec): Promise<LanguageModel> {
  const { npm, modelId, apiKey, baseURL } = spec;

  if (baseURL) {
    const isHttp = baseURL.trim().toLowerCase().startsWith('http://');
    const revalidation = await revalidateCustomEndpointUrl(baseURL, { allowInsecureLocal: isHttp });
    if (!revalidation.ok) {
      throw new EndpointUrlValidationError(
        baseURL,
        `${revalidation.error ?? 'Custom endpoint URL failed security revalidation.'}${revalidation.hint ? ` ${revalidation.hint}` : ''}`,
      );
    }
  }

  if (npm === '@github/copilot-sdk') {
    return createDefaultCopilotLanguageModel({
      modelId,
      gitHubToken: apiKey,
      environment: process.env,
      nodeVersion: process.version,
    });
  }

  if (npm === '@ai-sdk/openai') {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const useResponsesEndpoint = shouldUseOpenAiResponsesEndpoint(modelId, spec.openAiEndpoint);
    const tokenAccountId = spec.authType === 'oauth'
      ? extractOpenAiAccountId({ access_token: apiKey })?.trim()
      : undefined;
    const accountId = spec.authType === 'oauth'
      ? tokenAccountId || spec.oauthAccountId
      : undefined;
    const oauthOptions = spec.authType === 'oauth'
      ? {
          apiKey,
          baseURL: 'https://chatgpt.com/backend-api/codex',
          headers: {
            ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
            originator: 'leverframe',
            ...(spec.useResponsesLite
              ? {
                  version: validResponsesLiteVersion(spec.minimalClientVersion)
                    ?? CODEX_RESPONSES_LITE_VERSION,
                  'x-openai-internal-codex-responses-lite': 'true',
                }
              : {}),
          },
          ...(useResponsesEndpoint && spec.preferWebSockets === true
            ? {
                fetch: createResponsesWebSocketFetch(CODEX_RESPONSES_LITE_WS_URL, spec.onDebug, {
                  providerId: spec.providerId ?? 'openai',
                  accountId,
                  onDiagnostic: spec.onWebSocketDiagnostic,
                }),
              }
            : {}),
        }
      : { apiKey };
    const openai = createOpenAI(oauthOptions);
    return useResponsesEndpoint ? openai.responses(modelId) : openai.chat(modelId);
  }
  if (npm === '@ai-sdk/anthropic') {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const root = baseURL?.replace(/\/v1\/?$/, '').replace(/\/$/, '');
    const anthropicOptions: Parameters<typeof createAnthropic>[0] = spec.authType === 'oauth'
      ? {
          authToken: apiKey,
          ...(spec.providerId === 'claude-code'
            ? {
                headers: {
                  'User-Agent': CLAUDE_CODE_USER_AGENT,
                  'x-app': 'cli',
                  'X-Claude-Code-Session-Id': injectClaudeIdentity(
                    {},
                    spec.providerData,
                    spec.oauthAccountId ?? apiKey,
                  ).sessionId,
                },
              }
            : {}),
        }
      : { apiKey };
    if (spec.headers) {
      anthropicOptions.headers = { ...anthropicOptions.headers, ...spec.headers };
    }
    if (!root || root === 'https://api.anthropic.com') {
      return createAnthropic(anthropicOptions)(modelId);
    }
    const sdkBase = baseURL!.endsWith('/v1') ? baseURL : `${root}/v1`;
    return createAnthropic({ ...anthropicOptions, baseURL: sdkBase })(modelId);
  }
  let model: LanguageModel;

  if (npm === '@ai-sdk/openai-compatible') {
    const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
    const options = {
      name: spec.providerId ?? 'openai-compatible',
      baseURL: baseURL ?? '',

      includeUsage: true,
      ...(apiKey.trim() ? { apiKey } : {}),
      ...(spec.headers ? { headers: spec.headers } : {}),
    };
    model = createOpenAICompatible({
      ...options,
    })(modelId);
  } else {
    const create = await loadSdkProviderFactory(npm);
    const provider = create({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      ...(spec.headers ? { headers: spec.headers } : {}),
    });
    model = provider(modelId);
  }

  return model;
}
