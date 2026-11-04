import { describe, expect, it } from 'vitest';
import * as routing from '../src/model-routing.js';
import type { RoutingCatalogModel, RoutingCatalogSnapshot } from '../src/model-routing-catalog.js';

const ref = (providerId: string, modelId: string) => ({ providerId, modelId });
const rates = (input: number | undefined, output: number | undefined) => ({
  kind: 'known', currency: 'USD', unit: 'per-million-tokens', input, output, substituted: false, freshness: 'current',
});
const model = (providerId: string, modelId: string, estimate: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  ref: ref(providerId, modelId), credential: { source: 'registry', authRef: 'fixture', kind: 'api_key', available: true },
  billing: { kind: 'metered' }, discovery: { source: 'registry', state: 'current', confirmed: true, fetchedAt: 'fixture' },
  capabilities: { tools: true, images: true, reasoning: true, promptCache: true, websocket: true },
  confirmedCapabilities: ['tools', 'images', 'reasoning', 'promptCache', 'websocket'],
  contextWindow: 100_000, contextWindowConfirmed: true, estimate, ...extra,
}) as unknown as RoutingCatalogModel;
const models = (...items: RoutingCatalogModel[]) => ({ generatedAt: 'fixture', models: items }) as RoutingCatalogSnapshot;
const workload = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 };
const policyInput = (pool: ReturnType<typeof ref>[], catalog: RoutingCatalogSnapshot, extra: Record<string, unknown> = {}) => ({
  config: { enabled: true, pool, ...extra['config'] as object }, catalog, role: 'specialist', workload, ...extra,
});
const decide = (input: unknown) => (routing as unknown as { decideRouting?: (value: unknown) => unknown }).decideRouting!(input) as {
  target: { providerId: string; modelId: string }; effort?: string;
  ordered: Array<{ ref: { providerId: string; modelId: string }; estimate: { kind: string; amount?: number } }>;
  estimate: { kind: string; amount?: number };
};
function captureError(action: () => unknown): unknown {
  try { action(); } catch (error) { return error; }
  return undefined;
}

describe('routing policy decisions', () => {
  it('keeps an explicit category target ahead of cheaper pool candidates', () => {
    const target = ref('assigned-provider', 'assigned-model');
    expect(decide(policyInput([target, ref('budget-provider', 'budget-model')], models(
      model(target.providerId, target.modelId, rates(90, 90)), model('budget-provider', 'budget-model', rates(0.01, 0.01)),
    ), { category: 'implementation', config: { categories: { implementation: { target } } } } )).target).toEqual(target);
  });

  it('fails when an explicit category target cannot be resolved', () => {
    const target = ref('missing-provider', 'missing-model');
    const error = captureError(() => decide(policyInput([], models(), { category: 'implementation', config: { categories: { implementation: { target } } } })));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ message: expect.stringContaining(target.providerId) });
  });

  it('keeps router decisions on router effort without applying the default specialist category', () => {
    const router = ref('router-provider', 'router-model');
    const categoryArm = ref('category-provider', 'category-model');
    const decision = decide({ config: { enabled: true, pool: [router], cheapFallback: router, defaultCategory: 'deep_research',
      categories: { deep_research: { effort: 'deep', alternatingTargets: [
        { providerId: categoryArm.providerId, modelId: categoryArm.modelId, effort: 'deep' },
        { providerId: categoryArm.providerId, modelId: `${categoryArm.modelId}-alternate`, effort: 'balanced' },
      ] } } }, catalog: models(
        model(router.providerId, router.modelId, rates(1, 1), { supportedReasoningEfforts: ['low'] }),
      ), role: 'router', effort: 'low', workload });

    expect(decision).toMatchObject({ target: router, effort: 'low' });
  });

  it('orders by current workload price and reprices from each supplied snapshot', () => {
    const pool = [ref('provider-a', 'model-a'), ref('provider-b', 'model-b')];
    const first = decide(policyInput(pool, models(model('provider-a', 'model-a', rates(10, 10)), model('provider-b', 'model-b', rates(2, 2)))));
    const second = decide(policyInput(pool, models(model('provider-a', 'model-a', rates(1, 1)), model('provider-b', 'model-b', rates(12, 12)))));
    expect(first.target).toEqual(pool[1]);
    expect(second.target).toEqual(pool[0]);
  });

  it('orders equal-cost models by a stable reference order', () => {
    const pool = [ref('provider-z', 'model-z'), ref('provider-a', 'model-a')];
    const catalog = models(model('provider-z', 'model-z', rates(2, 2)), model('provider-a', 'model-a', rates(2, 2)));
    expect(decide(policyInput(pool, catalog)).target).toEqual(pool[1]);
  });
});

