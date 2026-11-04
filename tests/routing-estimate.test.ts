import { describe, expect, it } from 'vitest';
import { estimateWorkload } from '../src/routing-estimate.js';
import type { CostSnapshot } from '../src/model-routing-catalog.js';

const snapshot = (overrides: Record<string, unknown> = {}) => ({ kind: 'known', currency: 'USD', unit: 'per-million-tokens',
  input: 1, output: 1, cacheRead: 1, cacheWrite: 1, substituted: false, freshness: 'current', ...overrides }) as CostSnapshot;

describe('routing workload estimates', () => {
  it('prices cache writes with the matching retention period', () => {
    const estimate = estimateWorkload(snapshot({ cacheWrites: [{ ttlSeconds: 3600, rate: 3 }] }),
      { input: 100, output: 10, cacheRead: 5, cacheWrite: 2, cacheWrites: [{ ttlSeconds: 3600, tokens: 4 }] });
    expect(estimate).toMatchObject({ kind: 'known', amount: 129 / 1_000_000 });
  });

  it('keeps a workload unknown when its cache retention rate is unavailable', () => {
    const estimate = estimateWorkload(snapshot(), { input: 100, output: 10, cacheWrites: [{ ttlSeconds: 3600, tokens: 4 }] });
    expect(estimate.kind).toBe('unknown');
  });

  it('keeps an overflowed finite workload unknown', () => {
    const estimate = estimateWorkload(snapshot({ input: Number.MAX_VALUE }), { input: Number.MAX_VALUE, output: 0 });
    expect(estimate.kind).toBe('unknown');
  });

  it.each([
    { input: 99, expected: { kind: 'known', amount: 99 / 1_000_000 } },
    { input: 100, expected: { kind: 'unknown' } },
    { input: 101, expected: { kind: 'known', amount: 202 / 1_000_000 } },
  ])('estimates context-tier cost around an ambiguous legacy threshold $input', ({ input, expected }) => {
    const estimate = estimateWorkload(snapshot({ tiers: [{ condition: { type: 'context', size: 100 }, input: 2 }] }), { input, output: 0 });
    expect(estimate).toMatchObject(expected);
  });
});
