import { expect, it, vi } from 'vitest';
import type { ProviderTemplate } from '../src/provider-templates.js';
import { buildRoutingCatalog, type CostSnapshot } from '../src/model-routing-catalog.js';
import { estimateWorkload } from '../src/routing-estimate.js';
import type { PricingCacheFile } from '../src/registry/pricing.js';
import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';
import type { CachedModel } from '../src/registry/types.js';
import {
  cachedModel,
  input,
  modelsDevTierFixture,
  multiTierPricing,
  observation,
  provider,
  unverifiablePlatformPricing,
} from './model-routing-fixtures.js';
import {
  invalidContextTierCases,
  invalidNestedRateCases,
  invalidTtlCases,
} from './fixtures/model-routing-invalid-pricing.js';

function estimateForRawPricing(pricingData: unknown) {
  const model = { ...cachedModel('runtime-validation-model'), pricing: pricingData as CachedModel['pricing'] };
  const supplied = provider({
    id: 'runtime-validation-provider',
    templateId: 'custom',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [model] },
  });

  return buildRoutingCatalog(input([supplied])).models[0]?.estimate;
}

function observedPricing(estimate: CostSnapshot | undefined) {
  return {
    kind: estimate?.kind,
    input: estimate?.input,
    output: estimate?.output,
    cacheRead: estimate?.cacheRead,
    cacheWrite: estimate?.cacheWrite,
    cacheWrites: estimate?.cacheWrites,
    tiers: estimate?.tiers,
  };
}

it('marks an estimate unknown when the request uses a component without a known rate', () => {
  const incomplete = provider({
    id: 'anthropic-api',
    templateId: 'anthropic-api',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel('routing-fixture-incomplete')] },
  });

  const snapshot = buildRoutingCatalog(input([incomplete], { credentials: [observation(incomplete.id)] }));

  expect(snapshot.models.find(model => model.ref.modelId === 'routing-fixture-incomplete')?.estimate.kind).toBe('unknown');
});

it('retains the shared cache-read rate in the cost snapshot', () => {
  const cached = provider({
    id: 'anthropic-api',
    templateId: 'anthropic-api',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel('routing-fixture-cache')] },
  });

  const snapshot = buildRoutingCatalog(input([cached], { credentials: [observation(cached.id)] }));

  expect(snapshot.models.find(model => model.ref.modelId === 'routing-fixture-cache')?.estimate.cacheRead).toBe(0.2);
});

it('retains the complete Models.dev context tier schedule through catalog pricing', async () => {
  const template = {
    id: 'synthetic-provider', name: 'Synthetic Provider', authType: 'api',
    npm: '@ai-sdk/openai-compatible', defaultBaseUrl: 'https://api.synthetic.example/v1',
    modelSource: 'api-list', modelsDevProviderId: 'synthetic-provider', supported: true,
  } satisfies ProviderTemplate;
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => JSON.stringify({ data: [{ id: 'tiered-fixture-model', name: 'Tiered Fixture Model' }] }),
    } as Response)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => modelsDevTierFixture } as Response));

  try {
    const fetched = await fetchTemplateModels(template, 'synthetic-key');
    const tiered = provider({
      id: template.id,
      templateId: template.id,
      modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: fetched.models },
    });
    const snapshot = buildRoutingCatalog(input([tiered]));

    expect(snapshot.models[0]).toMatchObject({
      estimate: {
        tiers: [
          { condition: { type: 'context', size: 256000 }, input: 3, output: 4, cacheRead: 0.5, cacheWrite: 0.7 },
          { condition: { type: 'context', size: 512000 }, input: 5, output: 6, cacheRead: 0.8, cacheWrite: 0.9 },
        ],
      },
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it('marks Models.dev pricing unknown when it drops a malformed context tier', async () => {
  const template = {
    id: 'synthetic-provider', name: 'Synthetic Provider', authType: 'api',
    npm: '@ai-sdk/openai-compatible', defaultBaseUrl: 'https://api.synthetic.example/v1',
    modelSource: 'api-list', modelsDevProviderId: 'synthetic-provider', supported: true,
  } satisfies ProviderTemplate;
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => JSON.stringify({ data: [{ id: 'tiered-fixture-model', name: 'Tiered Fixture Model' }] }),
    } as Response)
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => modelsDevTierFixture } as Response));

  try {
    const fetched = await fetchTemplateModels(template, 'synthetic-key');
    const tiered = provider({
      id: template.id,
      templateId: template.id,
      modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: fetched.models },
    });
    const snapshot = buildRoutingCatalog(input([tiered]));

    expect(snapshot.models[0]?.estimate).toMatchObject({
      kind: 'unknown',
      tiers: [
        { condition: { type: 'context', size: 256000 }, input: 3, output: 4 },
        { condition: { type: 'context', size: 512000 }, input: 5, output: 6 },
      ],
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it('preserves cache write rates for each supplied TTL band', () => {
  const cacheWrites = [{ ttlSeconds: 300, rate: 1.25 }, { ttlSeconds: 3600, rate: 2 }];
  const tiers = [{
    condition: { type: 'context' as const, size: 256000 },
    cacheWrites: [{ ttlSeconds: 300, rate: 2.5 }],
  }];
  const modelWithCacheWriteBands = {
    ...cachedModel('ttl-cache-write-model'),
    pricing: {
      input: 1, output: 2, source: 'synthetic-account', observedAt: '2026-10-01T00:00:00.000Z',
      cacheWrites, tiers,
    },
  };
  const supplied = provider({
    id: 'ttl-pricing-provider',
    templateId: 'custom',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [modelWithCacheWriteBands] },
  });

  const snapshot = buildRoutingCatalog(input([supplied]));

  expect(snapshot.models[0]?.estimate).toMatchObject({ cacheWrites, tiers });
});

it('retains matching platform pricing tiers and excludes other platform rows', () => {
  const tiered = provider({
    id: 'anthropic-api',
    templateId: 'anthropic-api',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel('multi-tier-fixture')] },
  });

  const snapshot = buildRoutingCatalog(input([tiered], { pricing: multiTierPricing }));

  expect(snapshot.models[0]?.estimate.tiers).toEqual([
    { label: 'standard', input: 1, output: 2, cacheRead: 0.1 },
    { label: 'long-context', input: 3, output: 4, cacheRead: 0.2 },
  ]);
});

