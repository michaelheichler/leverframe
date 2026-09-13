/** Because Copilot must bypass vendor agent runtimes. */
import type { LanguageModel } from 'ai';
import { createCopilotHttpLanguageModel } from './copilot/provider.js';
import { createBuiltinAnthropicModel, createBuiltinOpenAiModel } from './language-model-builtins.js';
import type { ResponsesWebSocketDiagnosticEvent } from './oauth/responses-websocket.js';
import { revalidateCustomEndpointUrl } from './registry/url-security.js';

type SdkProviderFactory = (options: { apiKey: string; baseURL?: string; name?: string; headers?: Record<string, string> }) => {
  (modelId: string): LanguageModel;
  chat: (modelId: string) => LanguageModel;
  responses: (modelId: string) => LanguageModel;
};

const factoryCache = new Map<string, Promise<SdkProviderFactory>>();
export type OpenAiEndpoint = 'responses' | 'chat';

/** Because explicit chat selection must be preserved. */
export function shouldUseOpenAiResponsesEndpoint(_modelId: string, endpoint?: OpenAiEndpoint): boolean {
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

/** Because all Copilot protocols need OAuth isolation. */
export function isSdkMigratedNpm(npm: string | undefined, providerId?: string): boolean {
  return !!npm && (npm !== '@ai-sdk/anthropic' || providerId === 'github-copilot');
}

/** Because Copilot Responses do not use Codex rules. */
export function isOpenAiOAuth(npm: string | undefined, authType: string | undefined, providerId?: string): boolean {
  return npm === '@ai-sdk/openai' && authType === 'oauth' && providerId !== 'github-copilot';
}

/** Because Groq rejects more than 128 tool definitions. */
export function maxToolsForNpm(npm: string | undefined): number | undefined {
  return npm === '@ai-sdk/groq' ? 128 : undefined;
}

/** Because provider factories use different names. */
function findCreateFactory(mod: Record<string, unknown>): SdkProviderFactory {
  for (const value of Object.values(mod)) {
    if (typeof value === 'function' && value.name.startsWith('create')) return value as SdkProviderFactory;
  }
  throw new Error('No create* factory export found in provider package');
}

/** Because optional providers are resolved on demand. */
async function loadSdkProviderFactory(npm: string): Promise<SdkProviderFactory> {
  const cached = factoryCache.get(npm);
  if (cached) return cached;
  const pending = (async () => {
    try {
      const mod = await import(npm);
      return findCreateFactory(mod as Record<string, unknown>);
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
      if (code === 'ERR_MODULE_NOT_FOUND') throw new Error(`SDK provider package not installed: ${npm}. Run: npm install ${npm}`);
      throw err;
    }
  })();
  factoryCache.set(npm, pending);
  pending.catch(() => factoryCache.delete(npm));
  return pending;
}

/** Because endpoint failures need their source identity. */
export class EndpointUrlValidationError extends Error {
  /** Because callers distinguish endpoint rejection. */
  constructor(public readonly url: string, message: string) {
    super(message);
    this.name = 'EndpointUrlValidationError';
  }
}

/** Because Copilot OAuth must not use another backend. */
export async function createLanguageModel(spec: ProviderModelSpec): Promise<LanguageModel> {
  const { npm, modelId, apiKey, baseURL } = spec;
  if (baseURL) {
    const isHttp = baseURL.trim().toLowerCase().startsWith('http://');
    const revalidation = await revalidateCustomEndpointUrl(baseURL, { allowInsecureLocal: isHttp });
    if (!revalidation.ok) {
      throw new EndpointUrlValidationError(baseURL,
        `${revalidation.error ?? 'Custom endpoint URL failed security revalidation.'}${revalidation.hint ? ` ${revalidation.hint}` : ''}`);
    }
  }
  if (spec.providerId === 'github-copilot' || npm === '@github/copilot-sdk') {
    return createCopilotHttpLanguageModel({
      npm: npm === '@github/copilot-sdk' ? '@ai-sdk/openai-compatible' : npm,
      modelId, githubToken: apiKey,
    });
  }
  if (npm === '@ai-sdk/openai') return createBuiltinOpenAiModel(spec, shouldUseOpenAiResponsesEndpoint(modelId, spec.openAiEndpoint));
  if (npm === '@ai-sdk/anthropic') return createBuiltinAnthropicModel(spec);
  if (npm === '@ai-sdk/openai-compatible') {
    const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
    return createOpenAICompatible({
      name: spec.providerId ?? 'openai-compatible', baseURL: baseURL ?? '', includeUsage: true,
      ...(apiKey.trim() ? { apiKey } : {}),
      ...(spec.headers ? { headers: spec.headers } : {}),
    })(modelId);
  }
  const create = await loadSdkProviderFactory(npm);
  return create({ apiKey, ...(baseURL ? { baseURL } : {}), ...(spec.headers ? { headers: spec.headers } : {}) })(modelId);
}
