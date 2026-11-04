import { cachedModelToLocal } from './registry/materialize.js';
import { routingTransportFingerprint } from './routing-transport-identity.js';
import { ANTHROPIC_API_ORIGIN } from './constants.js';
import type { ModelRef } from './model-routing.js';
import type { PricingCacheFile } from './registry/pricing.js';
import type { BillingMetadata, CacheWriteRate, CachedModel, ModelPricingTier, ProviderRegistry, RegistryProvider } from './registry/types.js';
import { routingCost } from './model-routing-cost.js';
import { buildProviderCapabilities, type ProviderCapabilityMatrix } from './provider-capabilities.js';
import { accountModelsCache } from './registry/account-cache.js';

export interface CredentialObservation {
  providerId: string;
  accountId?: string;
  kind: 'oauth' | 'api_key' | 'none' | 'unknown';
  available: boolean;
}

export interface CapacityObservation {
  providerId: string;
  accountId?: string;
  available: boolean;
  observedAt: string;
}

export interface CatalogSnapshotInput {
  registry: ProviderRegistry;
  pricing?: PricingCacheFile;
  credentials?: CredentialObservation[];
  capacity?: CapacityObservation[];
  discovery?: DiscoveryObservation[];
  now: string;
}

export interface DiscoveryObservation {
  providerId: string;
  accountId?: string;
  status: 'live' | 'cache' | 'seed' | 'fallback' | 'failed';
  cacheFetchedAt: string;
}

export interface CostSnapshot {
  kind: 'known' | 'unknown';
  currency: 'USD';
  unit: 'per-million-tokens';
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrites?: CacheWriteRate[];
  tiers?: ModelPricingTier[];
  source?: string;
  observedAt?: string;
  platform?: string;
  requestedPlatform?: string;
  tier?: string;
  usageMultiplier?: number;
  usageMultiplierApplies?: boolean;
  substituted: boolean;
  freshness: 'current' | 'stale' | 'unknown';
}

export interface RoutingCatalogModel {
  ref: ModelRef;
  templateId?: string;
  name?: string;
  family?: string;
  upstreamModelId?: string;
  transportFingerprint?: string;
  accountId?: string;
  credential: { source: 'claude-code' | 'registry'; authRef: string; kind: CredentialObservation['kind']; available: boolean };
  billing: BillingMetadata | { kind: 'unknown'; source?: string; observedAt?: string };
  discovery: { source: 'harness' | 'account' | 'api' | 'registry'; state: 'current' | 'stale' | 'failed' | 'unknown'; confirmed: boolean; fetchedAt: string };
  capabilities: ProviderCapabilityMatrix;
  confirmedCapabilities: Array<'images' | 'reasoning' | 'tools' | 'promptCache' | 'websocket'>;
  supportedReasoningEfforts?: string[];
  maxOutputTokens?: number;
  contextWindow?: number;
  contextWindowConfirmed: boolean;
  capacity?: CapacityObservation;
  subscriptionQuota?: { remainingFraction?: number; resetTime?: string; source: string; observedAt: string;
    freshness: 'unknown' };
  estimate: CostSnapshot;
}

export interface RoutingCatalogSnapshot {
  generatedAt: string;
  models: RoutingCatalogModel[];
}

