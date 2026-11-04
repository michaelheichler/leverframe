import { expect, it } from 'vitest';
import { httpProxyModelId } from '../src/http-proxy/routes.js';
import { decideRouting, type ModelRef, type RoutingCatalogSnapshot, type RoutingConfig } from '../src/model-routing.js';
import { routingPreflight } from '../src/routing-policy-identity.js';
import { sdkRoutingContext } from './fixtures/model-routing-proxy.js';

it('retains removed specialist metadata for recovery without adding it to new-job policy', () => {
  const context = sdkRoutingContext();
  const routerTarget = context.routerTarget!;
  const recoveredTarget: ModelRef = { providerId: routerTarget.providerId, modelId: 'fixture-recovered-specialist-model' };
  const routerRow = context.catalog.models[0]!;
  const recoveredRow = { ...routerRow, ref: recoveredTarget, upstreamModelId: 'fixture-recovered-specialist-upstream',
    contextWindow: 24_000, maxOutputTokens: 900, supportedReasoningEfforts: ['high'] };
  const catalog: RoutingCatalogSnapshot = { ...context.catalog, models: [...context.catalog.models, recoveredRow] };
  const config: RoutingConfig = { ...context.config, pool: [routerTarget],
    categories: { implementation: { target: routerTarget, effort: 'low' } } };
  const withRecoveredTarget = routingPreflight as unknown as (
    value: RoutingConfig, snapshot: RoutingCatalogSnapshot, targets: ModelRef[],
  ) => ReturnType<typeof routingPreflight>;
  const preflight = withRecoveredTarget(config, catalog, [recoveredTarget]);
  const newSpecialist = decideRouting({ config, catalog, role: 'specialist', category: 'implementation',
    workload: { input: 100, output: 80, cacheRead: 0, cacheWrite: 0 } });

  expect(preflight.target).toEqual(routerTarget);
  expect(preflight.targetMetadata[httpProxyModelId(recoveredTarget.providerId, recoveredTarget.modelId)])
    .toMatchObject({ contextWindow: 24_000, maxOutputTokens: 900, supportedReasoningEfforts: ['high'] });
  expect(newSpecialist.target).toEqual(routerTarget);
  expect(config.pool).toEqual([routerTarget]);
});
