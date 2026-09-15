import { resolveProviderCredential } from './env.js';
import type { CompatibilityAgent } from './model-compatibility.js';
import { oauthAuthRef } from './registry/import-build.js';
import { loadRegistry } from './registry/io.js';
import { loadRegistryProviders } from './registry/load.js';
import { refreshAllProviderModels, type RefreshModelsResult } from './registry/refresh-models.js';
import { getTemplateById } from './provider-templates.js';
import type { LocalProvider } from './types.js';
import type { ServerModelInfo } from './server/models.js';

export async function fetchProviderCatalog(
  opts?: { agent?: CompatibilityAgent },
): Promise<LocalProvider[]> {
  return loadRegistryProviders(undefined, opts);
}

export interface FreshCatalogUnavailable {
  providerId: string;
  providerName: string;
  reason: string;
  modelIds?: string[];
}

export interface FreshProviderCatalog {
  providers: LocalProvider[];
  unavailable: FreshCatalogUnavailable[];
}

function hasConfirmedContext(model: LocalProvider['models'][number]): boolean {
  return typeof model.contextWindow === 'number'
    && Number.isSafeInteger(model.contextWindow)
    && model.contextWindow > 0
    && model.contextWindowUnconfirmed !== true;
}

function nativeAnthropicModels(provider: LocalProvider): LocalProvider['models'] {
  if (provider.id !== 'anthropic') return [];
  return provider.models.filter(model => model.modelFormat === 'anthropic');
}

export function filterFreshProviderCatalog(
  providers: LocalProvider[],
  refresh: RefreshModelsResult,
  refreshError?: string,
): FreshProviderCatalog {
  const refreshedById = new Map(refresh.refreshed.map(result => [result.id, result]));
  const unavailable: FreshCatalogUnavailable[] = [];
  const recordUnavailable = (provider: LocalProvider, reason: string, modelIds?: string[]) => {
    unavailable.push({
      providerId: provider.id,
      providerName: provider.name,
      reason,
      ...(modelIds && modelIds.length > 0 ? { modelIds } : {}),
    });
  };
  const available = providers.flatMap(provider => {
    const result = refreshedById.get(provider.id);
    const nativeModels = nativeAnthropicModels(provider);
    const externalModels = provider.models.filter(model => !nativeModels.includes(model));

    if (!result || !result.ok || result.skipped || result.modelSource !== 'live') {
      const reason = !result
        ? (refreshError ?? 'Fresh model discovery did not complete.')
        : result.reason
          ?? refreshError
          ?? (result.modelSource !== 'live'
            ? 'Fresh model discovery did not return a live provider model list.'
            : 'Fresh model discovery did not complete.');
      if (nativeModels.length > 0) {
        if (externalModels.length > 0) recordUnavailable(provider, reason, externalModels.map(model => model.id));
        return [{ ...provider, models: nativeModels }];
      }
      recordUnavailable(provider, reason, externalModels.map(model => model.id));
      return [];
    }

    const liveExternal = externalModels.map(model => hasConfirmedContext(model) ? model : {
      ...model,
      contextWindow: undefined,
      maxContextWindow: undefined,
      contextWindowUnconfirmed: true,
    });
    return [{ ...provider, models: [...nativeModels, ...liveExternal] }];
  });

  return { providers: available, unavailable };
}

interface CatalogRefresh {
  refresh: RefreshModelsResult;
  refreshError?: string;
}

let catalogRefreshInFlight: Promise<CatalogRefresh> | undefined;

async function refreshCatalog(): Promise<CatalogRefresh> {
  try {
    const refresh = await refreshAllProviderModels(async provider =>
      resolveProviderCredential(provider.id, provider.authRef),
    );
    return { refresh };
  } catch (error) {
    return {
      refresh: { refreshed: [] },
      refreshError: error instanceof Error ? error.message : String(error),
    };
  }
}

function refreshCatalogOnce(): Promise<CatalogRefresh> {
  if (catalogRefreshInFlight) return catalogRefreshInFlight;
  const request = refreshCatalog().finally(() => {
    if (catalogRefreshInFlight === request) catalogRefreshInFlight = undefined;
  });
  catalogRefreshInFlight = request;
  return request;
}

async function discoverFreshProviderCatalog(
  opts?: { agent?: CompatibilityAgent },
): Promise<FreshProviderCatalog> {
  const { refresh, refreshError } = await refreshCatalogOnce();
  const providers = await loadRegistryProviders(undefined, opts);
  return filterFreshProviderCatalog(providers, refresh, refreshError);
}

export function fetchFreshProviderCatalog(
  opts?: { agent?: CompatibilityAgent },
): Promise<FreshProviderCatalog> {
  return discoverFreshProviderCatalog(opts);
}

export interface BrowsingCatalogStatus {
  providerId: string;
  providerName: string;
  source: 'live' | 'cache' | 'seed' | 'fallback' | 'unavailable';
  fetchedAt?: string;
  reason?: string;
}

export interface BrowsingProviderCatalog {
  providers: LocalProvider[];
  statuses: BrowsingCatalogStatus[];
}

