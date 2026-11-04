import { dirname, relative, sep } from 'node:path';
import { expect, it } from 'vitest';
import { buildRoutingCatalog } from '../src/model-routing.js';
import { getAppHome } from '../src/paths.js';
import { createRoutingBinding, routingBindingStatePath } from '../src/routing-bindings.js';
import type { RoutingRequirements } from '../src/routing-policy.js';
import { input, observation, provider } from './model-routing-fixtures.js';

const modelA = { providerId: 'fixture-requirement-provider-a', modelId: 'fixture-requirement-model-a' };
const modelB = { providerId: 'fixture-requirement-provider-b', modelId: 'fixture-requirement-model-b' };
const testHome = process.env['LEVERFRAME_TEST_HOME'];

function routingContext() {
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
        reasoning: true,
        supportedReasoningEfforts: ['low', 'high'],
        pricing: { input: 2, output: 8, source: 'fixture-pricing' },
      }],
    },
  }));
  const catalog = buildRoutingCatalog(input(providers, {
    credentials: providers.map(item => observation(item.id)),
    discovery: providers.map(item => ({ providerId: item.id, status: 'live' as const, cacheFetchedAt: '2026-10-01T00:00:00.000Z' })),
  }));
  return {
    config: { enabled: true, cheapFallback: modelA, pool: [modelA, modelB],
      categories: { implementation: { target: modelA, effort: 'low' } } },
    catalog,
    workload: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0 },
  };
}

it('restores the accepted model requirements when resume omits or changes them', async () => {
  const context = routingContext();
  const sessionId = 'session-resume-requirements';
  const statePath = routingBindingStatePath(sessionId);
  const inside = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
  };
  expect(testHome).toBeTruthy();
  expect(inside(testHome!, getAppHome())).toBe(true);
  expect(inside(testHome!, dirname(statePath))).toBe(true);
  const requirements: RoutingRequirements = { capabilities: ['reasoning'] };
  const launch = { sessionId, launchId: 'launch-resume-requirements', role: 'specialist' as const,
    category: 'implementation', task: 'Original restricted task', ...context };

  const accepted = await createRoutingBinding({ ...launch, requirements });
  const resumed = await createRoutingBinding({ ...launch, resume: true, requirements: undefined,
    category: undefined, effort: 'high', task: 'Changed resumed task' });

  expect(accepted.requirements).toEqual(requirements);
  expect(resumed.requirements).toEqual(requirements);
  expect(resumed.decision.target).toEqual(accepted.decision.target);
});
