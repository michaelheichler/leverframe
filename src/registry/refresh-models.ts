import { fetchAnthropicModels } from './custom-endpoint.js';
import { fetchTemplateModels } from './fetch-template-models.js';
import { loadRegistry, updateRegistry } from './io.js';
import { reconcilePendingCredentialDeletes } from './credential-lifecycle.js';
import { resolveModelSource } from './model-source.js';
import { validateCustomEndpointUrl } from './url-security.js';
import {
  effectiveProviderBaseUrl,
  resolveProviderTemplate,
  syntheticTemplate,
} from './resolve-template.js';
import {
  buildPricingIndex,
  enrichModelsWithPricing,
  enrichPricingAsync,
  loadPricingCache,
  pricingPlatformForProvider,
} from './pricing.js';
import { cachedModelCount, isLikelyPlaceholderKey, resolveRefreshCredential, skipWithCachedModels } from './refresh-credentials.js';
import type { CachedModel, ProviderRegistry, RegistryProvider } from './types.js';
import { buildOpenAiOAuthModels, CHATGPT_CODEX_UNSUPPORTED_MODELS } from '../data/openai-oauth-models.js';
import { modelPrefersResponsesApi } from '../provider-factory.js';
import { deriveBrand } from '../models.js';
import { getInstalledClaudeVersion } from '../launch.js';
import { classifyFreeStatus, isFreeStatus } from '../free-models.js';
import { redactTraceLine } from '../trace-log.js';
import {
  classifyCopilotModelFailure,
  refreshCopilotModels,
  type CopilotModelFailureKind,
} from '../copilot/models.js';
import {
  createDefaultCopilotRuntime,
  type CopilotRuntimeHandle,
} from '../copilot/runtime.js';

export interface RefreshProviderResult {
  id: string;
  name: string;
  ok: boolean;
  modelCount?: number;
  previousModelCount?: number;
  skipped?: boolean;
  reason?: string;
  failureKind?: CopilotModelFailureKind;
  failureReason?: string;
}

export interface RefreshModelsResult {
  refreshed: RefreshProviderResult[];
}

type OAuthModelRefreshResult = {
  models: CachedModel[];
  baseUrl?: string;
  source: 'live' | 'seed' | 'cache';
  failureReason?: string;
  failureKind?: CopilotModelFailureKind;
};

const MAX_DISCOVERY_ERROR_LENGTH = 500;

/** Collects graceful and forced shutdown failures without masking the caller's error. */

async function disposeCopilotRuntime(runtime: CopilotRuntimeHandle): Promise<Error[]> {
  const errors: Error[] = [];
  try {
    errors.push(...await runtime.stop());
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  }
  if (errors.length === 0) return errors;
  try {
    await runtime.forceStop();
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  }
  return errors;
}

/** Runs one isolated SDK catalog request and always attempts complete runtime disposal. */

async function refreshCopilotOAuthModels(
  provider: RegistryProvider,
  accessToken: string,
): Promise<OAuthModelRefreshResult> {
  const runtime = createDefaultCopilotRuntime({
    gitHubToken: accessToken,
    nodeVersion: process.version,
    environment: process.env,
  });
  let result: OAuthModelRefreshResult | undefined;
  let discoveryError: unknown;
  try {
    result = await refreshCopilotModels({
      listModels: () => runtime.listModels(),
      cachedModels: provider.modelsCache?.models ?? [],
    });
  } catch (error) {
    discoveryError = error;
  }

  const cleanupErrors = await disposeCopilotRuntime(runtime);
  if (discoveryError !== undefined) {
    if (cleanupErrors.length > 0) {
      const message = discoveryError instanceof Error ? discoveryError.message : String(discoveryError);
      throw new AggregateError([discoveryError, ...cleanupErrors], message, {
        cause: discoveryError,
      });
    }
    throw discoveryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Copilot runtime did not stop cleanly');
  }
  if (result === undefined) {
    throw new Error('Copilot model discovery did not return a result');
  }
  return result;
}

async function refreshOAuthProvider(
  provider: RegistryProvider,
  accessToken: string,
): Promise<OAuthModelRefreshResult> {
  const templateId = provider.templateId ?? provider.id;
  if (templateId === 'openai' || templateId === 'openai-oauth') {
    return refreshOpenAiOAuthModels(accessToken);
  }
  if (templateId === 'github-copilot') {
    return refreshCopilotOAuthModels(provider, accessToken);
  }
  throw new Error(`refreshOAuthProvider: unsupported template "${templateId}"`);
}

