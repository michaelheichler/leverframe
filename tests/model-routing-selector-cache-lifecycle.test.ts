import { dirname, relative, sep } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildRoutingCatalog } from '../src/model-routing.js';
import { startHttpProxy } from '../src/http-proxy/server.js';
import { httpProxyModelId } from '../src/http-proxy/routes.js';
import { routingBindingStatePath } from '../src/routing-bindings.js';
import type { ModelRef } from '../src/model-routing.js';
import type { RoutingControlContext } from '../src/proxy-routing-control.js';
import { decideRouting } from '../src/routing-policy.js';
import { ROUTING_SIGNATURE_VERSION, routingSelectorCandidateVersion } from '../src/routing-selector-versions.js';
import type { SelectorPayload } from '../src/routing-selector.js';
import { RoutingSelectorCache } from '../src/routing-selector-cache.js';
import { input, observation, provider } from './model-routing-fixtures.js';
import { prepareAndLaunch } from './fixtures/model-routing-handoff-control.js';

const pool = [
  { providerId: 'selector-cache-pool-a', modelId: 'selector-cache-model-a' },
  { providerId: 'selector-cache-pool-b', modelId: 'selector-cache-model-b' },
];
const selectorTarget = { providerId: 'selector-cache-provider', modelId: 'selector-cache-model' };
const proxyToken = 'selector-cache-fixture-token';
const testHome = process.env['LEVERFRAME_TEST_HOME'];

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function modelProvider(ref: ModelRef, price: number) {
  return provider({
    id: ref.providerId,
    templateId: 'fixture',
    billing: { kind: 'metered', source: 'fixture-billing', observedAt: '2026-10-01T00:00:00.000Z' },
    modelsCache: {
      fetchedAt: '2026-10-01T00:00:00.000Z', source: 'account', models: [{
        id: ref.modelId,
        name: ref.modelId,
        upstreamModelId: `upstream-${ref.modelId}`,
        modelFormat: 'anthropic',
        contextWindow: 70_000,
        outputTokenLimit: 8_192,
        supportedParameters: ['tools'],
        supportedReasoningEfforts: ['low'],
        pricing: { input: price, output: price, source: 'fixture-pricing' },
      }],
    },
  });
}

function selectorContext(selectorTransport: RoutingControlContext['selectorTransport']): RoutingControlContext {
  const providers = [modelProvider(pool[0]!, 10), modelProvider(pool[1]!, 10), modelProvider(selectorTarget, 0.01)];
  const catalog = buildRoutingCatalog(input(providers, {
    credentials: providers.map(item => observation(item.id)),
    discovery: providers.map(item => ({ providerId: item.id, status: 'live' as const, cacheFetchedAt: '2026-10-01T00:00:00.000Z' })),
  }));
  const config: RoutingControlContext['config'] = {
    enabled: true,
    cheapFallback: pool[0],
    pool,
    categories: { implementation: { effort: 'low' } },
    selector: { enabled: true, target: selectorTarget, maxExtraCallsPerTask: 1, maxOutputTokens: 24, evaluationEvidence: [] },
  };
  const decision = decideRouting({ config, catalog, role: 'specialist', category: 'implementation', effort: 'low',
    workload: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 } });
  config.selector!.evaluationEvidence = [{
    category: 'implementation',
    effort: 'low',
    candidateSetVersion: routingSelectorCandidateVersion({ decision, catalog, category: 'implementation', effort: 'low' }),
    signatureVersion: ROUTING_SIGNATURE_VERSION,
    sampleSize: 3,
    sourceEvaluationId: 'fixture-selector-evaluation',
    measuredAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2027-10-01T00:00:00.000Z',
    avoidedTokens: { input: 500, output: 100 },
  }];
  return { proxyToken, config, catalog, workload: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 }, selectorTransport };
}

async function startSelectorServer(selectorTransport: RoutingControlContext['selectorTransport']) {
  const context = selectorContext(selectorTransport);
  const { proxyToken: _token, ...routing } = context;
  const proxy = await startHttpProxy({
    routes: [], routing, proxyAuthToken: proxyToken,
    resolveClaudeCodeAuth: async () => { throw new Error('Native auth is not used by this provider-only fixture.'); },
  });
  return { proxy, endpoint: `http://${proxy.host}:${proxy.port}/v1/leverframe/routing-launch`, context };
}

