import { buildRoutingCatalog, type RoutingCatalogModel, type RoutingCatalogSnapshot } from './model-routing-catalog.js';
import type { ModelRef, RoutingConfig } from './model-routing.js';
import { decideRouting, eligible, routingCategoryRequirements, sameRef } from './routing-policy.js';
import { estimateWorkload } from './routing-estimate.js';
import { loadRegistry } from './registry/io.js';
import { loadPricingCache } from './registry/pricing.js';

export function cachedSwitchyardCatalog(): RoutingCatalogSnapshot {
  const registry = loadRegistry();
  const credentials = registry.providers.flatMap(provider => {
    const kind = provider.credentialSource === 'claude-code' ? 'unknown' as const
      : provider.authType === 'oauth' ? 'oauth' as const : provider.authType === 'none' ? 'none' as const
        : provider.authType === 'api' ? 'api_key' as const : 'unknown' as const;
    return provider.accounts?.length
      ? provider.accounts.filter(account => account.enabled).map(account => ({ providerId: provider.id, accountId: account.id, kind, available: false }))
      : [{ providerId: provider.id, kind, available: false }];
  });
  return buildRoutingCatalog({ registry, pricing: loadPricingCache(), credentials, now: new Date().toISOString() });
}

export function orderedSwitchyardModels(catalog: RoutingCatalogSnapshot): RoutingCatalogModel[] {
  const cost = (model: RoutingCatalogModel) => estimateWorkload(model.estimate, { input: 1_000_000, output: 1_000_000 });
  return [...catalog.models].sort((a, b) => {
    const left = cost(a);
    const right = cost(b);
    return Number(left.kind !== 'known') - Number(right.kind !== 'known')
      || (left.amount ?? 0) - (right.amount ?? 0)
      || a.ref.providerId.localeCompare(b.ref.providerId) || a.ref.modelId.localeCompare(b.ref.modelId)
      || (a.accountId ?? '').localeCompare(b.accountId ?? '');
  });
}

export function switchyardPoolLines(): string[] {
  return loadRegistry().providers.map(provider => {
    const accounts = provider.accounts?.map(account => `${account.id} (${account.enabled ? 'enabled' : 'disabled'}, served ${account.modelsCache?.models.map(model => model.upstreamModelId).join(', ') || 'unknown'})`).join('; ')
      || 'default account';
    return `Pool ${provider.id} (${provider.enabled ? 'enabled' : 'disabled'}), pinned account ${provider.pinnedAccountId ?? 'none'}, accounts ${accounts}.`;
  });
}

export function explicitSwitchyardTargets(config: RoutingConfig): { path: string; ref: ModelRef; effort?: string }[] {
  const refs: { path: string; ref: ModelRef; effort?: string }[] = [];
  const add = (path: string, ref: ModelRef | undefined, effort?: string) => { if (ref) refs.push({ path, ref, effort }); };
  add('routing.cheapFloor', config.cheapFloor);
  add('routing.cheapFallback', config.cheapFallback);
  config.routerFallbacks?.forEach((ref, i) => add(`routing.routerFallbacks.${i}`, ref));
  config.pool?.forEach((ref, i) => add(`routing.pool.${i}`, ref));
  add('routing.selector.target', config.selector?.target);
  config.selector?.fallbacks?.forEach((ref, i) => add(`routing.selector.fallbacks.${i}`, ref));
  for (const [name, category] of Object.entries(config.categories ?? {})) {
    const prefix = `routing.categories.${name}`;
    add(`${prefix}.target`, category.target, category.effort);
    category.alternatingTargets?.forEach((ref, i) => add(`${prefix}.alternatingTargets.${i}`, ref, ref.effort));
    category.servingAlternatives?.forEach((ref, i) => add(`${prefix}.servingAlternatives.${i}`, ref, category.effort));
    category.fallbacks?.forEach((ref, i) => add(`${prefix}.fallbacks.${i}`, ref, ref.effort ?? category.effort));
  }
  return refs;
}

export function switchyardCategoryWarnings(config: RoutingConfig, catalog: RoutingCatalogSnapshot): string[] {
  const warnings: string[] = [];
  for (const [name, category] of Object.entries(config.categories ?? {})) {
    const arms = category.alternatingTargets ? [0, 1] as const : [undefined] as const;
    for (const arm of arms) {
      try {
        decideRouting({ config, catalog, role: 'specialist', category: name, arm, requirements: routingCategoryRequirements(config, name), workload: {} });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code !== 'routing_ineligible_target' && code !== 'routing_no_eligible_target') throw error;
        warnings.push(`routing.categories.${name}${arm === undefined ? '' : ` arm ${arm + 1}`} cannot currently start under routing policy. Check credentials, discovery and effort.`);
      }
    }
  }
  return warnings;
}

export function validateSwitchyardTargets(config: RoutingConfig, catalog: RoutingCatalogSnapshot): string[] {
  const warnings: string[] = [];
  for (const { path, ref, effort } of explicitSwitchyardTargets(config)) {
    const rows = catalog.models.filter(model => sameRef(model.ref, ref));
    if (!rows.length) throw new Error(`${path}: ${ref.providerId}/${ref.modelId} is unresolved. Run provider discovery and setup.`);
    if (effort && !rows.some(model => model.supportedReasoningEfforts?.includes(effort))) {
      throw new Error(`${path}: ${ref.providerId}/${ref.modelId} does not confirm effort ${effort}. Refresh provider discovery.`);
    }
    if (!rows.some(model => eligible(model, effort, undefined))) {
      warnings.push(`${path}: ${ref.providerId}/${ref.modelId} is currently unavailable. Check credentials, discovery, capacity and authorized fallbacks.`);
    }
  }
  return [...warnings, ...switchyardCategoryWarnings(config, catalog)];
}

export function switchyardModelLine(model: RoutingCatalogModel, observed = false): string {
  const rate = (value: number | undefined) => value === undefined ? 'unknown' : String(value);
  const price = model.estimate.kind === 'known'
    ? `input ${rate(model.estimate.input)}, output ${rate(model.estimate.output)}, cache read ${rate(model.estimate.cacheRead)}, cache write ${rate(model.estimate.cacheWrite)} USD per million tokens`
    : 'price unknown';
  const estimate = estimateWorkload(model.estimate, { input: 1_000_000, output: 1_000_000 });
  const availability = observed ? (model.credential.available ? 'available' : 'unavailable') : 'unverified';
  const quota = model.subscriptionQuota
    ? `quota evidence cached (remaining fraction ${model.subscriptionQuota.remainingFraction ?? 'unknown'}, reset ${model.subscriptionQuota.resetTime ?? 'unknown'}, source ${model.subscriptionQuota.source}, observed ${model.subscriptionQuota.observedAt}, freshness unknown)`
    : 'quota evidence unknown';
  return `${model.ref.providerId}/${model.ref.modelId} | account ${model.accountId ?? 'default'} | served ${model.upstreamModelId ?? 'unknown'} | auth ${model.credential.kind} (availability ${availability}) | billing ${model.billing.kind} (${model.billing.source ?? 'unknown'}, ${model.billing.observedAt ?? 'unknown'}) | ${quota} | discovery ${model.discovery.state} (${model.discovery.fetchedAt}) | ${price} | API-equivalent example ${estimate.amount === undefined ? 'unknown' : `$${estimate.amount}`} | source ${model.estimate.source ?? 'unknown'}, observed ${model.estimate.observedAt ?? 'unknown'}, platform ${model.estimate.platform ?? 'unknown'}, freshness ${model.estimate.freshness} | subscription consumption unknown`;
}
