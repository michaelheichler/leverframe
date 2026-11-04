import type { CacheWriteRate, ModelPricingTier } from './registry/types.js';

interface Validation<T> {
  value: T | undefined;
  valid: boolean;
}

export function validRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateCacheWrites(raw: unknown): Validation<CacheWriteRate[]> {
  if (raw === undefined) return { value: undefined, valid: true };
  if (!Array.isArray(raw)) return { value: undefined, valid: false };
  const value: CacheWriteRate[] = [];
  let valid = true;
  for (const item of raw) {
    if (!record(item) || !positiveInteger(item.ttlSeconds) || !validRate(item.rate)) {
      valid = false;
      continue;
    }
    value.push({ ttlSeconds: item.ttlSeconds, rate: item.rate });
  }
  return { value, valid };
}

function validateTier(raw: unknown): Validation<ModelPricingTier> {
  if (!record(raw)) return { value: undefined, valid: false };
  const value: ModelPricingTier = {};
  if (raw.label !== undefined) {
    if (typeof raw.label !== 'string') return { value: undefined, valid: false };
    value.label = raw.label;
  }
  if (raw.condition !== undefined) {
    if (!record(raw.condition) || raw.condition.type !== 'context' || !positiveInteger(raw.condition.size)) {
      return { value: undefined, valid: false };
    }
    value.condition = { type: 'context', size: raw.condition.size };
  }
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    if (raw[key] === undefined) continue;
    if (!validRate(raw[key])) return { value: undefined, valid: false };
    value[key] = raw[key];
  }
  const writes = validateCacheWrites(raw.cacheWrites);
  if (writes.value !== undefined) value.cacheWrites = writes.value;
  if (!writes.valid && !('input' in value || 'output' in value || 'cacheRead' in value || 'cacheWrite' in value)
    && !writes.value?.length) return { value: undefined, valid: false };
  return { value, valid: writes.valid };
}

export function validateTiers(raw: unknown): Validation<ModelPricingTier[]> {
  if (raw === undefined) return { value: undefined, valid: true };
  if (!Array.isArray(raw)) return { value: undefined, valid: false };
  const value: ModelPricingTier[] = [];
  let valid = true;
  for (const item of raw) {
    const tier = validateTier(item);
    if (!tier.valid) valid = false;
    if (tier.value) value.push(tier.value);
  }
  return { value, valid };
}