export async function fetchBrowsingProviderCatalog(
  opts?: { agent?: CompatibilityAgent },
): Promise<BrowsingProviderCatalog> {
  const { refresh, refreshError } = await refreshCatalogOnce();
  const providers = await loadRegistryProviders(undefined, opts);
  const refreshedById = new Map(refresh.refreshed.map(result => [result.id, result]));
  const statuses = loadRegistry().providers.filter(provider => provider.enabled).map(provider => {
    const result = refreshedById.get(provider.id);
    const live = result?.ok && !result.skipped && result.modelSource === 'live';
    const hasCache = (provider.modelsCache?.models.length ?? 0) > 0;
    const source: BrowsingCatalogStatus['source'] = live
      ? 'live'
      : !hasCache ? 'unavailable'
        : result?.modelSource === 'seed' || result?.modelSource === 'fallback'
          ? result.modelSource : 'cache';
    return {
      providerId: provider.id,
      providerName: provider.name,
      source,
      fetchedAt: provider.modelsCache?.fetchedAt,
      reason: result?.reason ?? (live ? undefined
        : refreshError ?? provider.modelDiscoveryError?.reason ?? 'Fresh model discovery did not complete.'),
    };
  });
  return { providers, statuses };
}

export function providersForPicker(providers: LocalProvider[]): LocalProvider[] {
  for (const p of providers) {
    p.models.sort((a, b) => {
      const nameA = a.name || a.id;
      const nameB = b.name || b.id;
      return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true });
    });
  }

  return providers.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

export async function resolveLocalProviderApiKey(provider: LocalProvider): Promise<string | null> {
  const direct = provider.apiKey?.trim();
  if (direct) return direct;

  if (provider.authType === 'none') return 'anonymous';

  const template = getTemplateById(provider.id);
  if (template?.apiKeyOptional || template?.anonymousFreeModels) {
    return 'anonymous';
  }

  const reg = loadRegistry().providers.find(p => p.id === provider.id);
  const authRef = reg?.authRef ?? oauthAuthRef(provider.id);
  return resolveProviderCredential(provider.id, authRef);
}

export function formatRegistryAuthLabel(
  provider: Pick<import('./registry/types.js').RegistryProvider, 'authRef' | 'authType'>,
): string {
  if (provider.authType === 'oauth' || provider.authRef.includes('oauth:provider:')) {
    return 'keychain (OAuth)';
  }
  if (provider.authType === 'none') {
    return 'gcloud / manual credentials';
  }
  if (provider.authRef.startsWith('keyring:')) {
    return 'keychain (API key)';
  }
  if (provider.authRef.startsWith('env:')) {
    return provider.authRef;
  }
  return provider.authRef;
}

export interface ProviderDisplayEntry {
  id: string;
  name: string;
  modelCount: number;
  enabled: boolean;
  authLabel: string;
  inRegistry: boolean;
}

export async function resolveProvidersForDisplay(): Promise<ProviderDisplayEntry[]> {
  const reg = loadRegistry();
  const entries: ProviderDisplayEntry[] = [];

  for (const provider of reg.providers) {
    entries.push({
      id: provider.id,
      name: provider.name,
      modelCount: provider.modelsCache?.models.length ?? 0,
      enabled: provider.enabled,
      authLabel: formatRegistryAuthLabel(provider),
      inRegistry: true,
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function localProvidersToServerModels(localProviders: LocalProvider[]): ServerModelInfo[] {
  return localProviders.flatMap(provider =>
    provider.models.map(model => ({
      id: model.id,
      name: model.name,
      isFree: model.isFree ?? false,
      freeStatus: model.freeStatus,
      brand: model.brand,
      providerLabel: provider.name,
      providerId: provider.id,
      sourceBackend: provider.id,
      modelFormat: model.modelFormat,
      upstreamModelId: model.upstreamModelId,
      cost: model.cost,
      baseUrl: model.baseUrl,
      completionsUrl: model.completionsUrl,
      npm: model.modelFormat === 'openai' ? (model.npm || '@ai-sdk/openai-compatible') : model.npm,
      apiBaseUrl: model.apiBaseUrl,
      apiKey: provider.apiKey,
      authType: provider.authType,
      oauthAccountId: provider.oauthAccountId,
      contextWindow: model.contextWindow,
      maxContextWindow: model.maxContextWindow,
      inputTokenLimit: model.inputTokenLimit,
      outputTokenLimit: model.outputTokenLimit,
      minimalClientVersion: model.minimalClientVersion,
      contextWindowUnconfirmed: model.contextWindowUnconfirmed,
      supportedParameters: model.supportedParameters,
      reasoning: model.reasoning,
      supportsTemperature: model.supportsTemperature,
      supportedReasoningEfforts: model.supportedReasoningEfforts,
      defaultReasoningEffort: model.defaultReasoningEffort,
      supportsReasoningSummaries: model.supportsReasoningSummaries,
      supportsReasoningSummaryParameter: model.supportsReasoningSummaryParameter,
      supportsParallelToolCalls: model.supportsParallelToolCalls,
      supportsReasoningToggle: model.supportsReasoningToggle,
      supportsPromptCacheBreakpoints: model.supportsPromptCacheBreakpoints,
      interleavedReasoningField: model.interleavedReasoningField,
      useResponsesLite: model.useResponsesLite,
      preferWebSockets: model.preferWebSockets,
      headers: provider.headers,
      providerData: provider.providerData,
    }))
  );
}
