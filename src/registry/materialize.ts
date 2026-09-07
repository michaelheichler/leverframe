

import { shouldHideModel, type CompatibilityAgent } from '../model-compatibility.js';
import { deriveBrand } from '../models.js';
import type { LocalProvider, LocalProviderModel } from '../types.js';
import { normalizeGoogleDisplayName, normalizeGoogleModelId } from './google-model-id.js';
import type { CachedModel, ProviderRegistry, RegistryProvider } from './types.js';
import { isValidProviderId } from './validate.js';
import { getTemplateById } from '../provider-templates.js';
import { classifyFreeStatus, isFreeStatus } from '../free-models.js';
import { effectiveProviderBaseUrl, resolveProviderTemplate } from './resolve-template.js';

export type CredentialResolver = (provider: RegistryProvider) => string | null;

export function resolveEndpoint(
  npm: string,
  apiUrl: string,
): { format: 'anthropic' | 'openai'; baseUrl?: string; completionsUrl?: string } | null {
  if (!npm) return null;
  if (npm === '@ai-sdk/anthropic') {
    return {
      format: 'anthropic',
      baseUrl: (apiUrl || 'https://api.anthropic.com').replace(/\/v1\/?$/, ''),
    };
  }
  if (npm === '@ai-sdk/openai-compatible') {
    if (!apiUrl) return null;
    return {
      format: 'openai',
      completionsUrl: apiUrl.replace(/\/$/, '') + '/chat/completions',
    };
  }

  return { format: 'openai' };
}

export interface MaterializeOptions {
  agent?: CompatibilityAgent;
}

export function cachedModelToLocal(
  cached: CachedModel,
  provider: RegistryProvider,
): LocalProviderModel | null {
  const freeStatus = classifyFreeStatus({
    model: cached,
    providerId: provider.id,
    templateId: provider.templateId,
  });

  const npm = cached.npm ?? provider.api.npm ?? '';
  const apiUrl = cached.apiUrl
    ?? effectiveProviderBaseUrl(provider, resolveProviderTemplate(provider))
    ?? '';
  const endpoint = resolveEndpoint(npm, apiUrl);
  if (endpoint === null) return null;

  const { id, upstreamModelId: _upstreamModelId } = normalizeGoogleModelId(cached.id, npm);
  const normalizedUpstream = normalizeGoogleModelId(cached.upstreamModelId ?? cached.id, npm).upstreamModelId;
  const family = npm === '@ai-sdk/google' ? (id.split(/[-/:]/)[0] ?? id) : (cached.family ?? '');

  return {
    id,
    name: npm === '@ai-sdk/google' ? normalizeGoogleDisplayName(cached.name, id) : cached.name,
    family,
    brand: npm === '@ai-sdk/google' ? deriveBrand(family) : (cached.brand ?? deriveBrand(cached.family ?? '')),
    modelFormat: (cached.modelFormat === 'anthropic' || cached.modelFormat === 'openai' ? cached.modelFormat : undefined) ?? endpoint.format,
    upstreamModelId: normalizedUpstream,
    baseUrl: endpoint.baseUrl,
    completionsUrl: endpoint.completionsUrl,
    npm: npm || undefined,
    apiBaseUrl: apiUrl || undefined,
    cost: cached.cost,
    usageMultiplier: cached.usageMultiplier,
    usageMultiplierApplies: cached.usageMultiplierApplies,
    deprecated: cached.deprecated,
    isFree: isFreeStatus(freeStatus),
    freeStatus,
    contextWindow: cached.contextWindowUnconfirmed ? undefined : cached.contextWindow,
    maxContextWindow: cached.maxContextWindow,
    inputTokenLimit: cached.inputTokenLimit,
    outputTokenLimit: cached.outputTokenLimit,
    minimalClientVersion: cached.minimalClientVersion,
    contextWindowUnconfirmed: cached.contextWindowUnconfirmed,
    supportedParameters: cached.supportedParameters,
    reasoning: cached.reasoning,
    supportsTemperature: cached.supportsTemperature,
    supportedReasoningEfforts: cached.supportedReasoningEfforts,
    defaultReasoningEffort: cached.defaultReasoningEffort,
    supportsReasoningSummaries: cached.supportsReasoningSummaries,
    supportsReasoningSummaryParameter: cached.supportsReasoningSummaryParameter,
    supportsParallelToolCalls: cached.supportsParallelToolCalls,
    supportsReasoningToggle: cached.supportsReasoningToggle,
    supportsPromptCacheBreakpoints: cached.supportsPromptCacheBreakpoints,
    interleavedReasoningField: cached.interleavedReasoningField,
    useResponsesLite: cached.useResponsesLite,
    preferWebSockets: cached.preferWebSockets,
  };
}

function providerAllowsAnonymousFreeModels(provider: RegistryProvider): boolean {
  const template = getTemplateById(provider.templateId) ?? getTemplateById(provider.id);
  return template?.anonymousFreeModels === true;
}

function materializeOne(
  provider: RegistryProvider,
  resolveCredential: CredentialResolver,
  agent: CompatibilityAgent,
): LocalProvider | null {
  if (!provider.enabled) return null;
  if (!isValidProviderId(provider.id)) return null;

  const freeOnly = provider.subscriptionFilter === 'free';
  const apiKey = resolveCredential(provider) ?? '';
  const anonymousFreeOnly = !apiKey.trim() && providerAllowsAnonymousFreeModels(provider);
  const models: LocalProviderModel[] = [];
  for (const cached of provider.modelsCache?.models ?? []) {
    const freeStatus = classifyFreeStatus({
      model: cached,
      providerId: provider.id,
      templateId: provider.templateId,
    });
    if ((freeOnly || anonymousFreeOnly) && !isFreeStatus(freeStatus)) continue;
    const model = cachedModelToLocal(cached, provider);
    if (!model) continue;
    if (shouldHideModel({ providerId: provider.id, modelId: model.id, agent })) continue;
    models.push(model);
  }
  if (models.length === 0) return null;

  if (!apiKey.trim() && !anonymousFreeOnly) return null;

  return {
    id: provider.id,
    name: provider.name,
    apiKey,
    authType: provider.authType,
    headers: provider.api.headers,
    models,
  };
}

export function materializeRegistry(
  registry: ProviderRegistry,
  resolveCredential: CredentialResolver,
  opts?: MaterializeOptions,
): LocalProvider[] {
  const agent = opts?.agent ?? 'claude';
  const result: LocalProvider[] = [];
  for (const provider of registry.providers) {
    const local = materializeOne(provider, resolveCredential, agent);
    if (local) result.push(local);
  }
  return result;
}