function materializeModel(input: CatalogSnapshotInput, provider: RegistryProvider, model: CachedModel,
  cache: NonNullable<RegistryProvider['modelsCache']>, accountId?: string, authRef = provider.authRef,
  billing = provider.billing, accountError?: string): RoutingCatalogModel {
  const credential = input.credentials?.find(item => item.providerId === provider.id && item.accountId === accountId);
  const capacity = input.capacity?.find(item => item.providerId === provider.id && item.accountId === accountId);
  const observation = input.discovery?.find(item => item.providerId === provider.id && item.accountId === accountId);
  const failed = !!provider.modelDiscoveryError || !!accountError || observation?.status === 'failed';
  const native = provider.credentialSource === 'claude-code';
  const local = native ? undefined : cachedModelToLocal(model, provider);
  const transportFingerprint = routingTransportFingerprint(native
    ? { endpoint: ANTHROPIC_API_ORIGIN, format: 'anthropic', credentialSource: 'claude-code' }
    : { endpoint: local?.apiBaseUrl ?? (local?.modelFormat === 'anthropic' ? local.baseUrl : local?.completionsUrl), npm: local?.npm, format: local?.modelFormat ?? 'openai', credentialSource: 'registry', providerId: provider.id, authType: provider.authType });
  const state = failed ? 'failed' : !observation || observation.status === 'seed' || observation.status === 'fallback' ? 'unknown'
    : observation.status === 'live' && observation.cacheFetchedAt === cache.fetchedAt ? 'current' : 'stale';
  const fraction = model.subscriptionQuota?.remainingFraction;
  const remainingFraction = typeof fraction === 'number' && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1
    ? fraction : undefined;
  const reset = model.subscriptionQuota?.resetTime;
  const resetTime = typeof reset === 'string' && Number.isFinite(Date.parse(reset)) ? new Date(reset).toISOString() : undefined;
  return {
    ref: { providerId: provider.id, modelId: local?.id ?? model.id },
    templateId: provider.templateId,
    name: model.name,
    family: model.family,
    upstreamModelId: local?.upstreamModelId ?? model.upstreamModelId,
    transportFingerprint,
    ...(accountId ? { accountId } : {}),
    credential: { source: provider.credentialSource === 'claude-code' ? 'claude-code' : 'registry', authRef,
      kind: credential?.kind ?? 'unknown', available: credential?.available ?? false },
    billing: billing ? { ...billing } : { kind: 'unknown' },
    discovery: { source: cache.source ?? (observation ? 'api' : 'registry'), state,
      confirmed: state === 'current', fetchedAt: cache.fetchedAt },
    capabilities: buildProviderCapabilities({ providerId: provider.id, reasoning: model.reasoning,
      images: model.vision, tools: model.supportedParameters?.includes('tools') ? true : undefined,
      promptCache: model.supportsPromptCacheBreakpoints === true ? true : undefined,
      websocket: model.preferWebSockets === true ? true : undefined }),
    confirmedCapabilities: [
      ...(model.vision === undefined ? [] : ['images' as const]),
      ...(model.reasoning === undefined ? [] : ['reasoning' as const]),
      ...(model.supportedParameters?.includes('tools') ? ['tools' as const] : []),
      ...(model.supportsPromptCacheBreakpoints === true ? ['promptCache' as const] : []),
      ...(model.preferWebSockets === true ? ['websocket' as const] : []),
    ],
    supportedReasoningEfforts: model.supportedReasoningEfforts?.slice(),
    ...(Number.isSafeInteger(model.outputTokenLimit) && model.outputTokenLimit! > 0 ? { maxOutputTokens: model.outputTokenLimit } : {}),
    contextWindow: model.contextWindow,
    contextWindowConfirmed: typeof model.contextWindow === 'number' && model.contextWindow > 0 && model.contextWindowUnconfirmed !== true,
    ...(capacity ? { capacity: { ...capacity } } : {}),
    ...(remainingFraction !== undefined || resetTime !== undefined ? { subscriptionQuota: {
      remainingFraction, resetTime, source: cache.source ?? 'registry', observedAt: cache.fetchedAt, freshness: 'unknown' as const,
    } } : {}),
    estimate: routingCost(provider, model, input.pricing),
  };
}

export function buildRoutingCatalog(input: CatalogSnapshotInput): RoutingCatalogSnapshot {
  const models: RoutingCatalogModel[] = [];
  for (const provider of input.registry.providers) {
    if (!provider.enabled) continue;
    const caches = provider.accounts?.length
      ? provider.accounts.filter(account => account.enabled)
        .flatMap(account => {
          const cache = accountModelsCache(provider, account);
          return cache ? [{ cache, accountId: account.id, authRef: account.authRef, billing: account.billing ?? provider.billing,
            accountError: account.modelDiscoveryError }] : [];
        })
      : provider.modelsCache ? [{ cache: provider.modelsCache, accountId: undefined, authRef: provider.authRef,
        billing: provider.billing, accountError: undefined }] : [];
    for (const { cache, accountId, authRef, billing, accountError } of caches) {
      if (provider.id === 'anthropic' && (provider.credentialSource !== 'claude-code' || !cache.source)) continue;
      for (const model of cache.models) {
        if (!model.id?.trim() || !model.upstreamModelId?.trim()) continue;
        models.push(materializeModel(input, provider, model, cache, accountId, authRef, billing, accountError));
      }
    }
  }
  return { generatedAt: input.now, models };
}