async function launch(endpoint: string, context: RoutingControlContext, sessionId: string, launchId: string) {
  expect(testHome).toBeTruthy();
  expect(inside(testHome!, dirname(routingBindingStatePath(sessionId)))).toBe(true);
  return prepareAndLaunch(endpoint, context, {
    sessionId, launchId, agentType: 'reviewer', category: 'implementation', effort: 'low',
    task: 'Review the same selector-cache fixture', selectorEvidence: {
      features: { size: 'small', turns: 'few', tools: 'none', recentFailures: 0 },
      workload: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
      selectorWorkload: { input: 500, output: 24, cacheRead: 0, cacheWrite: 0 },
    },
  });
}

it('reuses a session selector decision on one running proxy', async () => {
  const call = vi.fn(async (_target: ModelRef, _payload: SelectorPayload, _signal: AbortSignal) => pool[1]!);
  const { proxy, endpoint, context } = await startSelectorServer(call);

  try {
    const first = await launch(endpoint, context, 'selector-cache-same-owner', 'same-owner-launch-a');
    const second = await launch(endpoint, context, 'selector-cache-same-owner', 'same-owner-launch-b');

    expect(first.preparation.status).toBe(200);
    expect(second.preparation.status).toBe(200);
    expect(first.launch.status).toBe(200);
    expect(second.launch.status).toBe(200);
    expect(first.launch.body['policyModelId']).toBe(httpProxyModelId(pool[1]!.providerId, pool[1]!.modelId));
    expect(second.launch.body['policyModelId']).toBe(first.launch.body['policyModelId']);
    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0]?.[2].aborted).toBe(false);
  } finally {
    await proxy.close();
  }
});

it('isolates selector results between proxy owners for the same session and signature', async () => {
  const firstCall = vi.fn(async () => pool[1]!);
  const secondCall = vi.fn(async () => pool[0]!);
  const firstServer = await startSelectorServer(firstCall);
  const secondServer = await startSelectorServer(secondCall);

  try {
    const first = await launch(firstServer.endpoint, firstServer.context, 'selector-cache-two-owners', 'owner-a-launch');
    const second = await launch(secondServer.endpoint, secondServer.context, 'selector-cache-two-owners', 'owner-b-launch');

    expect(first.preparation.status).toBe(200);
    expect(second.preparation.status).toBe(200);
    expect(first.launch.status).toBe(200);
    expect(second.launch.status).toBe(200);
    expect(first.launch.body['policyModelId']).toBe(httpProxyModelId(pool[1]!.providerId, pool[1]!.modelId));
    expect(second.launch.body['policyModelId']).toBe(httpProxyModelId(pool[0]!.providerId, pool[0]!.modelId));
    expect(firstCall).toHaveBeenCalledOnce();
    expect(secondCall).toHaveBeenCalledOnce();
  } finally {
    await Promise.all([firstServer.proxy.close(), secondServer.proxy.close()]);
  }
});

it('clears expired selector entries without waiting for another launch', async () => {
  const cache = new RoutingSelectorCache();
  const now = Date.now();
  const entries = cache.forSession('selector-cache-expiry', now + 40, now);
  entries.set('task-signature', Promise.resolve(pool[0]!));

  try {
    await new Promise(resolve => setTimeout(resolve, 80));

    expect(entries.size).toBe(0);
  } finally {
    cache.dispose();
  }
});

it('aborts a pending selector when its proxy closes', async () => {
  let enteredSelector: () => void = () => {};
  const entered = new Promise<void>(resolve => { enteredSelector = resolve; });
  let observedSignal: AbortSignal | undefined;
  const call = vi.fn((_target: ModelRef, _payload: SelectorPayload, signal: AbortSignal) => new Promise<ModelRef>((_resolve, reject) => {
    observedSignal = signal;
    enteredSelector();
    signal.addEventListener('abort', () => reject(new Error('Selector owner closed.')), { once: true });
  }));
  const { proxy, endpoint, context } = await startSelectorServer(call);
  const pendingResponse = launch(endpoint, context, 'selector-cache-close-owner', 'pending-owner-launch').then(
    () => true,
    () => false,
  );

  await entered;
  await proxy.close();

  expect(observedSignal?.aborted).toBe(true);
  expect(await pendingResponse).toBe(false);
  expect(call).toHaveBeenCalledOnce();
});

it('disposes a selector cache idempotently and rejects later session access', () => {
  const cache = new RoutingSelectorCache();
  const entries = cache.forSession('selector-cache-disposed', Date.now() + 60_000, Date.now());
  entries.set('task-signature', Promise.resolve(pool[0]!));
  const signal = cache.signal;

  cache.dispose();
  cache.dispose();

  expect(signal.aborted).toBe(true);
  expect(entries.size).toBe(0);
  expect(() => cache.forSession('selector-cache-disposed', Date.now() + 60_000, Date.now())).toThrow();
});