interface OpenAiModelEntry {
  id: string;
  name: string;
  context_window?: unknown;
  /** Provider-reported maximum, above the window it serves by default. */
  max_context_window?: unknown;
  useResponsesLite?: boolean;
  preferWebSockets?: boolean;
}

function readCapabilityFlags(m: Record<string, unknown>): Pick<OpenAiModelEntry, 'useResponsesLite' | 'preferWebSockets'> {
  const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
  return {
    useResponsesLite: bool(m['use_responses_lite']),
    preferWebSockets: bool(m['prefer_websockets']),
  };
}

function confirmedContextWindow(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseOpenAiModelEntries(body: unknown): OpenAiModelEntry[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as Record<string, unknown>;

  if (Array.isArray(b.models)) {
    return (b.models as Array<Record<string, unknown>>)
      .map(m => ({
        id: (m.slug as string) ?? '',
        name: (m.title as string) ?? (m.name as string) ?? (m.slug as string) ?? '',
        context_window: m.context_window,
        max_context_window: m.max_context_window,
        ...readCapabilityFlags(m),
      }))
      .filter(m => m.id.length > 0);
  }
  if (Array.isArray(b.data)) {
    return (b.data as Array<Record<string, unknown>>)
      .map(m => ({
        id: (m.id as string) ?? '',
        name: (m.name as string) ?? (m.id as string) ?? '',
        context_window: m.context_window,
        max_context_window: m.max_context_window,
        ...readCapabilityFlags(m),
      }))
      .filter(m => m.id.length > 0);
  }
  return [];
}

function buildDynamicOAuthModel(entry: OpenAiModelEntry, seedById: Map<string, CachedModel>): CachedModel {
  const seed = seedById.get(entry.id);
  const contextWindow = confirmedContextWindow(entry.context_window);
  const maxContextWindow = confirmedContextWindow(entry.max_context_window);
  if (seed) {
    return {
      ...seed,
      contextWindow,
      maxContextWindow,
      contextWindowUnconfirmed: contextWindow === undefined ? true : undefined,
      useResponsesLite: entry.useResponsesLite ?? seed.useResponsesLite,
      preferWebSockets: entry.preferWebSockets ?? seed.preferWebSockets,
    };
  }
  const { id } = entry;
  const prefix = id.split('-')[0] ?? id;
  return {
    id,
    name: entry.name,
    upstreamModelId: id,
    family: prefix,
    brand: deriveBrand(prefix),
    contextWindow,
    maxContextWindow,
    contextWindowUnconfirmed: contextWindow === undefined ? true : undefined,
    modelFormat: 'openai' as const,
    npm: '@ai-sdk/openai',
    reasoning: modelPrefersResponsesApi(id),
    useResponsesLite: entry.useResponsesLite,
    preferWebSockets: entry.preferWebSockets,
  };
}

async function fetchJsonWithAuth(
  url: string,
  accessToken: string,
  timeoutMs: number,
): Promise<{ body: unknown | null; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!response.ok) {
      const detail = await response.text().then(t => t.slice(0, 200)).catch(() => '');
      return { body: null, error: `HTTP ${response.status}${detail ? `: ${detail}` : ''}` };
    }
    return { body: await response.json() };
  } catch (err) {
    return { body: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function refreshOpenAiOAuthModels(
  accessToken: string,
): Promise<{ models: CachedModel[]; source: 'live' | 'seed'; failureReason?: string }> {
  const TIMEOUT_MS = 10_000;
  const seedById = new Map(buildOpenAiOAuthModels().map(m => [m.id, m]));
  const toModels = (entries: OpenAiModelEntry[]) =>
    entries.map(entry => buildDynamicOAuthModel(entry, seedById));

  const claudeVersion = getInstalledClaudeVersion();

  const codexResult = await fetchJsonWithAuth(
    `https://chatgpt.com/backend-api/codex/models?client_version=${claudeVersion}`,
    accessToken,
    TIMEOUT_MS,
  );
  const codexEntries = parseOpenAiModelEntries(codexResult.body);
  if (codexEntries.length > 0) {
    return { models: toModels(codexEntries), source: 'live' };
  }

  const chatGptResult = await fetchJsonWithAuth(
    'https://chatgpt.com/backend-api/models',
    accessToken,
    TIMEOUT_MS,
  );
  const chatGptEntries = parseOpenAiModelEntries(chatGptResult.body)
    .filter(({ id }) => !CHATGPT_CODEX_UNSUPPORTED_MODELS.has(id));
  if (chatGptEntries.length > 0) {
    return { models: toModels(chatGptEntries), source: 'live' };
  }

  return {
    models: [...seedById.values()],
    source: 'seed',
    failureReason: chatGptResult.error ?? codexResult.error,
  };
}

async function refreshApiListProvider(
  provider: RegistryProvider,
  apiKey: string,
): Promise<{ models: CachedModel[]; baseUrl?: string; error?: string }> {
  const npm = provider.api.npm ?? '@ai-sdk/openai-compatible';
  const catalogTemplate = resolveProviderTemplate(provider);
  const baseUrl = effectiveProviderBaseUrl(provider, catalogTemplate);

  if (!baseUrl) {
    return { models: [], error: 'Provider has no API base URL configured.' };
  }

  let safeBaseUrl = baseUrl;
  const configuredUrl = provider.api.url?.trim();
  const templateDefault = catalogTemplate?.defaultBaseUrl?.trim();
  if (configuredUrl && configuredUrl !== templateDefault) {
    const urlCheck = await validateCustomEndpointUrl(baseUrl, {
      allowInsecureLocal: catalogTemplate?.apiKeyOptional === true,
    });
    if (!urlCheck.ok || !urlCheck.normalizedUrl) {
      return { models: [], error: `${urlCheck.error ?? 'Invalid API base URL.'} ${urlCheck.hint ?? ''}`.trim() };
    }
    safeBaseUrl = urlCheck.normalizedUrl;
  }

  const template = catalogTemplate ?? syntheticTemplate(provider, safeBaseUrl);

  if (npm === '@ai-sdk/anthropic') {
    const fetched = await fetchAnthropicModels(safeBaseUrl, apiKey);
    if (fetched.error || fetched.models.length === 0) {
      return { models: [], error: fetched.error ?? 'No models returned.', baseUrl: fetched.baseUrl };
    }
    return {
      models: fetched.models.map(m => ({ ...m, apiUrl: fetched.baseUrl })),
      baseUrl: fetched.baseUrl,
    };
  }

  const fetched = await fetchTemplateModels(template, apiKey, safeBaseUrl);
  if (fetched.error || fetched.models.length === 0) {
    return { models: [], error: fetched.error ?? 'No models returned.' };
  }
  const usableModels = !apiKey.trim() && template.anonymousFreeModels
    ? fetched.models.filter(model => isFreeStatus(classifyFreeStatus({
        model,
        providerId: provider.id,
        templateId: provider.templateId,
      })))
    : fetched.models;
  if (usableModels.length === 0) {
    return { models: [], error: 'No free models were returned for anonymous access.' };
  }

  return {
    models: usableModels.map(m => ({
      ...m,
      apiUrl: fetched.baseUrl,
    })),
    baseUrl: fetched.baseUrl,
  };
}

function updateProviderCache(
  registry: ProviderRegistry,
  providerId: string,
  models: CachedModel[],
  baseUrl?: string,
): void {
  const idx = registry.providers.findIndex(p => p.id === providerId);
  if (idx < 0) return;
  const now = new Date().toISOString();
  const existing = registry.providers[idx]!;
  const { modelDiscoveryError: _previousDiscoveryError, ...provider } = existing;
  registry.providers[idx] = {
    ...provider,
    refreshedAt: now,
    api: baseUrl ? { ...existing.api, url: baseUrl } : existing.api,
    modelsCache: {
      fetchedAt: now,
      models,
    },
  };
}

function recordCopilotDiscoveryError(
  providerId: string,
  kind: CopilotModelFailureKind,
  reason: string,
  previousRefreshedAt: string | undefined,
): void {
  updateRegistry(registry => {
    const provider = registry.providers.find(entry => entry.id === providerId);
    if (provider?.templateId !== 'github-copilot') return;
    if (provider.refreshedAt !== previousRefreshedAt) return;
    provider.modelDiscoveryError = {
      failedAt: new Date().toISOString(),
      kind,
      reason,
    };
  });
}

function safeCopilotDiscoveryReason(reason: string, accessToken: string | null): string {
  const redacted = redactTraceLine(reason, accessToken === null ? [] : [accessToken]);
  const withoutControlCharacters = Array.from(redacted, character => {
    const code = character.charCodeAt(0);
    return code <= 31 || code >= 127 && code <= 159 ? ' ' : character;
  }).join('');
  const compact = withoutControlCharacters.replace(/\s+/gu, ' ').trim();
  if (compact.length <= MAX_DISCOVERY_ERROR_LENGTH) return compact;
  const marker = ' [truncated]';
  return compact.slice(0, MAX_DISCOVERY_ERROR_LENGTH - marker.length) + marker;
}

function copilotDiscoveryFailureMessage(
  kind: CopilotModelFailureKind,
  reason: string,
  cachedModelCount: number,
): string {
  const detail = reason.length === 0 ? '' : ` (${reason})`;
  const cache = cachedModelCount === 0
    ? ''
    : ` Kept ${cachedModelCount} cached model${cachedModelCount === 1 ? '' : 's'}.`;
  if (kind === 'sdk') {
    return `GitHub Copilot runtime is unavailable${detail}.${cache} Install @github/copilot-sdk@1.0.9 and refresh models.`;
  }
  if (kind === 'authentication') {
    return `GitHub Copilot authentication or subscription validation failed${detail}.${cache} Sign in again with leverframe providers auth github-copilot.`;
  }
  if (kind === 'policy') {
    return `GitHub Copilot exposes no policy-enabled models${detail}.${cache} Check your organization model policy.`;
  }
  if (kind === 'empty') {
    return `GitHub Copilot returned no models${detail}.${cache} Confirm this account has an eligible Copilot subscription.`;
  }
  if (kind === 'schema') {
    return `GitHub Copilot returned unexpected model data${detail}.${cache} Update Leverframe or @github/copilot-sdk before retrying.`;
  }
  return `GitHub Copilot model discovery failed${detail}.${cache} Try refreshing again later.`;
}

async function refreshProviderModelsInner(
  providerId: string,
  apiKey: string | null,
  registry = loadRegistry(),
): Promise<RefreshProviderResult> {
  const provider = registry.providers.find(p => p.id === providerId);
  if (!provider) {
    return { id: providerId, name: providerId, ok: false, reason: 'Provider not found.' };
  }

  const source = resolveModelSource(provider);
  if (source === 'manual-only') {
    return {
      id: provider.id,
      name: provider.name,
      ok: true,
      skipped: true,
      reason: 'Manual-only provider. The model list is not refreshed automatically.',
    };
  }

  try {
    const previousModelCount = provider.modelsCache?.models.length ?? 0;
    let models: CachedModel[] = [];
    let baseUrl: string | undefined;
    let oauthFallbackReason: string | undefined;

    const oauthTemplateId = provider.templateId ?? provider.id;
    const supportsOAuthDiscovery = provider.authType === 'oauth'
      && ['openai', 'openai-oauth', 'github-copilot'].includes(oauthTemplateId);
    if (supportsOAuthDiscovery) {
      if (!apiKey) {
        const reason = 'OAuth token not available. Sign in again with leverframe providers auth.';
        return {
          id: provider.id,
          name: provider.name,
          ok: false,
          reason,
          failureKind: 'authentication',
        };
      }
      const oauthResult = await refreshOAuthProvider(provider, apiKey);
      const failureDetail = oauthResult.failureReason ? ` (${oauthResult.failureReason})` : '';
      if (oauthResult.source === 'cache') {
        const reason = oauthResult.failureKind === 'schema'
          ? `Copilot returned unexpected model data${failureDetail}. Kept your existing cached model list. Update Leverframe or its Copilot SDK before retrying.`
          : `Live model discovery failed${failureDetail}. Kept your existing cached model list. Try refreshing again later.`;
        return {
          ...skipWithCachedModels(provider, reason),
          failureKind: oauthResult.failureKind,
          failureReason: oauthResult.failureReason,
        };
      }
      if (oauthResult.source === 'seed' && cachedModelCount(provider) > 0) {
        return skipWithCachedModels(
          provider,
          `Live model discovery failed${failureDetail}. Kept your existing cached model list instead of `
          + "overwriting it with leverframe's built-in fallback list. Try refreshing again later.",
        );
      }
      if (oauthResult.source === 'seed') {
        oauthFallbackReason = `Live model discovery failed${failureDetail}. Showing leverframe's built-in fallback `
          + 'model list, which may not include the newest models yet. Try refreshing again later.';
      }
      models = oauthResult.models;
      if (models.length === 0) {
        return {
          id: provider.id,
          name: provider.name,
          ok: false,
          reason: 'No models available for this OAuth provider. Sign in again.',
        };
      }
    } else {
      const template = resolveProviderTemplate(provider);
      const keyOptional = template?.apiKeyOptional === true;
      const effectiveKey = keyOptional && isLikelyPlaceholderKey(apiKey) ? '' : apiKey;
      if (!keyOptional && isLikelyPlaceholderKey(effectiveKey)) {
        if (cachedModelCount(provider) > 0) {
          return skipWithCachedModels(
            provider,
            'A placeholder API key is configured. Kept cached model list. '
            + 'Add this provider again via leverframe providers add with a real key to refresh live.',
          );
        }
        return {
          id: provider.id,
          name: provider.name,
          ok: false,
          reason: 'No usable API key. Add the provider via leverframe providers add with a real key.',
        };
      }
      if (!keyOptional && !effectiveKey) {
        return {
          id: provider.id,
          name: provider.name,
          ok: false,
          reason: 'API key not available. Cannot refresh models.',
        };
      }
      const fetched = await refreshApiListProvider(provider, effectiveKey ?? '');
      if (fetched.error) {
        if (
          (fetched.error.includes('rejected') || fetched.error.includes('401') || fetched.error.includes('403'))
          && cachedModelCount(provider) > 0
        ) {
          return skipWithCachedModels(
            provider,
            `${fetched.error} Kept ${cachedModelCount(provider)} cached model${cachedModelCount(provider) === 1 ? '' : 's'} from import. `
            + 'Update your API key via leverframe providers add if you need a live refresh.',
          );
        }
        return { id: provider.id, name: provider.name, ok: false, reason: fetched.error };
      }
      models = fetched.models;
      baseUrl = fetched.baseUrl;
    }

    const pricingCache = loadPricingCache();
    const platform = pricingPlatformForProvider(provider.templateId, provider.id);
    const enriched = enrichModelsWithPricing(models, buildPricingIndex(pricingCache), platform);

    updateRegistry(current => {
      updateProviderCache(current, providerId, enriched, baseUrl);
    });
    enrichPricingAsync();

    return {
      id: provider.id,
      name: provider.name,
      ok: true,
      modelCount: enriched.length,
      previousModelCount: provider.refreshedAt ? previousModelCount : undefined,
      reason: oauthFallbackReason,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      id: provider.id,
      name: provider.name,
      ok: false,
      reason,
      failureReason: reason,
      failureKind: (provider.templateId ?? provider.id) === 'github-copilot'
        ? classifyCopilotModelFailure(err)
        : undefined,
    };
  }
}

export async function refreshProviderModels(
  providerId: string,
  apiKey: string | null,
  registry = loadRegistry(),
): Promise<RefreshProviderResult> {
  try {
    let result = await refreshProviderModelsInner(providerId, apiKey, registry);
    const provider = registry.providers.find(entry => entry.id === providerId);
    if (
      provider?.templateId === 'github-copilot'
      && (!result.ok || result.skipped)
      && result.reason
    ) {
      const kind = result.failureKind ?? classifyCopilotModelFailure(result.failureReason ?? result.reason);
      const failureReason = safeCopilotDiscoveryReason(result.failureReason ?? result.reason, apiKey);
      result = {
        ...result,
        reason: copilotDiscoveryFailureMessage(kind, failureReason, cachedModelCount(provider)),
        failureKind: kind,
        failureReason,
      };
      recordCopilotDiscoveryError(
        providerId,
        kind,
        failureReason,
        provider.refreshedAt,
      );
    }
    return result;
  } finally {
    await reconcilePendingCredentialDeletes();
  }
}

export async function refreshAllProviderModels(
  resolveKey: (provider: RegistryProvider) => Promise<string | null>,
): Promise<RefreshModelsResult> {
  const refreshed: RefreshProviderResult[] = [];
  const registry = loadRegistry();

  const enabledProviders = registry.providers.filter(p => p.enabled);

  for (const provider of enabledProviders) {
    const key = await resolveRefreshCredential(provider, resolveKey);
    refreshed.push(await refreshProviderModels(provider.id, key, registry));
  }

  return { refreshed };
}
