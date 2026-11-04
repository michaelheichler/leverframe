import { expect, it } from 'vitest';
import { buildRoutingCatalog } from '../src/model-routing.js';
import { decideRouting } from '../src/routing-policy.js';
import { routingSelectorCandidateVersion } from '../src/routing-selector-versions.js';
import { input, observation, provider } from './model-routing-fixtures.js';

const refs = [
  { providerId: 'version-provider-a', modelId: 'version-model-a' },
  { providerId: 'version-provider-b', modelId: 'version-model-b' },
];

function catalogAt(prices: number[]) {
  const providers = refs.map((ref, index) => provider({
    id: ref.providerId,
    templateId: 'fixture',
    billing: { kind: 'metered' as const, source: 'fixture-billing', observedAt: '2026-10-01T00:00:00.000Z' },
    modelsCache: {
      fetchedAt: '2026-10-01T00:00:00.000Z', source: 'account', models: [{
        id: ref.modelId,
        name: ref.modelId,
        upstreamModelId: `upstream-${ref.modelId}`,
        modelFormat: 'anthropic' as const,
        supportedReasoningEfforts: ['low'],
        pricing: { input: prices[index]!, output: prices[index]!, source: 'fixture-pricing' },
      }],
    },
  }));
  return buildRoutingCatalog(input(providers, {
    credentials: providers.map(item => observation(item.id)),
    discovery: providers.map(item => ({ providerId: item.id, status: 'live' as const, cacheFetchedAt: item.modelsCache!.fetchedAt })),
  }));
}

function decision(catalog: ReturnType<typeof catalogAt>, poolRefs = refs) {
  return decideRouting({ config: { enabled: true, pool: poolRefs }, catalog, role: 'specialist', effort: 'low',
    workload: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } });
}

it('keeps selector candidate identity stable across price and snapshot freshness changes', () => {
  const firstCatalog = catalogAt([1, 2]);
  const firstDecision = decision(firstCatalog);
  const changedCatalog = catalogAt([50, 0.1]);
  const changedDecision = decision(changedCatalog);

  const firstVersion = routingSelectorCandidateVersion({ decision: firstDecision, catalog: firstCatalog, category: 'implementation', effort: 'low' });
  const changedVersion = routingSelectorCandidateVersion({ decision: changedDecision, catalog: changedCatalog, category: 'implementation', effort: 'low' });

  expect(changedVersion).toBe(firstVersion);
});
it('changes selector candidate identity when an eligible pool member is removed', () => {
  const catalog = catalogAt([1, 2]);
  const fullPool = decision(catalog);
  const reducedPool = decision(catalog, [refs[0]!]);

  const fullVersion = routingSelectorCandidateVersion({ decision: fullPool, catalog, category: 'implementation', effort: 'low' });
  const reducedVersion = routingSelectorCandidateVersion({ decision: reducedPool, catalog, category: 'implementation', effort: 'low' });

  expect(reducedVersion).not.toBe(fullVersion);
});

it('changes selector candidate identity when an eligible model changes its sourced upstream identity', () => {
  const catalog = catalogAt([1, 2]);
  const selected = decision(catalog);
  const changedCatalog = {
    ...catalog,
    models: catalog.models.map((model, index) => index === 0 ? { ...model, upstreamModelId: 'changed-upstream-model' } : model),
  };

  const originalVersion = routingSelectorCandidateVersion({ decision: selected, catalog, category: 'implementation', effort: 'low' });
  const changedVersion = routingSelectorCandidateVersion({ decision: selected, catalog: changedCatalog, category: 'implementation', effort: 'low' });

  expect(changedVersion).not.toBe(originalVersion);
});
