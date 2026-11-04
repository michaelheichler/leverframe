import { cachedModelToLocal } from './registry/materialize.js';
import { routingTransportFingerprint } from './routing-transport-identity.js';
import type { CachedModel, RegistryAccount, RegistryProvider } from './registry/types.js';
import { accountModelsCache } from './registry/account-cache.js';
import type { RoutingCatalogSnapshot } from './model-routing-catalog.js';
import type { RoutingBinding } from './routing-bindings.js';
import { eligible, sameRef, type RoutingCapability } from './routing-policy.js';

function containsImage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsImage);
  const object = value as Record<string, unknown>;
  return object.type === 'image' || containsImage(object.content);
}

export function routingRequestRequirements(binding: RoutingBinding, body: Record<string, unknown>) {
  const capabilities = new Set<RoutingCapability>(binding.requirements?.capabilities ?? []);
  if (Array.isArray(body.tools) && body.tools.length) capabilities.add('tools');
  if (containsImage(body.messages) || containsImage(body.system)) capabilities.add('images');
  const output = body.max_tokens;
  const contextTokens = typeof output === 'number' && Number.isSafeInteger(output) && output > 0
    ? Buffer.byteLength(JSON.stringify(body), 'utf8') + output : Infinity;
  return { capabilities: [...capabilities], contextTokens: Math.max(binding.requirements?.contextTokens ?? 0, contextTokens),
    ...(binding.requirements?.requireExternalBounds === true ? { requireExternalBounds: true as const } : {}) };
}

export function assertRoutingRequest(binding: RoutingBinding, catalog: RoutingCatalogSnapshot, body: Record<string, unknown>) {
  const requirements = routingRequestRequirements(binding, body);
  const model = catalog.models.find(item => sameRef(item.ref, binding.decision.target)
    && item.upstreamModelId === binding.identity.upstreamModelId
    && item.credential.source === binding.identity.credentialSource
    && (item.maxOutputTokens === undefined ? item.credential.source === 'claude-code'
      : Number.isSafeInteger(item.maxOutputTokens) && item.maxOutputTokens > 0
        && typeof body.max_tokens === 'number' && body.max_tokens <= item.maxOutputTokens)
    && eligible(item, binding.decision.effort, requirements));
  if (!model) throw new Error('The bound model cannot satisfy this request. Check its capabilities and context limit.');
  return model;
}

function cachedSupportsRequest(model: CachedModel, binding: RoutingBinding, body: Record<string, unknown>): boolean {
  const requirements = routingRequestRequirements(binding, body);
  if (binding.decision.effort && !model.supportedReasoningEfforts?.includes(binding.decision.effort)) return false;
  if (!Number.isSafeInteger(model.outputTokenLimit) || typeof body.max_tokens !== 'number'
    || body.max_tokens > model.outputTokenLimit!) return false;
  if (model.contextWindowUnconfirmed || (model.contextWindow ?? 0) < requirements.contextTokens) return false;
  return requirements.capabilities.every(capability => {
    if (capability === 'reasoning') return model.reasoning === true;
    if (capability === 'images') return model.vision === true;
    if (capability === 'tools') return model.supportedParameters?.includes('tools') === true;
    if (capability === 'promptCache') return model.supportsPromptCacheBreakpoints === true;
    return model.preferWebSockets === true;
  });
}

export function routingDirectFailure(binding: RoutingBinding, provider: RegistryProvider | undefined,
  accountId?: string, body?: Record<string, unknown>): 'identity' | 'requirements' | undefined {
  if (!provider?.enabled || provider.id !== binding.decision.target.providerId || provider.credentialSource === 'claude-code') return 'identity';
  const account = accountId ? provider.accounts?.find(item => item.id === accountId && item.enabled) : undefined;
  if (accountId && !account) return 'identity';
  const cache = account ? accountModelsCache(provider, account) : provider.modelsCache;
  if (!cache || provider.modelDiscoveryError || account?.modelDiscoveryError) return 'identity';
  const model = cache.models.find(model => {
    const local = cachedModelToLocal(model, provider);
    return local?.id === binding.decision.target.modelId && local.upstreamModelId === binding.identity.upstreamModelId
      && routingTransportFingerprint({ endpoint: local.apiBaseUrl ?? (local.modelFormat === 'anthropic' ? local.baseUrl : local.completionsUrl),
        npm: local.npm, format: local.modelFormat, credentialSource: 'registry', providerId: provider.id,
        authType: provider.authType }) === binding.identity.transportFingerprint;
  });
  if (!model) return 'identity';
  if (body && !cachedSupportsRequest(model, binding, body)) return 'requirements';
  return undefined;
}

export function routingAccountEligibility(binding: RoutingBinding, catalog: RoutingCatalogSnapshot, body: Record<string, unknown>) {
  const requirements = routingRequestRequirements(binding, body);
  const rows = catalog.models.filter(model => sameRef(model.ref, binding.decision.target)
    && Number.isSafeInteger(model.maxOutputTokens) && model.maxOutputTokens! > 0
    && typeof body.max_tokens === 'number' && body.max_tokens <= model.maxOutputTokens!
    && eligible(model, binding.decision.effort, requirements));
  return (account: RegistryAccount, provider: RegistryProvider): boolean => {
    const row = rows.find(model => model.accountId === account.id && model.credential.authRef === account.authRef);
    const cache = accountModelsCache(provider, account);
    if (!row || !cache || !account.enabled || account.modelDiscoveryError || provider.modelDiscoveryError
      || cache.fetchedAt !== row.discovery.fetchedAt) return false;
    const model = cache.models.find(item => {
      const candidate = cachedModelToLocal(item, provider);
      return candidate?.id === row.ref.modelId && candidate.upstreamModelId === row.upstreamModelId;
    });
    if (!model) return false;
    const local = cachedModelToLocal(model, provider);
    if (!local || routingTransportFingerprint({ endpoint: local.apiBaseUrl ?? (local.modelFormat === 'anthropic' ? local.baseUrl : local.completionsUrl),
      npm: local.npm, format: local.modelFormat, credentialSource: 'registry', providerId: provider.id, authType: provider.authType }) !== binding.identity.transportFingerprint) return false;
    return cachedSupportsRequest(model, binding, body);
  };
}