it.each([
  { label: 'standard', tier: 'standard' },
  { label: 'unlabeled', tier: undefined },
])('estimates a workload from one matching $label shared pricing row', ({ tier }) => {
  const model = provider({
    id: 'anthropic-api',
    templateId: 'anthropic-api',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel('single-shared-rate')] },
  });
  const sharedPricing: PricingCacheFile = {
    generated_at: '2026-10-01T00:00:00.000Z',
    models: [{ model_id: 'single-shared-rate', pricing: [{ platform: 'anthropic', modality: 'text',
      ...(tier === undefined ? {} : { tier }), input_per_1m_tokens: 3, output_per_1m_tokens: 4 }] }],
  };
  const catalog = buildRoutingCatalog(input([model], { pricing: sharedPricing }));

  expect(estimateWorkload(catalog.models[0]!.estimate, { input: 10_000, output: 2_000 }))
    .toMatchObject({ kind: 'known', amount: 0.038 });
});

it.each([
  { label: 'multiple conditionless rows', rows: [
    { platform: 'anthropic', tier: 'standard', input_per_1m_tokens: 3, output_per_1m_tokens: 4 },
    { platform: 'anthropic', tier: 'long-context', input_per_1m_tokens: 5, output_per_1m_tokens: 6 },
  ] },
  { label: 'one nonstandard row', rows: [
    { platform: 'anthropic', tier: 'long-context', input_per_1m_tokens: 5, output_per_1m_tokens: 6 },
  ] },
])('keeps workload estimates unknown for $label', ({ rows }) => {
  const model = provider({
    id: 'anthropic-api',
    templateId: 'anthropic-api',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel('ambiguous-shared-rate')] },
  });
  const sharedPricing: PricingCacheFile = {
    generated_at: '2026-10-01T00:00:00.000Z',
    models: [{ model_id: 'ambiguous-shared-rate', pricing: rows }],
  };
  const catalog = buildRoutingCatalog(input([model], { pricing: sharedPricing }));

  expect(estimateWorkload(catalog.models[0]!.estimate, { input: 10_000, output: 2_000 }).kind).toBe('unknown');
});

it('records when a matching model price came from another platform', () => {
  const substituted = provider({
    id: 'anthropic-api',
    templateId: 'anthropic-api',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel('routing-fixture-substitute')] },
  });

  const snapshot = buildRoutingCatalog(input([substituted], { credentials: [observation(substituted.id)] }));
  const estimate = snapshot.models.find(model => model.ref.modelId === 'routing-fixture-substitute')?.estimate;

  expect(estimate).toMatchObject({ requestedPlatform: 'anthropic', platform: 'openai', substituted: true });
});

it('does not mark another platform price as a known provider charge', () => {
  const substituted = provider({
    id: 'anthropic-api',
    templateId: 'anthropic-api',
    modelsCache: {
      fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel('routing-fixture-substitute')],
    },
  });

  const snapshot = buildRoutingCatalog(input([substituted]));

  expect(snapshot.models[0]?.estimate.kind).toBe('unknown');
});

it.each([
  { providerId: 'unmapped-provider', templateId: 'unmapped-provider', modelId: 'unmapped-provider-platform' },
  { providerId: 'anthropic-api', templateId: 'anthropic-api', modelId: 'missing-row-platform' },
])('keeps shared rates unknown when platform provenance cannot be verified', ({ providerId, templateId, modelId }) => {
  const shared = provider({
    id: providerId,
    templateId,
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel(modelId)] },
  });

  const snapshot = buildRoutingCatalog(input([shared], { pricing: unverifiablePlatformPricing }));

  expect(snapshot.models[0]?.estimate).toMatchObject({ kind: 'unknown', input: 3, output: 7 });
});

it('keeps explicit model prices known without a shared platform mapping', () => {
  const explicitlyPriced = {
    ...cachedModel('explicit-price-model'),
    pricing: { input: 3, output: 7, source: 'synthetic-account' },
  };
  const supplied = provider({
    id: 'unmapped-provider',
    templateId: 'unmapped-provider',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [explicitlyPriced] },
  });

  const snapshot = buildRoutingCatalog(input([supplied], { pricing: unverifiablePlatformPricing }));

  expect(snapshot.models[0]?.estimate).toMatchObject({ kind: 'known', input: 3, output: 7, source: 'synthetic-account' });
});

it.each(invalidNestedRateCases)('marks malformed $caseName unknown and removes it from the snapshot', ({ pricing, expected }) => {
  expect(observedPricing(estimateForRawPricing(pricing))).toEqual(expected);
});

it.each(invalidTtlCases)('marks $caseName unknown and removes its TTL bands', ({ pricing, expected }) => {
  expect(observedPricing(estimateForRawPricing(pricing))).toEqual(expected);
});

it.each(invalidContextTierCases)('marks $caseName unknown and removes its context tier', ({ pricing, expected }) => {
  expect(observedPricing(estimateForRawPricing(pricing))).toEqual(expected);
});
