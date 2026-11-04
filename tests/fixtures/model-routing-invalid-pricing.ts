const validCacheWrite = { ttlSeconds: 300, rate: 1.25 };
const validTierCacheWrite = { ttlSeconds: 300, rate: 2.5 };
const validTier = {
  condition: { type: 'context', size: 256000 },
  input: 3,
  output: 4,
  cacheRead: 0.5,
  cacheWrite: 0.7,
  cacheWrites: [validTierCacheWrite],
};

function pricing(overrides: Record<string, unknown> = {}) {
  return {
    input: 1,
    output: 2,
    cacheRead: 0.2,
    cacheWrite: 0.4,
    cacheWrites: [validCacheWrite],
    tiers: [validTier],
    source: 'synthetic-runtime-validation',
    ...overrides,
  };
}

function expected(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'unknown',
    input: 1,
    output: 2,
    cacheRead: 0.2,
    cacheWrite: 0.4,
    cacheWrites: [validCacheWrite],
    tiers: [validTier],
    ...overrides,
  };
}

export const invalidNestedRateCases = [
  {
    caseName: 'negative flat cache-read rate',
    pricing: pricing({ cacheRead: -0.1 }),
    expected: expected({ cacheRead: undefined }),
  },
  {
    caseName: 'non-finite flat cache-write rate',
    pricing: pricing({ cacheWrite: Number.POSITIVE_INFINITY }),
    expected: expected({ cacheWrite: undefined }),
  },
  {
    caseName: 'negative tier input rate',
    pricing: pricing({ tiers: [validTier, { condition: { type: 'context', size: 512000 }, input: -1 }] }),
    expected: expected({ tiers: [validTier] }),
  },
  {
    caseName: 'non-finite tier output rate',
    pricing: pricing({ tiers: [validTier, { condition: { type: 'context', size: 512000 }, output: Number.NaN }] }),
    expected: expected({ tiers: [validTier] }),
  },
  {
    caseName: 'malformed tier cache-read rate',
    pricing: pricing({ tiers: [validTier, { condition: { type: 'context', size: 512000 }, cacheRead: '0.5' }] }),
    expected: expected({ tiers: [validTier] }),
  },
  {
    caseName: 'null tier cache-write rate',
    pricing: pricing({ tiers: [validTier, { condition: { type: 'context', size: 512000 }, cacheWrite: null }] }),
    expected: expected({ tiers: [validTier] }),
  },
  {
    caseName: 'malformed nested cache-write rate',
    pricing: pricing({
      tiers: [validTier, {
        condition: { type: 'context', size: 512000 },
        cacheWrites: [{ ttlSeconds: 300, rate: null }],
      }],
    }),
    expected: expected({ tiers: [validTier] }),
  },
  {
    caseName: 'malformed cache-write collection',
    pricing: pricing({ cacheWrites: 'not a band list' }),
    expected: expected({ cacheWrites: undefined }),
  },
  {
    caseName: 'malformed tier collection',
    pricing: pricing({ tiers: 'not a tier list' }),
    expected: expected({ tiers: undefined }),
  },
  {
    caseName: 'malformed tier entry',
    pricing: pricing({ tiers: [validTier, null] }),
    expected: expected({ tiers: [validTier] }),
  },
  {
    caseName: 'non-finite cache-write band rate',
    pricing: pricing({ cacheWrites: [validCacheWrite, { ttlSeconds: 600, rate: Number.NEGATIVE_INFINITY }] }),
    expected: expected(),
  },
];

function withInvalidTtl(ttlSeconds: unknown) {
  return pricing({
    cacheWrites: [validCacheWrite, { ttlSeconds, rate: 1.75 }],
    tiers: [{ ...validTier, cacheWrites: [validTierCacheWrite, { ttlSeconds, rate: 2.75 }] }],
  });
}

function withOnlyInvalidTtl(ttlSeconds: unknown) {
  return pricing({
    cacheWrites: [{ ttlSeconds, rate: 1.75 }],
    tiers: [{ ...validTier, cacheWrites: [{ ttlSeconds, rate: 2.75 }] }],
  });
}

export const invalidTtlCases = [
  { caseName: 'zero TTL', pricing: withInvalidTtl(0), expected: expected() },
  { caseName: 'negative TTL', pricing: withInvalidTtl(-60), expected: expected() },
  { caseName: 'fractional TTL', pricing: withInvalidTtl(1.5), expected: expected() },
  { caseName: 'non-finite TTL', pricing: withInvalidTtl(Number.NaN), expected: expected() },
  { caseName: 'infinite TTL', pricing: withInvalidTtl(Number.POSITIVE_INFINITY), expected: expected() },
  { caseName: 'string TTL', pricing: withInvalidTtl('300'), expected: expected() },
  { caseName: 'null TTL', pricing: withInvalidTtl(null), expected: expected() },
  {
    caseName: 'all TTL bands invalid', pricing: withOnlyInvalidTtl(0),
    expected: expected({ cacheWrites: [], tiers: [{ ...validTier, cacheWrites: [] }] }),
  },
  { caseName: 'unsafe integer TTL', pricing: withInvalidTtl(Number.MAX_SAFE_INTEGER + 1), expected: expected() },
];

function withInvalidCondition(caseName: string, condition: unknown) {
  return {
    caseName,
    pricing: pricing({ tiers: [validTier, { condition, input: 5, output: 6 }] }),
    expected: expected({ tiers: [validTier] }),
  };
}

export const invalidContextTierCases = [
  withInvalidCondition('zero context size', { type: 'context', size: 0 }),
  withInvalidCondition('negative context size', { type: 'context', size: -1 }),
  withInvalidCondition('fractional context size', { type: 'context', size: 1.5 }),
  withInvalidCondition('non-finite context size', { type: 'context', size: Number.NaN }),
  withInvalidCondition('infinite context size', { type: 'context', size: Number.POSITIVE_INFINITY }),
  withInvalidCondition('string context size', { type: 'context', size: '256000' }),
  withInvalidCondition('null context size', { type: 'context', size: null }),
  withInvalidCondition('unsupported context condition', { type: 'tokens', size: 256000 }),
  withInvalidCondition('missing context size', { type: 'context' }),
  withInvalidCondition('null condition', null),
  withInvalidCondition('malformed condition', 'context'),
  {
    caseName: 'all context tiers invalid',
    pricing: pricing({ tiers: [{ condition: { type: 'context', size: 0 }, input: 5, output: 6 }] }),
    expected: expected({ tiers: [] }),
  },
  withInvalidCondition('unsafe context size', { type: 'context', size: Number.MAX_SAFE_INTEGER + 1 }),
];
