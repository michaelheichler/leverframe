import { expect, it } from 'vitest';
import { httpProxyModelId } from '../src/http-proxy/routes.js';
import { routingPreflight, routingIdentityErrors } from '../src/routing-policy-identity.js';
import type { RoutingCatalogModel } from '../src/model-routing-catalog.js';
import { nativeRoutingContext, sdkRoutingContext } from './fixtures/model-routing-proxy.js';

it('pins an adapter target to its visible route identity and confirmed context', () => {
  const context = sdkRoutingContext();
  const preflight = routingPreflight(context.config, context.catalog);

  expect(preflight).toMatchObject({
    target: context.routerTarget,
    policyModelId: httpProxyModelId(context.routerTarget!.providerId, context.routerTarget!.modelId),
    contextWindow: 70_000,
  });
});

it('pins a native target to its discovered upstream identity without returning credential data', () => {
  const context = nativeRoutingContext();
  const selected = context.catalog.models[0]!;
  const credentialMarker = 'synthetic-native-credential-marker';
  context.catalog = { ...context.catalog, models: [{ ...selected,
    contextWindow: 84_000, contextWindowConfirmed: true,
    credential: { ...selected.credential, authRef: credentialMarker },
  }] };

  const preflight = routingPreflight(context.config, context.catalog);

  expect(preflight).toMatchObject({
    target: selected.ref,
    policyModelId: selected.upstreamModelId,
    contextWindow: 84_000,
  });
  expect(JSON.stringify(preflight)).not.toContain(credentialMarker);
});

it('uses an eligible model row when stale metadata with the same reference appears first', () => {
  const context = nativeRoutingContext();
  const eligible = context.catalog.models[0]!;
  const stale = { ...eligible,
    upstreamModelId: 'stale-upstream-identity',
    credential: { ...eligible.credential, available: false },
  };
  context.catalog = { ...context.catalog, models: [stale, eligible] };

  const preflight = routingPreflight(context.config, context.catalog);

  expect(preflight.policyModelId).toBe(eligible.upstreamModelId);
});

it('fails closed when eligible rows disagree on a native upstream identity', () => {
  const context = nativeRoutingContext();
  const first = context.catalog.models[0]!;
  context.catalog = { ...context.catalog, models: [first, { ...first, upstreamModelId: 'conflicting-upstream-identity' }] };

  expect(() => routingPreflight(context.config, context.catalog))
    .toThrowError(expect.objectContaining({ code: routingIdentityErrors.conflict }));
});

it('fails closed when eligible account rows disagree on their upstream model identity', () => {
  const context = sdkRoutingContext();
  const selected = context.catalog.models[0]!;
  context.catalog = { ...context.catalog, models: [
    { ...selected, accountId: 'account-one', upstreamModelId: 'account-one-upstream' },
    { ...selected, accountId: 'account-two', upstreamModelId: 'account-two-upstream' },
  ] };

  expect(() => routingPreflight(context.config, context.catalog))
    .toThrowError(expect.objectContaining({ code: routingIdentityErrors.conflict }));
});

it('fails closed when an eligible native model has no discovered upstream identity', () => {
  const context = nativeRoutingContext();
  const selected = context.catalog.models[0]!;
  context.catalog = { ...context.catalog, models: [{ ...selected, upstreamModelId: undefined }] };

  expect(() => routingPreflight(context.config, context.catalog))
    .toThrowError(expect.objectContaining({ code: routingIdentityErrors.unavailable }));
});

it('uses the minimum confirmed context across duplicate eligible identities', () => {
  const context = sdkRoutingContext();
  const selected = context.catalog.models[0]!;
  context.catalog = { ...context.catalog, models: [
    { ...selected, contextWindow: 80_000, contextWindowConfirmed: true },
    { ...selected, contextWindow: 64_000, contextWindowConfirmed: true },
  ] };

  const preflight = routingPreflight(context.config, context.catalog);

  expect(preflight.contextWindow).toBe(64_000);
});

it('returns conservative shared limits and the union of explicitly confirmed efforts', () => {
  const context = sdkRoutingContext();
  const selected = context.catalog.models[0]!;
  context.catalog = { ...context.catalog, models: [
    { ...selected, contextWindow: 80_000, contextWindowConfirmed: true,
      maxOutputTokens: 12_000, supportedReasoningEfforts: ['low'] },
    { ...selected, contextWindow: 64_000, contextWindowConfirmed: true,
      maxOutputTokens: 8_000, supportedReasoningEfforts: ['high'] },
  ] };

  const preflight = routingPreflight(context.config, context.catalog);

  const sharedMetadata = preflight.targetMetadata[preflight.policyModelId];
  expect(sharedMetadata).toMatchObject({ contextWindow: 64_000, maxOutputTokens: 8_000,
    supportedReasoningEfforts: expect.arrayContaining(['low', 'high']) });
  expect(sharedMetadata.supportedReasoningEfforts).toHaveLength(2);
});

it.each([
  ['context window', 'contextWindow', (row: RoutingCatalogModel) => ({ ...row, contextWindowConfirmed: false })],
  ['output limit', 'maxOutputTokens', (row: RoutingCatalogModel) => ({ ...row, maxOutputTokens: undefined })],
  ['supported efforts', 'supportedReasoningEfforts', (row: RoutingCatalogModel) => ({ ...row, supportedReasoningEfforts: undefined })],
] as const)('leaves shared %s unknown when one eligible row lacks it', (_label, resultField, makeIncomplete) => {
  const context = sdkRoutingContext();
  const selected = context.catalog.models[0]!;
  const complete = { ...selected, contextWindow: 80_000, contextWindowConfirmed: true,
    maxOutputTokens: 12_000, supportedReasoningEfforts: ['low', 'medium'] };
  const incomplete = makeIncomplete({ ...selected, contextWindow: 64_000, contextWindowConfirmed: true,
    maxOutputTokens: 8_000, supportedReasoningEfforts: ['medium', 'high'] });
  context.catalog = { ...context.catalog, models: [complete, incomplete] };

  const preflight = routingPreflight(context.config, context.catalog);

  expect(preflight.metadata?.[resultField]).toBeUndefined();
});
