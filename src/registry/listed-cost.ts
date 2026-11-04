import type { CachedModel } from './types.js';

export interface ListedCost {
  text?: {
    input?: { price?: unknown; cache?: { read?: unknown; write?: unknown } };
    output?: { price?: unknown };
  };
  multipliers?: Array<{ factor?: unknown }>;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseListedCost(listed: ListedCost | undefined): CachedModel['cost'] | undefined {
  const input = finiteNumber(listed?.text?.input?.price);
  const output = finiteNumber(listed?.text?.output?.price);
  if (input === undefined && output === undefined) return undefined;
  const cacheRead = finiteNumber(listed?.text?.input?.cache?.read);
  const cacheWrite = finiteNumber(listed?.text?.input?.cache?.write);
  return {
    input: input ?? 0,
    output: output ?? 0,
    ...(cacheRead === undefined ? {} : { cache_read: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cache_write: cacheWrite }),
  };
}

export function peakCostMultiplier(listed: ListedCost | undefined): number | undefined {
  const factors = (Array.isArray(listed?.multipliers) ? listed.multipliers : [])
    .map(multiplier => finiteNumber(multiplier?.factor))
    .filter((factor): factor is number => factor !== undefined && factor > 1);
  return factors.length > 0 ? Math.max(...factors) : undefined;
}
