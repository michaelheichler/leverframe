import type { CapacityObservation } from './account-pool.js';

export function anthropicCapacity(headers: Headers, accountId: string, now: number): CapacityObservation[] {
  const windows = ['requests', 'input-tokens', 'output-tokens'].flatMap(unit => {
    const raw = headers.get(`anthropic-ratelimit-${unit}-remaining`);
    if (raw === null || !/^\d+$/.test(raw)) return [];
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) return [];
    const rawLimit = headers.get(`anthropic-ratelimit-${unit}-limit`);
    const parsedLimit = rawLimit && /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
    const limit = Number.isSafeInteger(parsedLimit) && parsedLimit > 0 && value <= parsedLimit ? parsedLimit : undefined;
    const reset = headers.get(`anthropic-ratelimit-${unit}-reset`);
    const parsedReset = reset === null ? NaN : Date.parse(reset);
    return [{ unit, value, limit, resetAt: Number.isFinite(parsedReset) ? parsedReset : undefined }];
  });
  return windows.map(window => ({
    accountId, scope: { kind: 'pool' }, source: 'anthropic:headers', observedAt: now,
    dimension: `anthropic:${window.unit}`,
    status: window.value === 0 ? 'rate_limited' : 'healthy',
    remaining: { value: window.value, unit: `anthropic:${window.unit}`, ...(window.limit === undefined ? {} : { limit: window.limit }) },
    ...(window.resetAt === undefined ? {} : { resetAt: window.resetAt }),
  }));
}
