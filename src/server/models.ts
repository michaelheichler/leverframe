
import { reportedContextWindow } from '../context-window.js';
import { aliasModelId } from '../proxy.js';
import { httpProxyModelId } from '../http-proxy/routes.js';
import { maskGatewayModelId } from './vendor-mask.js';
import type { FreeStatus } from '../free-models.js';
import type { ModelAlias } from '../types.js';

export interface GatewayModelOptions {
  maskGatewayIds?: boolean;
}

export type ServerModelFormat = 'anthropic' | 'openai' | 'cloud-code' | 'unsupported';
export type ServerModelSource = string;

export interface ServerModelInfo {
  id: string;
  name: string;
  isFree: boolean;
  freeStatus?: FreeStatus;
  brand: string;
  sourceBackend: ServerModelSource;
  modelFormat: ServerModelFormat;

  upstreamModelId?: string;
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  baseUrl?: string;        // anthropic-format: direct Anthropic-protocol URL (without /v1)
  completionsUrl?: string; // openai-format: full chat completions endpoint URL
  npm?: string;            // OpenCode api.npm - openai-format models route through the SDK adapter
  apiBaseUrl?: string;     // base URL for openai-compatible / openrouter SDK providers
  apiKey?: string;         // model-specific API key; overrides server-level apiKey if set; never returned in API responses
  authType?: 'api' | 'oauth' | 'none';
  oauthAccountId?: string;
  supportedParameters?: string[];
  reasoning?: boolean;
  supportsTemperature?: boolean;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  supportsReasoningSummaries?: boolean;
  supportsReasoningSummaryParameter?: boolean;
  supportsParallelToolCalls?: boolean;
  supportsReasoningToggle?: boolean;
  supportsPromptCacheBreakpoints?: boolean;
  interleavedReasoningField?: string;

  useResponsesLite?: boolean;

  preferWebSockets?: boolean;

  defaultEffort?: string;
  contextWindow?: number;
  maxContextWindow?: number;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  minimalClientVersion?: string;

  contextWindowUnconfirmed?: boolean;

  providerLabel?: string;

  providerId?: string;

  headers?: Record<string, string>;

  providerData?: Record<string, unknown>;
}

export interface ModelCatalog {
  get: (id: string) => ServerModelInfo | undefined;
  list: () => ServerModelInfo[];
}

const CREATED_AT_ISO = '2025-01-01T00:00:00Z';
const CREATED_AT_UNIX = 1735689600;

export function formatAnthropicModelEntry(entry: ModelDisplayEntry) {
  const { id, name, contextWindow, contextWindowUnconfirmed } = entry;
  const maxInput = reportedContextWindow(contextWindow, contextWindowUnconfirmed);
  return {
    id,
    type: 'model' as const,
    display_name: name,
    created_at: CREATED_AT_ISO,
    ...(maxInput === undefined ? {} : {
      context_window: maxInput,
      max_input_tokens: maxInput,
    }),
  };
}

export function createModelCatalog(models: ServerModelInfo[]): ModelCatalog {
  const byId = new Map(models.map(model => [model.id, model]));

  return {
    get: (id: string) => byId.get(id),
    list: () => [...models],
  };
}

export interface ModelDisplayEntry {
  id: string;
  name: string;
  contextWindow?: number;
  contextWindowUnconfirmed?: boolean;
}

export function formatAnthropicModelList(entries: ModelDisplayEntry[]) {
  return {
    data: entries.map(entry => formatAnthropicModelEntry(entry)),
    has_more: false,
    first_id: entries[0]?.id ?? null,
    last_id: entries.at(-1)?.id ?? null,
  };
}

export function formatAnthropicModels(models: ServerModelInfo[]) {
  return formatAnthropicModelList(
    models.map(model => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      contextWindowUnconfirmed: model.contextWindowUnconfirmed,
    })),
  );
}

export function gatewayProviderLabel(model: ServerModelInfo): string {
  return model.providerLabel ?? model.sourceBackend;
}

export function gatewayProviderId(model: ServerModelInfo): string {
  return model.providerId ?? model.sourceBackend;
}

export function gatewayAliasId(model: ServerModelInfo): string {
  return aliasModelId(model.id, gatewayProviderId(model));
}

export function exposedGatewayAliasId(model: ServerModelInfo, opts?: GatewayModelOptions): string {
  const alias = gatewayAliasId(model);
  return opts?.maskGatewayIds ? maskGatewayModelId(alias) : alias;
}

export function gatewayDisplayName(model: ServerModelInfo, opts?: GatewayModelOptions): string {
  if (!opts?.maskGatewayIds) return model.name;
  return `${model.name} (${gatewayProviderLabel(model)})`;
}

export function formatGatewayAnthropicModels(models: ServerModelInfo[], opts?: GatewayModelOptions) {
  return formatAnthropicModelList(
    models.map(model => ({
      id: exposedGatewayAliasId(model, opts),
      name: gatewayDisplayName(model, opts),
      contextWindow: model.contextWindow,
      contextWindowUnconfirmed: model.contextWindowUnconfirmed,
    })),
  );
}

export function createGatewayModelCatalog(
  models: ServerModelInfo[],
  opts?: GatewayModelOptions,
  modelAliases?: ModelAlias[],
): ModelCatalog {
  const byId = new Map<string, ServerModelInfo>();
  for (const model of models) {
    byId.set(model.id, model);
    const alias = exposedGatewayAliasId(model, opts);
    if (alias !== model.id) byId.set(alias, model);
    if (opts?.maskGatewayIds) {
      const rawAlias = gatewayAliasId(model);
      if (rawAlias !== alias) byId.set(rawAlias, model);
    }
  }
  for (const model of models) {
    const canonicalId = httpProxyModelId(gatewayProviderId(model), model.id);
    if (!byId.has(canonicalId)) byId.set(canonicalId, model);
  }
  for (const alias of modelAliases ?? []) {
    if (byId.has(alias.name)) continue;
    const target = models.find(
      model => gatewayProviderId(model) === alias.providerId && model.id === alias.modelId,
    );
    if (target) byId.set(alias.name, target);
  }

  return {
    get: (id: string) => byId.get(id),
    list: () => [...models],
  };
}

export function upstreamModelId(model: ServerModelInfo): string {
  const id = model.upstreamModelId ?? model.id;

  return id.replace(/\[1m\]$/i, '');
}

export interface ModelCatalogRow {
  name: string;
  anthropicId: string;
  openaiId: string;
}

export function buildDedupedModelRows(models: ServerModelInfo[], opts?: GatewayModelOptions): ModelCatalogRow[] {
  const seen = new Set<string>();
  const rows: ModelCatalogRow[] = [];
  for (const model of [...models].sort((a, b) => a.name.localeCompare(b.name))) {
    const row: ModelCatalogRow = {
      name: model.name,
      anthropicId: exposedGatewayAliasId(model, opts),
      openaiId: model.id,
    };
    const key = `${row.name}\u0000${row.anthropicId}\u0000${row.openaiId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

export function supportsDirectOpenAIChatCompletions(model: ServerModelInfo): boolean {
  return model.modelFormat === 'openai' && !!model.completionsUrl;
}

export function formatOpenAIModels(models: ServerModelInfo[]) {
  return {
    object: 'list',
    data: models.map(model => ({
      id: model.id,
      object: 'model',
      created: CREATED_AT_UNIX,
      owned_by: model.sourceBackend,
    })),
  };
}
