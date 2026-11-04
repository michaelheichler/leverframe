import { dirname, relative, sep } from 'node:path';
import { expect, it } from 'vitest';
import { buildRoutingCatalog } from '../src/model-routing.js';
import { getAppHome } from '../src/paths.js';
import {
  createRoutingBinding,
  recordRoutingRequestEstimate,
  routingBindingErrors,
  routingBindingStatePath,
  withRoutingLease,
} from '../src/routing-bindings.js';
import type { RoutingConfig, RoutingWorkload } from '../src/model-routing.js';
import { input, observation, provider } from './model-routing-fixtures.js';

const ref = { providerId: 'fixture-request-provider', modelId: 'fixture-request-model' };
const timestamp = '2026-10-01T00:00:00.000Z';
const tempHome = process.env['LEVERFRAME_TEST_HOME'];

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function requestRoutingContext() {
  const registeredProvider = provider({
    id: ref.providerId,
    templateId: 'fixture',
    modelsCache: {
      fetchedAt: timestamp,
      source: 'account',
      models: [{
        id: ref.modelId,
        name: ref.modelId,
        upstreamModelId: 'fixture-request-upstream',
        modelFormat: 'anthropic',
        supportedReasoningEfforts: ['low'],
        pricing: { input: 2, output: 8, source: 'fixture-pricing' },
      }],
    },
  });
  const snapshot = input([registeredProvider], {
    credentials: [observation(registeredProvider.id)],
    discovery: [{ providerId: registeredProvider.id, status: 'live', cacheFetchedAt: timestamp }],
  });
  const config: RoutingConfig = {
    enabled: true,
    cheapFallback: ref,
    pool: [ref],
    categories: { review: { target: ref, effort: 'low' } },
  };
  const workload = { cacheRead: 0, cacheWrite: 0 } as RoutingWorkload;
  return { config, catalog: buildRoutingCatalog(snapshot), workload };
}

function expectSessionStateIsIsolated(sessionId: string): void {
  expect(tempHome).toBeTruthy();
  expect(isInside(tempHome!, getAppHome())).toBe(true);
  expect(isInside(tempHome!, dirname(routingBindingStatePath(sessionId)))).toBe(true);
}

it('updates only the first leased request estimate and keeps its worker binding stable', async () => {
  const context = requestRoutingContext();
  const sessionId = 'session-first-request-estimate';
  expectSessionStateIsIsolated(sessionId);
  const binding = await createRoutingBinding({
    sessionId,
    launchId: 'launch-first-request-estimate',
    role: 'specialist',
    category: 'review',
    task: 'Estimate the first request',
    ...context,
  });
  const bindingRequest = { sessionId, modelId: binding.id };
  const acceptedRevision = binding.revision;
  const selectionReason = binding.decision.reason;
  let firstEstimate: Awaited<ReturnType<typeof recordRoutingRequestEstimate>> | undefined;
  let repeatedEstimate: Awaited<ReturnType<typeof recordRoutingRequestEstimate>> | undefined;

  await withRoutingLease(bindingRequest, async leased => {
    firstEstimate = await recordRoutingRequestEstimate({
      ...bindingRequest,
      leaseId: leased.lease!,
      inputBytes: 4000,
      maxOutputTokens: 1000,
      cacheUsageUnknown: false,
      catalog: context.catalog,
    });
    repeatedEstimate = await recordRoutingRequestEstimate({
      ...bindingRequest,
      leaseId: leased.lease!,
      inputBytes: 20_000,
      maxOutputTokens: 4000,
      cacheUsageUnknown: false,
      catalog: context.catalog,
    });
  });

  expect(firstEstimate?.id).toBe(binding.id);
  expect(firstEstimate?.revision).toBe(acceptedRevision);
  expect(firstEstimate?.decision.target).toEqual(binding.decision.target);
  expect(firstEstimate?.decision.reason).toBe(selectionReason);
  expect(firstEstimate?.decision.estimate.amount).toEqual(expect.any(Number));
  expect(firstEstimate?.decision.estimate.amount).toBeGreaterThan(0);
  expect(repeatedEstimate?.decision.estimate).toEqual(firstEstimate?.decision.estimate);
});

it('keeps cost unknown when explicit cache controls lack cache usage evidence', async () => {
  const context = requestRoutingContext();
  const sessionId = 'session-unknown-cache-usage';
  expectSessionStateIsIsolated(sessionId);
  const binding = await createRoutingBinding({
    sessionId,
    launchId: 'launch-unknown-cache-usage',
    role: 'specialist',
    category: 'review',
    task: 'Preserve cache uncertainty',
    ...context,
  });
  let updated: Awaited<ReturnType<typeof recordRoutingRequestEstimate>> | undefined;

  await withRoutingLease({ sessionId, modelId: binding.id }, async leased => {
    updated = await recordRoutingRequestEstimate({
      sessionId,
      modelId: binding.id,
      leaseId: leased.lease!,
      inputBytes: 4000,
      maxOutputTokens: 1000,
      cacheUsageUnknown: true,
      catalog: context.catalog,
    });
  });

  expect(updated?.decision.estimate.amount).toBeUndefined();
  expect(updated?.decision.target).toEqual(binding.decision.target);
});

it('rejects a request estimate update without the active binding lease', async () => {
  const context = requestRoutingContext();
  const sessionId = 'session-stale-request-estimate';
  expectSessionStateIsIsolated(sessionId);
  const binding = await createRoutingBinding({
    sessionId,
    launchId: 'launch-stale-request-estimate',
    role: 'specialist',
    category: 'review',
    task: 'Reject a stale estimate',
    ...context,
  });

  await expect(recordRoutingRequestEstimate({
    sessionId,
    modelId: binding.id,
    leaseId: 'stale-lease',
    inputBytes: 4000,
    maxOutputTokens: 1000,
    cacheUsageUnknown: false,
    catalog: context.catalog,
  })).rejects.toMatchObject({ code: routingBindingErrors.leaseConflict, retryable: true });
});
