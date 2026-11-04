import { expect, it } from 'vitest';
import { buildRoutingCatalog, decideRouting } from '../src/model-routing.js';
import { routingSelectorCandidateVersion, ROUTING_SIGNATURE_VERSION } from '../src/routing-selector-versions.js';
import type { RoutingConfig, RoutingWorkload } from '../src/model-routing.js';
import type { RoutingCatalogSnapshot } from '../src/model-routing-catalog.js';
import { input, observation, provider } from './model-routing-fixtures.js';

const refs = [
  { providerId: 'fixture-provider-a', modelId: 'fixture-model-a' },
  { providerId: 'fixture-provider-b', modelId: 'fixture-model-b' },
];
const workload: RoutingWorkload = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 };

function catalog() {
  const providers = refs.map(ref => provider({
    id: ref.providerId,
    templateId: 'fixture',
    modelsCache: {
      fetchedAt: '2026-10-01T00:00:00.000Z',
      source: 'account',
      models: [{
        id: ref.modelId,
        name: ref.modelId,
        upstreamModelId: `upstream-${ref.modelId}`,
        modelFormat: 'anthropic',
        supportedReasoningEfforts: ['low'],
        pricing: { input: 2, output: 8, source: 'fixture-pricing' },
        contextWindow: 70_000,
      }],
    },
  }));
  return buildRoutingCatalog(input(providers, {
    credentials: providers.map(item => observation(item.id)),
    discovery: providers.map(item => ({
      providerId: item.id,
      status: 'live' as const,
      cacheFetchedAt: '2026-10-01T00:00:00.000Z',
    })),
  }));
}

function decision(snapshot: RoutingCatalogSnapshot) {
  const config: RoutingConfig = { enabled: true, pool: refs, cheapFallback: refs[0] };
  return decideRouting({ config, catalog: snapshot, role: 'specialist', workload });
}

it('keeps the selector candidate version stable across price and freshness changes', () => {
  const original = catalog();
  const selected = decision(original);
  const repriced: RoutingCatalogSnapshot = {
    generatedAt: '2026-11-01T00:00:00.000Z',
    models: original.models.map(model => ({
      ...model,
      estimate: { ...model.estimate, input: (model.estimate.input ?? 0) + 50 },
      discovery: { ...model.discovery, fetchedAt: '2026-11-01T00:00:00.000Z' },
    })),
  };

  const originalVersion = routingSelectorCandidateVersion({
    decision: selected, catalog: original, category: 'review', effort: 'low',
  });
  const changedPriceVersion = routingSelectorCandidateVersion({
    decision: selected, catalog: repriced, category: 'review', effort: 'low',
  });

  expect(ROUTING_SIGNATURE_VERSION).toBeTruthy();
  expect(changedPriceVersion).toBe(originalVersion);
});

it('changes the selector candidate version when confirmed model capability changes', () => {
  const original = catalog();
  const selected = decision(original);
  const changed: RoutingCatalogSnapshot = {
    ...original,
    models: original.models.map((model, index) => index === 0 ? {
      ...model,
      confirmedCapabilities: [...model.confirmedCapabilities, 'images'],
    } : model),
  };

  const originalVersion = routingSelectorCandidateVersion({
    decision: selected, catalog: original, category: 'review', effort: 'low',
  });
  const changedVersion = routingSelectorCandidateVersion({
    decision: selected, catalog: changed, category: 'review', effort: 'low',
  });

  expect(changedVersion).not.toBe(originalVersion);
});
