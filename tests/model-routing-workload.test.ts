import { dirname, relative, sep } from 'node:path';
import { expect, it } from 'vitest';
import { buildRoutingCatalog, decideRouting } from '../src/model-routing.js';
import { createRoutingBinding, routingBindingStatePath } from '../src/routing-bindings.js';
import { getAppHome } from '../src/paths.js';
import type { ModelRef, RoutingConfig, RoutingWorkload } from '../src/model-routing.js';
import { input, observation, provider } from './model-routing-fixtures.js';

const modelA = { providerId: 'fixture-provider-a', modelId: 'fixture-model-a' };
const modelB = { providerId: 'fixture-provider-b', modelId: 'fixture-model-b' };
const testHome = process.env['LEVERFRAME_TEST_HOME'];

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function routingCatalog(refs: ModelRef[]) {
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
      }],
    },
  }));
  const snapshot = input(providers, {
    credentials: providers.map(item => observation(item.id)),
    discovery: providers.map(item => ({
      providerId: item.id,
      status: 'live' as const,
      cacheFetchedAt: '2026-10-01T00:00:00.000Z',
    })),
  });
  return buildRoutingCatalog(snapshot);
}

it('does not treat missing launch usage as free and records the unknown workload decision', () => {
  const config: RoutingConfig = { enabled: true, pool: [modelB, modelA], cheapFallback: modelA };
  const workload = { cacheRead: 0, cacheWrite: 0 } as RoutingWorkload;

  const decision = decideRouting({ config, catalog: routingCatalog([modelA, modelB]), role: 'specialist', workload });

  expect(decision.target).toEqual(modelA);
  expect(decision.estimate.amount).toBeUndefined();
  expect(decision.events.length).toBeGreaterThan(1);
});

it('does not spend a selector call when launch workload is missing', async () => {
  const providers = [modelA, modelB].map(ref => provider({
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
      }],
    },
  }));
  const snapshot = input(providers, {
    credentials: providers.map(item => observation(item.id)),
    discovery: providers.map(item => ({
      providerId: item.id,
      status: 'live' as const,
      cacheFetchedAt: '2026-10-01T00:00:00.000Z',
    })),
  });
  const config: RoutingConfig = {
    enabled: true,
    pool: [modelA, modelB],
    cheapFallback: modelA,
    selector: {
      enabled: true,
      target: modelA,
      maxExtraCallsPerTask: 1,
      maxOutputTokens: 16,
      evaluationEvidence: [{
        category: 'default',
        candidateSetVersion: 'fixture-candidate-set',
        signatureVersion: 'fixture-signature',
        sampleSize: 4,
        sourceEvaluationId: 'fixture-evaluation',
        measuredAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '2026-10-03T00:00:00.000Z',
        avoidedTokens: { input: 5000 },
      }],
    },
  };
  const sessionId = 'session-unknown-launch-workload';
  const statePath = routingBindingStatePath(sessionId);
  expect(testHome).toBeTruthy();
  expect(inside(testHome!, getAppHome())).toBe(true);
  expect(inside(testHome!, dirname(statePath))).toBe(true);
  let selectorCalls = 0;

  const binding = await createRoutingBinding({
    sessionId,
    launchId: 'launch-unknown-workload',
    role: 'specialist',
    task: 'Do not spend an uneconomic selector call',
    config,
    catalog: buildRoutingCatalog(snapshot),
    workload: { cacheRead: 0, cacheWrite: 0 },
    selector: {
      features: { size: 'small', turns: 'few', tools: 'none', recentFailures: 0 },
      candidateSetVersion: 'fixture-candidate-set',
      signatureVersion: 'fixture-signature',
      selectorWorkload: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      call: async () => {
        selectorCalls++;
        return modelB;
      },
    },
  });

  expect(binding.selectorCalls).toBe(0);
  expect(selectorCalls).toBe(0);
  expect(binding.decision.estimate.amount).toBeUndefined();
});
