// src/provider-templates.ts: builtin provider templates for leverframe providers add

export type ProviderAuthType = 'api' | 'oauth' | 'none';
export type ProviderModelSource = 'api-list' | 'static-seed' | 'manual-only';

export interface ProviderTemplateStaticModel {
  id: string;
  name: string;
  /** Explicit documented context window. Wins over heuristic lookup. */
  contextWindow?: number;
}

export interface ProviderTemplate {
  id: string;
  name: string;
  authType: ProviderAuthType;
  npm: string;
  defaultBaseUrl?: string;
  modelsPath?: string;
  signupUrl?: string;
  urlPlaceholder?: string;
  urlPrompt?: string;
  apiKeyOptional?: boolean;
  anonymousFreeModels?: boolean;
  /**
   * Set when the API key is stored without first hitting the provider's
   * model-listing endpoint. Used when a template relies on a static seed
   * (so listing succeeds without ever validating the key) or when the
   * provider's documented test endpoint is unreliable. leverframe surfaces this
   * in the setup copy so the user knows the key was stored, not verified.
   */
  skipKeyVerification?: boolean;
  /** Static headers this provider requires on every request (model listing and runtime). */
  headers?: Record<string, string>;
  modelSource: ProviderModelSource;
  staticModels?: ProviderTemplateStaticModel[];
  supported: boolean;
  addable?: boolean;
  hidden?: boolean;
  unsupportedReason?: string;
}

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    authType: 'api',
    npm: '@ai-sdk/openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    signupUrl: 'https://platform.openai.com/api-keys',
    modelSource: 'api-list',
    supported: true,
  },
  {
    id: 'openai-oauth',
    name: 'OpenAI (ChatGPT)',
    authType: 'oauth',
    npm: '@ai-sdk/openai',
    signupUrl: 'https://chatgpt.com',
    modelSource: 'api-list',
    supported: true,
  },
  {
    id: 'kimi',
    name: 'Kimi (Coding Plan)',
    authType: 'api',
    npm: '@ai-sdk/openai-compatible',
    defaultBaseUrl: 'https://api.kimi.com/coding/v1',
    signupUrl: 'https://kimi.com',
    modelSource: 'api-list',
    staticModels: [
      { id: 'k3', name: 'Kimi 3', contextWindow: 1_048_576 },
      { id: 'kimi-for-coding', name: 'Kimi for Coding' },
      { id: 'kimi-for-coding-highspeed', name: 'Kimi for Coding Highspeed' },
    ],
    supported: true,
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Pay-as-you-go)',
    authType: 'api',
    npm: '@ai-sdk/openai-compatible',
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    signupUrl: 'https://platform.moonshot.ai/console/api-keys',
    modelSource: 'api-list',
    staticModels: [
      { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1_048_576 },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 262_144 },
      { id: 'kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code Highspeed', contextWindow: 262_144 },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262_144 },
    ],
    supported: true,
  },
  {
    id: 'zai',
    name: 'z.ai (Coding Plan)',
    authType: 'api',
    npm: '@ai-sdk/openai-compatible',
    defaultBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
    signupUrl: 'https://z.ai/manage-apikey/apikey-management',
    modelSource: 'api-list',
    staticModels: [
      { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000 },
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo', contextWindow: 128_000 },
      { id: 'glm-4.7', name: 'GLM-4.7', contextWindow: 128_000 },
    ],
    supported: true,
  },
];

export function listSupportedTemplates(): ProviderTemplate[] {
  return PROVIDER_TEMPLATES
    .filter(t => t.supported && t.authType === 'api' && t.addable !== false && !t.hidden)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Supported templates not yet present in the user's registry. */
export function listAddableTemplates(configuredIds: Iterable<string> = []): ProviderTemplate[] {
  const configured = new Set(configuredIds);
  return listSupportedTemplates().filter(t => !configured.has(t.id));
}

export function listVisibleOAuthTemplates(configuredIds: Iterable<string> = []): ProviderTemplate[] {
  const configured = new Set(configuredIds);
  return PROVIDER_TEMPLATES
    .filter(t => t.authType === 'oauth' && t.supported && t.addable !== false && !t.hidden && !configured.has(t.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getTemplateById(id: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find(t => t.id === id);
}

export function filterTemplates(templates: ProviderTemplate[], query: string): ProviderTemplate[] {
  const q = query.trim().toLowerCase();
  if (!q) return templates;
  return templates.filter(
    t =>
      t.id.toLowerCase().includes(q) ||
      t.name.toLowerCase().includes(q) ||
      t.npm.toLowerCase().includes(q),
  );
}