describe('routing candidate eligibility', () => {
  it('orders unknown estimates after known estimates', () => {
    const decision = decide(policyInput([ref('provider-a', 'model-a'), ref('provider-b', 'model-b')], models(
      model('provider-a', 'model-a', { kind: 'unknown', currency: 'USD', unit: 'per-million-tokens', substituted: false, freshness: 'unknown' }),
      model('provider-b', 'model-b', rates(4, 4)),
    )));
    expect(decision.ordered.at(-1)?.estimate.kind).toEqual('unknown');
  });

  it.each([
    ['provider-z', 'model-z', 'provider-a', 'model-a'],
    ['provider-a', 'model-a', 'provider-z', 'model-z'],
  ])('orders all unknown-price candidates by stable reference for input order %s then %s', (firstProvider, firstModel, secondProvider, secondModel) => {
    const first = ref(firstProvider, firstModel);
    const second = ref(secondProvider, secondModel);
    const unknownPrice = { kind: 'unknown', currency: 'USD', unit: 'per-million-tokens', substituted: false, freshness: 'unknown' };
    const decision = decide(policyInput([first, second], models(
      model(first.providerId, first.modelId, unknownPrice),
      model(second.providerId, second.modelId, unknownPrice),
    )));

    expect(decision.ordered.map(candidate => candidate.ref)).toEqual([ref('provider-a', 'model-a'), ref('provider-z', 'model-z')]);
    expect(decision.ordered.map(candidate => candidate.estimate.kind)).toEqual(['unknown', 'unknown']);
    expect(decision.target).toEqual(ref('provider-a', 'model-a'));
    expect(decision.estimate.kind).toEqual('unknown');
  });

  it('retains an explicit target when its price is unknown', () => {
    const target = ref('provider-a', 'model-a');
    const decision = decide(policyInput([target, ref('provider-b', 'model-b')], models(
      model('provider-a', 'model-a', { kind: 'unknown', currency: 'USD', unit: 'per-million-tokens', substituted: false, freshness: 'unknown' }),
      model('provider-b', 'model-b', rates(4, 4)),
    ), { category: 'review', config: { categories: { review: { target } } } }));
    expect(decision.target).toEqual(target);
  });

  it('filters candidates without a required capability', () => {
    const capable = ref('provider-capable', 'model-capable');
    const decision = decide({ ...policyInput([ref('provider-limited', 'model-limited'), capable], models(
      model('provider-limited', 'model-limited', rates(1, 1), { confirmedCapabilities: ['tools'], capabilities: { images: false } }),
      model(capable.providerId, capable.modelId, rates(5, 5), { supportedReasoningEfforts: ['deep'] }),
    )), effort: 'deep', requirements: { capabilities: ['images'] } });
    expect(decision.target).toMatchObject(capable);
  });

  it('filters candidates without the requested reasoning effort', () => {
    const capable = ref('provider-capable', 'model-capable');
    const decision = decide({ ...policyInput([ref('provider-limited', 'model-limited'), capable], models(
      model('provider-limited', 'model-limited', rates(1, 1), { supportedReasoningEfforts: ['low'] }),
      model(capable.providerId, capable.modelId, rates(5, 5), { supportedReasoningEfforts: ['deep'] }),
    )), effort: 'deep' });
    expect(decision.target).toEqual(capable);
  });

  it('filters candidates without confirmed context capacity', () => {
    const capable = ref('provider-capable', 'model-capable');
    const decision = decide({ ...policyInput([ref('provider-limited', 'model-limited'), capable], models(
      model('provider-limited', 'model-limited', rates(1, 1), { contextWindow: 10_000, contextWindowConfirmed: false }),
      model(capable.providerId, capable.modelId, rates(5, 5)),
    )), requirements: { contextTokens: 20_000 } });
    expect(decision.target).toEqual(capable);
  });

  it('deduplicates model references across pool entries and accounts', () => {
    const shared = ref('provider-shared', 'model-shared');
    const decision = decide(policyInput([shared, shared, ref('provider-other', 'model-other')], models(
      model(shared.providerId, shared.modelId, rates(2, 2), { accountId: 'account-one', credential: { available: false } }),
      model(shared.providerId, shared.modelId, rates(2, 2), { accountId: 'account-two' }), model('provider-other', 'model-other', rates(3, 3)),
    )));
    expect(decision.target).toEqual(shared);
    expect(decision.ordered.filter(candidate => candidate.ref.providerId === shared.providerId && candidate.ref.modelId === shared.modelId)).toHaveLength(1);
  });

  it('does not treat a missing price component as zero', () => {
    const target = ref('provider-incomplete', 'model-incomplete');
    const decision = decide(policyInput([target], models(model(target.providerId, target.modelId, rates(1, undefined))), { workload: { input: 1000, output: 100 } }));
    expect(decision.ordered[0]?.estimate).toMatchObject({ kind: 'unknown' });
  });
});

