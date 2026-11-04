import { buildPricingIndex, normalizeModelIdCandidates, pickPricingRow, pricingPlatformForProvider } from './registry/pricing.js';
import type { PricingCacheFile, PricingTierRow } from './registry/pricing.js';
import type { CachedModel, RegistryProvider } from './registry/types.js';
import type { CostSnapshot } from './model-routing-catalog.js';
import { validRate, validateCacheWrites, validateTiers } from './model-routing-price-validation.js';

function sharedRows(cache: PricingCacheFile, model: CachedModel): PricingTierRow[] {
  const index = buildPricingIndex(cache);
  for (const id of [model.id, model.upstreamModelId]) {
    for (const candidate of normalizeModelIdCandidates(id)) {
      const rows = index.byId.get(candidate)?.pricing;
      if (!rows?.length) continue;
      return rows;
    }
  }
  return [];
}

export function routingCost(provider: RegistryProvider, model: CachedModel, cache?: PricingCacheFile): CostSnapshot {
  const requestedPlatform = pricingPlatformForProvider(provider.templateId, provider.id);
  const rows = !model.pricing && cache ? sharedRows(cache, model) : [];
  const row = pickPricingRow(rows, requestedPlatform) ?? undefined;
  const pricing = model.pricing ?? (row ? {
    input: row.input_per_1m_tokens, output: row.output_per_1m_tokens,
    cacheRead: row.cached_input_per_1m_tokens, cacheWrite: undefined,
    source: 'shared-pricing-cache', observedAt: cache?.generated_at,
  } : undefined);
  const input = validRate(pricing?.input) ? pricing?.input : undefined;
  const output = validRate(pricing?.output) ? pricing?.output : undefined;
  const writes = validateCacheWrites(model.pricing?.cacheWrites);
  const matchingRows = row ? rows.filter(candidate => candidate.platform === row.platform && (!candidate.modality || candidate.modality === 'text')) : [];
  const sharedTiers = matchingRows.length === 1 && matchingRows[0] === row && (!row?.tier || row.tier === 'standard') ? undefined
    : row ? matchingRows
    .map(candidate => ({ label: candidate.tier, input: candidate.input_per_1m_tokens,
      output: candidate.output_per_1m_tokens, cacheRead: candidate.cached_input_per_1m_tokens })) : undefined;
  const tiers = validateTiers(model.pricing ? model.pricing.tiers : sharedTiers);
  const cacheRatesValid = (pricing?.cacheRead === undefined || validRate(pricing.cacheRead))
    && (pricing?.cacheWrite === undefined || validRate(pricing.cacheWrite));
  const substituted = !!(row?.platform && requestedPlatform && row.platform !== requestedPlatform);
  const platformConfirmed = !row || (!!requestedPlatform && row.platform === requestedPlatform);
  return {
    kind: input !== undefined && output !== undefined && platformConfirmed && cacheRatesValid
      && writes.valid && tiers.valid && model.pricing?.invalidTiers !== true ? 'known' : 'unknown',
    currency: 'USD', unit: 'per-million-tokens', input, output,
    cacheRead: validRate(pricing?.cacheRead) ? pricing?.cacheRead : undefined,
    cacheWrite: validRate(pricing?.cacheWrite) ? pricing?.cacheWrite : undefined,
    cacheWrites: writes.value,
    tiers: tiers.value,
    source: pricing?.source, observedAt: pricing?.observedAt,
    platform: row?.platform, requestedPlatform,
    tier: row?.tier, usageMultiplier: model.usageMultiplier, usageMultiplierApplies: model.usageMultiplierApplies,
    substituted,
    freshness: 'unknown',
  };
}
