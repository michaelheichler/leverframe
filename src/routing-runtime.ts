import { resolveProviderAccountAuth, resolveProviderAuth } from './env.js';
import { readClaudeCodeAuthMaterial, type ClaudeCodeCredentialReader } from './claude-code-credentials.js';
import type { FreshProviderCatalog } from './provider-catalog.js';
import type { RoutingConfig } from './model-routing.js';
import { buildRoutingCatalog, type CredentialObservation, type DiscoveryObservation } from './model-routing-catalog.js';
import { fetchAnthropicModels } from './registry/anthropic-models-fetch.js';
import { materializeNativeClaudeProvider } from './registry/import-build.js';
import type { ProviderRegistry } from './registry/types.js';
import type { PricingCacheFile } from './registry/pricing.js';
import { accountModelsCache } from './registry/account-cache.js';

export interface RoutingRuntimeInput {
  config: RoutingConfig;
  registry: ProviderRegistry;
  fresh: FreshProviderCatalog;
  pricing?: PricingCacheFile;
  readNativeAuth?: ClaudeCodeCredentialReader;
  listNativeModels?: typeof fetchAnthropicModels;
  resolveProvider?: typeof resolveProviderAuth;
  resolveAccount?: typeof resolveProviderAccountAuth;
  now?: () => number;
  includeNative?: boolean;
}

export async function buildRoutingRuntime(input: RoutingRuntimeInput) {
  if (!input.config.enabled) throw new Error('Routing is disabled.');
  if (!input.fresh.refresh) throw new Error('Fresh routing discovery evidence is unavailable.');
  const registry: ProviderRegistry = { ...input.registry, providers: input.registry.providers.slice() };
  const credentials: CredentialObservation[] = [];
  const discovery: DiscoveryObservation[] = [];
  const refs = [input.config.cheapFloor, input.config.cheapFallback, input.config.selector?.target,
    ...(input.config.selector?.fallbacks ?? []), ...(input.config.pool ?? []),
    ...(input.config.routerFallbacks ?? []), ...Object.values(input.config.categories ?? {}).flatMap(category =>
      [category.target, ...(category.alternatingTargets ?? []), ...(category.servingAlternatives ?? []), ...(category.fallbacks ?? [])])];
  const providerIds = new Set(refs.filter(ref => ref !== undefined).map(ref => ref.providerId));
  for (const provider of registry.providers) {
    if (!provider.enabled || provider.credentialSource === 'claude-code' || !providerIds.has(provider.id)) continue;
    const refresh = input.fresh.refresh.refreshed.find(item => item.id === provider.id);
    const live = !!refresh?.ok && !refresh.skipped && refresh.modelSource === 'live';
    if (provider.accounts?.length) {
      for (const account of provider.accounts.filter(item => item.enabled)) {
        const auth = await (input.resolveAccount ?? resolveProviderAccountAuth)(provider.id, account).catch(() => ({ apiKey: null }));
        credentials.push({ providerId: provider.id, accountId: account.id,
          kind: provider.authType === 'oauth' ? 'oauth' : provider.authType === 'none' ? 'none' : 'api_key',
          available: provider.authType === 'none' || !!auth.apiKey });
        const cache = accountModelsCache(provider, account);
        if (live && refresh?.accountResults?.some(item => item.accountId === account.id && item.ok) && cache) {
          discovery.push({ providerId: provider.id, accountId: account.id, status: 'live', cacheFetchedAt: cache.fetchedAt });
        }
      }
    } else {
      const auth = await (input.resolveProvider ?? resolveProviderAuth)(provider.id, provider.authRef).catch(() => ({ apiKey: null }));
      credentials.push({ providerId: provider.id, kind: provider.authType === 'oauth' ? 'oauth' : provider.authType === 'none' ? 'none' : 'api_key',
        available: provider.authType === 'none' || !!auth.apiKey });
      if (live && provider.modelsCache) discovery.push({ providerId: provider.id, status: 'live', cacheFetchedAt: provider.modelsCache.fetchedAt });
    }
  }
  if (input.includeNative || refs.some(ref => ref?.providerId === 'anthropic')) {
    await addNativeSnapshot(input, registry, credentials, discovery);
  }
  return buildRoutingCatalog({ registry, pricing: input.pricing, credentials, discovery, now: new Date((input.now ?? Date.now)()).toISOString() });
}

async function addNativeSnapshot(input: RoutingRuntimeInput, registry: ProviderRegistry,
  credentials: CredentialObservation[], discovery: DiscoveryObservation[]): Promise<void> {
  const auth = await (input.readNativeAuth ?? readClaudeCodeAuthMaterial)();
  if (!auth) return;
  const models = await (input.listNativeModels ?? fetchAnthropicModels)('https://api.anthropic.com',
    auth.kind === 'api_key' ? auth.token : '', auth.kind === 'oauth' ? { authorization: `Bearer ${auth.token}` } : undefined);
  if (models.error || !models.models.length) return;
  const previous = registry.providers.find(provider => provider.id === 'anthropic' && provider.credentialSource === 'claude-code');
  const harnessModels = previous?.modelsCache?.source === 'harness' ? previous.modelsCache.models : [];
  const merged = models.models.map(model => {
    const harness = harnessModels.find(item => item.upstreamModelId === model.upstreamModelId);
    return harness ? { ...harness, ...model, supportedReasoningEfforts: harness.supportedReasoningEfforts } : model;
  });
  const now = new Date((input.now ?? Date.now)()).toISOString();
  const native = materializeNativeClaudeProvider({ models: merged, source: 'account', credentialKind: auth.kind, now,
    billing: previous?.billing });
  registry.providers = [...registry.providers.filter(provider => provider.id !== 'anthropic'), native];
  credentials.push({ providerId: 'anthropic', kind: auth.kind, available: true });
  discovery.push({ providerId: 'anthropic', status: 'live', cacheFetchedAt: now });
}