describe('routing billing preference', () => {
  it('uses billing metadata for subscription-first preference, independent of credential type', () => {
    const subscription = ref('subscription-provider', 'same-model');
    const metered = ref('metered-provider', 'same-model');
    const catalog = models(
      model(subscription.providerId, subscription.modelId, rates(90, 90), { upstreamModelId: 'discovered-model', billing: { kind: 'subscription' }, credential: { available: true, kind: 'api_key' } }),
      model(metered.providerId, metered.modelId, rates(1, 1), { upstreamModelId: 'discovered-model', billing: { kind: 'metered' }, credential: { available: true, kind: 'oauth' } }),
    );
    const config = { enabled: true, subscriptionPreference: 'subscription-first', categories: { review: { target: metered, servingAlternatives: [subscription] } } };
    const decision = decide({ ...policyInput([metered], catalog), config, category: 'review' });
    expect(decision.target).toEqual(subscription);
  });

  it('uses billing metadata for api-first preference, independent of credential type', () => {
    const subscription = ref('subscription-provider', 'same-model');
    const metered = ref('metered-provider', 'same-model');
    const catalog = models(
      model(subscription.providerId, subscription.modelId, rates(1, 1), { upstreamModelId: 'discovered-model', billing: { kind: 'subscription' }, credential: { available: true, kind: 'api_key' } }),
      model(metered.providerId, metered.modelId, rates(90, 90), { upstreamModelId: 'discovered-model', billing: { kind: 'metered' }, credential: { available: true, kind: 'oauth' } }),
    );
    const config = { enabled: true, subscriptionPreference: 'api-first', categories: { review: { target: subscription, servingAlternatives: [metered] } } };
    const decision = decide({ ...policyInput([subscription], catalog), config, category: 'review' });
    expect(decision.target).toMatchObject(metered);
  });

  it('keeps the configured target when an alternative has a different upstream identity', () => {
    const target = ref('metered-provider', 'same-model');
    const subscription = ref('subscription-provider', 'same-model');
    const catalog = models(
      model(target.providerId, target.modelId, rates(1, 1), { upstreamModelId: 'target-upstream', billing: { kind: 'metered' } }),
      model(subscription.providerId, subscription.modelId, rates(90, 90), { upstreamModelId: 'different-upstream', billing: { kind: 'subscription' } }),
    );
    const config = { enabled: true, subscriptionPreference: 'subscription-first', categories: { review: { target, servingAlternatives: [subscription] } } };
    const decision = decide({ ...policyInput([target], catalog), config, category: 'review' });
    expect(decision.target).toEqual(target);
  });
});
