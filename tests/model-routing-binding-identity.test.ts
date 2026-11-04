import { dirname, relative, sep } from 'node:path';
import { expect, it } from 'vitest';
import { buildRoutingCatalog } from '../src/model-routing.js';
import { getAppHome } from '../src/paths.js';
import { createRoutingBinding, routingBindingErrors, routingBindingStatePath } from '../src/routing-bindings.js';
import type { RoutingCatalogSnapshot } from '../src/model-routing-catalog.js';
import { input, observation, provider } from './model-routing-fixtures.js';

const ref = { providerId: 'fixture-routing-identity-provider', modelId: 'fixture-routing-identity-model' };
const testHome = process.env['LEVERFRAME_TEST_HOME'];

function context(upstreamModelId: string, credentialSource: 'registry' | 'claude-code' = 'registry') {
  const registeredProvider = provider({
    id: ref.providerId,
    templateId: 'fixture',
    modelsCache: {
      source: 'account',
      fetchedAt: '2026-10-01T00:00:00.000Z',
      models: [{ id: ref.modelId, name: ref.modelId, upstreamModelId, modelFormat: 'anthropic',
        supportedReasoningEfforts: ['low'], pricing: { input: 1, output: 2, source: 'fixture-price' } }],
    },
  });
  const base = buildRoutingCatalog(input([registeredProvider], {
    credentials: [observation(registeredProvider.id)],
    discovery: [{ providerId: registeredProvider.id, status: 'live', cacheFetchedAt: '2026-10-01T00:00:00.000Z' }],
  }));
  const catalog: RoutingCatalogSnapshot = {
    ...base,
    models: base.models.map(model => ({ ...model, upstreamModelId,
      credential: { ...model.credential, source: credentialSource } })),
  };
  return {
    config: { enabled: true, cheapFallback: ref, pool: [ref],
      categories: { implementation: { target: ref, effort: 'low' } } },
    catalog,
    workload: { input: 400, output: 120, cacheRead: 0, cacheWrite: 0 },
  };
}

function expectBindingStateIsIsolated(sessionId: string): void {
  const statePath = routingBindingStatePath(sessionId);
  expect(testHome).toBeTruthy();
  const isInside = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
  };
  expect(isInside(testHome!, getAppHome())).toBe(true);
  expect(isInside(testHome!, dirname(statePath))).toBe(true);
}

it('restores the saved model identity when an idempotent resume sees the same source', async () => {
  const sessionId = 'session-router-identity-stable';
  expectBindingStateIsIsolated(sessionId);
  const launch = { ...context('fixture-first-party-model'), sessionId, launchId: 'launch-router-identity-stable',
    role: 'specialist' as const, category: 'implementation', task: 'Continue the same model work' };

  const accepted = await createRoutingBinding(launch);
  const resumed = await createRoutingBinding({ ...launch, resume: true });

  expect(accepted.identity).toMatchObject({ upstreamModelId: 'fixture-first-party-model', credentialSource: 'registry' });
  expect(resumed.id).toBe(accepted.id);
  expect(resumed.identity).toEqual(accepted.identity);
});

it('rejects resume when the same model reference now has a different upstream identity', async () => {
  const sessionId = 'session-router-identity-upstream-change';
  expectBindingStateIsIsolated(sessionId);
  const original = context('fixture-first-party-model');
  const changed = context('fixture-different-upstream-model');
  const launch = { sessionId, launchId: 'launch-router-identity-upstream-change', role: 'specialist' as const,
    category: 'implementation', task: 'Continue the same model work' };
  await createRoutingBinding({ ...launch, ...original });

  await expect(createRoutingBinding({ ...launch, ...changed, resume: true }))
    .rejects.toMatchObject({ code: routingBindingErrors.identityMismatch });
});

it('rejects resume when the same model reference changes credential source', async () => {
  const sessionId = 'session-router-identity-source-change';
  expectBindingStateIsIsolated(sessionId);
  const original = context('fixture-first-party-model', 'registry');
  const changed = context('fixture-first-party-model', 'claude-code');
  const launch = { sessionId, launchId: 'launch-router-identity-source-change', role: 'specialist' as const,
    category: 'implementation', task: 'Continue the same model work' };
  await createRoutingBinding({ ...launch, ...original });

  await expect(createRoutingBinding({ ...launch, ...changed, resume: true }))
    .rejects.toMatchObject({ code: routingBindingErrors.identityMismatch });
});

it('rejects a direct launch retry when caller-supplied requirements change', async () => {
  const sessionId = 'session-direct-requirements-retry';
  expectBindingStateIsIsolated(sessionId);
  const original = context('fixture-first-party-model');
  const model = original.catalog.models[0]!;
  model.capabilities = { ...model.capabilities, tools: true, images: true };
  model.confirmedCapabilities = [...model.confirmedCapabilities, 'tools', 'images'];
  model.contextWindow = 64_000;
  model.contextWindowConfirmed = true;
  model.maxOutputTokens = 8_000;
  const launch = { sessionId, launchId: 'launch-direct-requirements-retry', role: 'specialist' as const,
    category: 'implementation', task: 'Keep the explicitly requested model requirements stable', ...original };

  await createRoutingBinding({ ...launch, requirements: { capabilities: ['tools'] } });

  await expect(createRoutingBinding({ ...launch, requirements: { capabilities: ['images'] } }))
    .rejects.toMatchObject({ code: routingBindingErrors.launchMismatch });
});
