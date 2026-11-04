import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

const credential = vi.hoisted(() => ({
  resolveProviderAccountAuth: vi.fn(async () => ({ apiKey: 'fixture-provider-key' })),
}));

vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  resolveProviderAccountAuth: credential.resolveProviderAccountAuth,
}));

import { createRoutingBinding, resolveRoutingBinding, routingBindingErrors, routingBindingStatePath } from '../src/routing-bindings.js';
import * as requestPolicy from '../src/context/request-policy.js';
import type { ModelRef } from '../src/model-routing.js';
import type { RoutingControlContext } from '../src/proxy-routing-control.js';
import {
  acknowledgment,
  assertIsolatedRoutingSession,
  createBoundRoutingJob,
  acknowledgeLaunchNotice,
  nativeRoutingContext,
  readNoticeSequence,
  registerConsumer,
  requestJson,
  sdkRoutingContext,
  sendBoundRequest,
  startNativeService,
  startSdkService,
} from './fixtures/model-routing-proxy.js';

const sdkTarget = { providerId: 'fixture-control-provider', modelId: 'fixture-control-model' };

function blockDefaultFetch(): void {
  vi.stubGlobal('fetch', async () => { throw new Error('Default fetch is disabled in native transport fixtures.'); });
}

afterEach(() => {
  vi.unstubAllGlobals();
  credential.resolveProviderAccountAuth.mockClear();
});

it('sends a bound SDK child to its upstream model and returns the binding identity', async () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  assertIsolatedRoutingSession(sessionId);
  const service = await startSdkService(endpoint => sdkRoutingContext(undefined, endpoint));
  const context = service.context;
  const binding = await createBoundRoutingJob(context, sessionId, 'launch-sdk-bound-request');
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, binding.id);
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, consumerId, service.proxy.token, notices);
    const response = await request;

    expect(response.body.raw).toBeUndefined();
    expect(response.body.error).toBeUndefined();
    expect(response.status).toContain('200');
    expect(service.upstreamBodies[0]?.model).toBe('fixture-upstream-model');
    expect(service.upstreamBodies[0]?.model).not.toBe(binding.id);
    expect(service.upstreamBodies[0]?.reasoning_effort).toBe('low');
    expect(response.body.model).toBe(binding.id);
    const updated = await resolveRoutingBinding({ sessionId, modelId: binding.id });
    expect(updated.id).toBe(binding.id);
    expect(updated.revision).toBe(binding.revision);
    expect(updated.decision.target).toEqual(binding.decision.target);
    expect(updated.decision.reason).toBe(binding.decision.reason);
    expect(updated.decision.estimate.amount).toBeGreaterThan(0);
  } finally {
    notices?.close();
    await service.close();
  }
}, 20_000);

it('dispatches through the eligible identity when a stale duplicate is unavailable', async () => {
  const sessionId = '10101010-1010-4010-8010-101010101010';
  assertIsolatedRoutingSession(sessionId);
  const service = await startSdkService(endpoint => {
    const context = sdkRoutingContext(undefined, endpoint);
    const eligible = context.catalog.models[0]!;
    const stale = { ...eligible, upstreamModelId: 'stale-duplicate-upstream',
      credential: { ...eligible.credential, available: false } };
    context.catalog = { ...context.catalog, models: [eligible, stale] };
    return context;
  });
  const eligible = service.context.catalog.models[0]!;
  const binding = await createBoundRoutingJob(service.context, sessionId, 'launch-eligible-duplicate');
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, binding.id);
    const launch = await notices.nextNotice();
    expect(launch.notice).toMatchObject({ kind: 'launch', sessionId, acknowledged: false });
    expect(service.upstreamBodies).toHaveLength(0);
    expect(credential.resolveProviderAccountAuth).not.toHaveBeenCalled();
    const launchAck = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(launch.notice, consumerId));
    expect(launchAck).toMatchObject({ status: 200, body: { acknowledged: true } });
    const response = await request;
    const restored = await resolveRoutingBinding({ sessionId, modelId: binding.id });

    expect(response.status, JSON.stringify(response.body)).toContain('200');
    expect(service.upstreamBodies).toHaveLength(1);
    expect(service.upstreamBodies[0]?.model).toBe(eligible.upstreamModelId);
    expect(response.body.model).toBe(binding.id);
    expect(binding.identity.upstreamModelId).toBe(eligible.upstreamModelId);
    expect(restored.decision.target).toEqual(binding.decision.target);
    expect(restored.decision.effort).toBe(binding.decision.effort);
    expect(restored.identity).toEqual(binding.identity);
    expect(restored.revision).toBe(binding.revision);
  } finally {
    notices?.close();
    await service.close();
  }
}, 20_000);

it('omits UI and route default effort for an SDK binding with no selected effort', async () => {
  const sessionId = '15151515-1515-4515-8515-151515151515';
  assertIsolatedRoutingSession(sessionId);
  const service = await startSdkService(endpoint => {
    const base = sdkRoutingContext(undefined, endpoint, { providerNpm: '@ai-sdk/google', modelNpm: '@ai-sdk/google' });
    return { ...base,
      catalog: { ...base.catalog, models: base.catalog.models.map(model => ({ ...model,
        supportedReasoningEfforts: ['low', 'medium', 'high'] })) },
      config: { ...base.config, categories: { implementation: { target: sdkTarget } } } };
  }, [], { npm: '@ai-sdk/google', defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high'] });
  const binding = await createBoundRoutingJob(service.context, sessionId, 'launch-sdk-without-selected-effort');
  expect(binding.decision.effort).toBeUndefined();
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, binding.id, 'high', {}, {
      output_config: { effort: 'high', vendor_hint: 'preserve' },
      thinking: { type: 'enabled', budget_tokens: 1024 },
      system: [{ type: 'text', text: 'Keep this cached system instruction', cache_control: { type: 'ephemeral' } }],
      cache_control: { type: 'ephemeral' },
      cache_control_metadata: { source: 'fixture' },
    });
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, consumerId, service.proxy.token, notices);
    const response = await request;

    expect(response.status, JSON.stringify(response.body)).toContain('200');
    const generation = service.upstreamBodies[0]?.generationConfig as Record<string, unknown> | undefined;
    const thinking = generation?.thinkingConfig as Record<string, unknown> | undefined;
    expect(thinking?.thinkingLevel).toBeUndefined();
    expect(thinking).toMatchObject({ includeThoughts: true });
    expect(service.upstreamBodies[0]?.systemInstruction).toMatchObject({
      parts: [expect.objectContaining({ text: 'Keep this cached system instruction' })],
    });
  } finally {
    notices?.close();
    await service.close();
  }
}, 20_000);

it('removes only the UI effort from a native binding without selected effort', async () => {
  const sessionId = '16161616-1616-4616-8616-161616161616';
  const context = nativeRoutingContext();
  context.config = { ...context.config, categories: { implementation: { target: context.routerTarget! } } };
  assertIsolatedRoutingSession(sessionId);
  const binding = await createBoundRoutingJob(context, sessionId, 'launch-native-without-selected-effort');
  expect(binding.decision.effort).toBeUndefined();
  blockDefaultFetch();
  const service = await startNativeService(context, { injectNativeRoutingFetch: true });
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, binding.id, 'high', {}, {
      output_config: { effort: 'high', vendor_hint: 'preserve' },
      thinking: { type: 'enabled', budget_tokens: 1024 },
      system: [{ type: 'text', text: 'Keep native system content', cache_control: { type: 'ephemeral' } }],
      cache_control: { type: 'ephemeral' },
      cache_control_metadata: { source: 'fixture' },
    });
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, consumerId, service.proxy.token, notices);
    const response = await request;

    expect(response.status, JSON.stringify(response.body)).toContain('200');
    expect(service.observation.body?.output_config).toEqual({ vendor_hint: 'preserve' });
    expect(service.observation.body?.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(service.observation.body?.system).toEqual([{ type: 'text', text: 'Keep native system content',
      cache_control: { type: 'ephemeral' } }]);
    expect(service.observation.body?.cache_control).toEqual({ type: 'ephemeral' });
    expect(service.observation.body?.cache_control_metadata).toEqual({ source: 'fixture' });
    expect(service.observation.credentialReads).toBe(1);
  } finally {
    notices?.close();
    await service.close();
  }
}, 20_000);

it('returns an abandoned lease error through the bound SDK proxy without replaying inference', async () => {
  const sessionId = '14141414-1414-4414-8414-141414141414';
  assertIsolatedRoutingSession(sessionId);
  const service = await startSdkService(endpoint => sdkRoutingContext(undefined, endpoint));
  const binding = await createBoundRoutingJob(service.context, sessionId, 'launch-abandoned-proxy-request');
  const statePath = routingBindingStatePath(sessionId);
  const originalState = readFileSync(statePath, 'utf8');
  const abandonedLease = 'fixture-proxy-lease-with-unknown-outcome';
  const abandonedOwner = 2_147_483_647;
  const state = JSON.parse(originalState) as { bindings: Array<Record<string, unknown>> };
  state.bindings[0]!['lease'] = abandonedLease;
  state.bindings[0]!['leaseOwner'] = abandonedOwner;
  const processKill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
  });

  try {
    assertIsolatedRoutingSession(sessionId);
    writeFileSync(statePath, JSON.stringify(state), 'utf8');
    const response = await sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, binding.id, 'low');

    expect(response.status).toContain('400');
    expect(response.body).toMatchObject({ error: { code: 'routing_lease_abandoned' } });
    expect(response.body.error).toMatchObject({ message: expect.stringMatching(/known outcome|unknown.*outcome|outcome.*unknown/i) });
    expect(service.upstreamBodies).toHaveLength(0);
    expect(processKill).toHaveBeenCalledOnce();
    expect(processKill).toHaveBeenCalledWith(abandonedOwner, 0);
    const retainedState = JSON.parse(readFileSync(statePath, 'utf8')) as { bindings: Array<Record<string, unknown>> };
    expect(retainedState.bindings[0]).toMatchObject({
      id: binding.id,
      lease: abandonedLease,
      leaseOwner: abandonedOwner,
      decision: { target: binding.decision.target, reason: binding.decision.reason, effort: binding.decision.effort },
    });
  } finally {
    processKill.mockRestore();
    assertIsolatedRoutingSession(sessionId);
    writeFileSync(statePath, originalState, 'utf8');
    await service.close();
  }
}, 20_000);

it('rejects a non-pooled bound route whose upstream identity changed before provider dispatch', async () => {
  const sessionId = '12121212-1212-4212-8212-121212121212';
  assertIsolatedRoutingSession(sessionId);
  const service = await startSdkService(endpoint => sdkRoutingContext(undefined, endpoint), [
    { ...sdkTarget, upstreamModelId: 'fixture-route-drift-model' },
  ]);
  const context = service.context;
  const binding = await createBoundRoutingJob(context, sessionId, 'launch-route-identity-drift');
  let notices: ReturnType<typeof readNoticeSequence> | undefined;
  const applyPolicy = vi.spyOn(requestPolicy, 'applyRequestContextPolicy');

  try {
    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, binding.id, 'low');
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, consumerId, service.proxy.token, notices);
    const response = await request;

    expect(response.status).toContain('400');
    expect({ error: response.body.error, credentialLookups: credential.resolveProviderAccountAuth.mock.calls.length,
      providerRequests: service.upstreamBodies.length, policyCalls: applyPolicy.mock.calls.length }).toMatchObject({
      error: { code: routingBindingErrors.identityMismatch }, credentialLookups: 0, providerRequests: 0, policyCalls: 0,
    });
  } finally {
    applyPolicy.mockRestore();
    notices?.close();
    await service.close();
  }
}, 20_000);

it('rejects a non-pooled bound route whose effective endpoint changed before provider dispatch', async () => {
  const sessionId = '13131313-1313-4313-8313-131313131313';
  assertIsolatedRoutingSession(sessionId);
  const service = await startSdkService(endpoint => sdkRoutingContext(undefined, endpoint), endpoint => [{
    ...sdkTarget,
    upstreamModelId: 'fixture-upstream-model',
    baseURL: `${endpoint}/alternate`,
    upstreamUrl: `${endpoint}/alternate/chat/completions`,
    npm: '@ai-sdk/openai-compatible',
    modelFormat: 'openai',
  }]);
  const binding = await createBoundRoutingJob(service.context, sessionId, 'launch-endpoint-identity-drift');
  let notices: ReturnType<typeof readNoticeSequence> | undefined;
  const applyPolicy = vi.spyOn(requestPolicy, 'applyRequestContextPolicy');

  try {
    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, binding.id, 'low');
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, consumerId, service.proxy.token, notices);
    const response = await request;

    expect(response.status).toContain('400');
    expect({ error: response.body.error, credentialLookups: credential.resolveProviderAccountAuth.mock.calls.length,
      providerRequests: service.upstreamBodies.length, policyCalls: applyPolicy.mock.calls.length }).toMatchObject({
      error: { code: routingBindingErrors.identityMismatch }, credentialLookups: 0, providerRequests: 0, policyCalls: 0,
    });
  } finally {
    applyPolicy.mockRestore();
    notices?.close();
    await service.close();
  }
}, 20_000);

it('routes the visible auto model through the SDK and keeps auto in the client response', async () => {
  const sessionId = '33333333-3333-4333-8333-333333333333';
  assertIsolatedRoutingSession(sessionId);
  const service = await startSdkService(endpoint => sdkRoutingContext('auto', endpoint));
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, 'auto', 'low');
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, consumerId, service.proxy.token, notices);
    const response = await request;

    expect(response.body.raw).toBeUndefined();
    expect(response.body.error).toBeUndefined();
    expect(response.status).toContain('200');
    expect(service.upstreamBodies[0]?.model).toBe('fixture-upstream-model');
    expect(response.body.model).toBe('auto');
  } finally {
    notices?.close();
    await service.close();
  }
}, 20_000);

it('rejects a restored router binding that differs from the frozen target before provider dispatch', async () => {
  const sessionId = '66666666-6666-4666-8666-666666666666';
  assertIsolatedRoutingSession(sessionId);
  let context!: RoutingControlContext & { routerTarget?: ModelRef };
  const priorTarget = { providerId: 'fixture-prior-router-provider', modelId: 'fixture-prior-router-model' };
  const service = await startSdkService(endpoint => {
    context = sdkRoutingContext('auto', endpoint) as RoutingControlContext & { routerTarget?: ModelRef };
    const priorCatalogModel = context.catalog.models[0]!;
    context.catalog = { ...context.catalog, models: [...context.catalog.models,
      { ...priorCatalogModel, ref: priorTarget, upstreamModelId: 'fixture-prior-router-upstream' }] };
    context.config = { ...context.config, pool: [sdkTarget, priorTarget] };
    context.routerTarget = sdkTarget;
    return context;
  }, [{ ...priorTarget, upstreamModelId: 'fixture-prior-router-upstream' }]);
  const persisted = await createRoutingBinding({
    sessionId,
    launchId: 'front-router',
    role: 'router',
    task: '',
    config: { ...context.config, cheapFallback: priorTarget, pool: [priorTarget] },
    catalog: context.catalog,
    workload: context.workload,
  });
  expect(persisted.decision.target).toEqual(priorTarget);

  try {
    const response = await sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, 'auto');

    expect(response.status).toContain('409');
    expect(response.body).toMatchObject({ error: { code: routingBindingErrors.routerPinMismatch } });
    expect(service.upstreamBodies).toHaveLength(0);
  } finally {
    await service.close();
  }
}, 20_000);

it('rejects visible auto requests when the proxy has no preflight router target', async () => {
  const sessionId = '88888888-8888-4888-8888-888888888888';
  assertIsolatedRoutingSession(sessionId);
  const service = await startSdkService(endpoint => {
    const context = sdkRoutingContext('auto', endpoint);
    delete context.routerTarget;
    return context;
  });

  try {
    const response = await sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, 'auto');

    expect(response.status).toContain('409');
    expect(response.body).toMatchObject({ error: { code: routingBindingErrors.routerPinMismatch } });
    expect(service.upstreamBodies).toHaveLength(0);
  } finally {
    await service.close();
  }
}, 20_000);

it('uses metadata child session identity without a header and ignores its parent identity', async () => {
  const metadataSessionId = '99999999-9999-4999-8999-999999999999';
  const headerSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assertIsolatedRoutingSession(metadataSessionId);
  assertIsolatedRoutingSession(headerSessionId);
  const priorTarget = { providerId: 'fixture-metadata-router-provider', modelId: 'fixture-metadata-router-model' };
  let context!: RoutingControlContext;
  const service = await startSdkService(endpoint => {
    context = sdkRoutingContext('auto', endpoint);
    const priorCatalogModel = context.catalog.models[0]!;
    context.catalog = { ...context.catalog, models: [...context.catalog.models,
      { ...priorCatalogModel, ref: priorTarget, upstreamModelId: 'fixture-metadata-router-upstream' }] };
    return context;
  }, [{ ...priorTarget, upstreamModelId: 'fixture-metadata-router-upstream' }]);
  const persisted = await createRoutingBinding({
    sessionId: metadataSessionId,
    launchId: 'front-router',
    role: 'router',
    task: '',
    config: { ...context.config, cheapFallback: priorTarget, pool: [priorTarget] },
    catalog: context.catalog,
    workload: context.workload,
  });
  expect(persisted.decision.target).toEqual(priorTarget);

  try {
    const response = await sendBoundRequest(service.proxy, service.certificates.caCert, headerSessionId, 'auto', 'low', {}, {
      metadata: { user_id: JSON.stringify({ session_id: metadataSessionId, parent_session_id: headerSessionId }) },
    }, true);

    expect(response).toMatchObject({ status: expect.stringContaining('409'),
      body: { error: { code: routingBindingErrors.routerPinMismatch } } });
    expect(service.upstreamBodies).toHaveLength(0);
  } finally {
    await service.close();
  }
}, 20_000);

it('reuses the pinned front-router binding across requests in one restored session', async () => {
  const sessionId = '77777777-7777-4777-8777-777777777777';
  assertIsolatedRoutingSession(sessionId);
  const service = await startSdkService(endpoint => sdkRoutingContext('auto', endpoint));
  const context = service.context;
  const routerLaunch = {
    sessionId,
    launchId: 'front-router',
    role: 'router' as const,
    task: '',
    config: context.config,
    catalog: context.catalog,
    workload: context.workload,
  };
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const firstRequest = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, 'auto', 'low');
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, consumerId, service.proxy.token, notices);
    const firstResponse = await firstRequest;
    const firstBinding = await createRoutingBinding(routerLaunch);
    const completed = await notices.nextNotice();
    expect(completed.notice).toMatchObject({ kind: 'request_completed', sessionId, modelId: firstBinding.id,
      revision: firstBinding.revision, reason: 'request_completed', target: context.routerTarget, acknowledged: false });
    const completionAck = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(completed.notice, consumerId));
    expect(completionAck).toMatchObject({ status: 200, body: { acknowledged: true } });
    const resumedRequest = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, 'auto', 'low');
    const resumedCompletion = await notices.nextNotice();
    expect(resumedCompletion.notice).toMatchObject({ kind: 'request_completed', sessionId, modelId: firstBinding.id,
      revision: firstBinding.revision, reason: 'request_completed', target: context.routerTarget, acknowledged: false });
    const resumedCompletionAck = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(resumedCompletion.notice, consumerId));
    expect(resumedCompletionAck).toMatchObject({ status: 200, body: { acknowledged: true } });
    const resumedResponse = await resumedRequest;
    const resumedBinding = await createRoutingBinding(routerLaunch);

    expect(firstResponse.body.model).toBe('auto');
    expect(resumedResponse.body.model).toBe('auto');
    expect(firstBinding.id).toBe(resumedBinding.id);
    expect(firstBinding.decision.target).toEqual(context.routerTarget);
    expect(resumedBinding.decision.target).toEqual(context.routerTarget);
    expect(service.upstreamBodies).toHaveLength(2);
    expect(service.upstreamBodies.map(body => body.model)).toEqual(['fixture-upstream-model', 'fixture-upstream-model']);
  } finally {
    notices?.close();
    await service.close();
  }
}, 20_000);

it('sends a bound native Claude child to the sourced upstream model with injected credentials', async () => {
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const context = nativeRoutingContext();
  assertIsolatedRoutingSession(sessionId);
  const binding = await createBoundRoutingJob(context, sessionId, 'launch-native-bound-request');
  blockDefaultFetch();
  const service = await startNativeService(context, { injectNativeRoutingFetch: true });
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, binding.id);
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, consumerId, service.proxy.token, notices);
    const response = await request;

    expect(response.body.raw).toBeUndefined();
    expect(response.body.error).toBeUndefined();
    expect(response.status).toContain('200');
    expect(service.observation.body?.model).toBe('claude-fixture-upstream-model');
    expect(service.observation.body?.model).not.toBe(binding.id);
    expect(service.observation.body?.output_config).toEqual({ effort: 'low' });
    expect(service.observation.authorization).toBe('Bearer fixture-native-token');
    expect(service.observation.session).toBe(sessionId);
    expect(service.observation.credentialReads).toBe(1);
    expect(response.body.model).toBe(binding.id);
    const updated = await resolveRoutingBinding({ sessionId, modelId: binding.id });
    expect(updated.revision).toBe(binding.revision);
    expect(updated.decision.target).toEqual(binding.decision.target);
    expect(updated.decision.reason).toBe(binding.decision.reason);
    expect(updated.decision.estimate.amount).toBeGreaterThan(0);
  } finally {
    notices?.close();
    await service.close();
  }
}, 20_000);

const nativeOriginRejectionCases = [
  { label: 'without a fetch injection', options: { anthropicOrigin: 'http://127.0.0.1:43123' } },
  { label: 'even with a fetch injection', options: { anthropicOrigin: 'http://127.0.0.1:43123', injectNativeRoutingFetch: true } },
];

it.each(nativeOriginRejectionCases)('rejects a noncanonical native origin $label before credential lookup', async ({ options }) => {
  const sessionId = '23232323-2323-4323-8323-232323232323';
  const context = nativeRoutingContext();
  assertIsolatedRoutingSession(sessionId);
  const binding = await createBoundRoutingJob(context, sessionId, 'launch-native-origin-without-transport');
  blockDefaultFetch();
  const service = await startNativeService(context, options);

  try {
    const response = await sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, binding.id, 'low');

    expect(response.status).toContain('400');
    expect(service.observation.credentialReads).toBe(0);
    expect(service.observation.nativeFetchCalls).toBe(0);
    expect(service.observation.body).toBeUndefined();
  } finally {
    await service.close();
  }
}, 20_000);

it('rejects an absolute bound request target that overrides the Anthropic origin before auth', async () => {
  const sessionId = '24242424-2424-4424-8424-242424242424';
  const context = nativeRoutingContext();
  assertIsolatedRoutingSession(sessionId);
  const binding = await createBoundRoutingJob(context, sessionId, 'launch-native-absolute-origin');
  blockDefaultFetch();
  const service = await startNativeService(context, { injectNativeRoutingFetch: true });

  try {
    const response = await sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, binding.id, 'low', {}, {}, false,
      'https://attacker.invalid/v1/messages');

    expect(response.status).toContain('400');
    expect(service.observation.credentialReads).toBe(0);
    expect(service.observation.nativeFetchCalls).toBe(0);
    expect(service.observation.body).toBeUndefined();
  } finally {
    await service.close();
  }
}, 20_000);

it('preserves an ordered duplicate query on a canonical native request while rewriting only model and effort', async () => {
  const sessionId = '25252525-2525-4525-8525-252525252525';
  const context = nativeRoutingContext();
  assertIsolatedRoutingSession(sessionId);
  const binding = await createBoundRoutingJob(context, sessionId, 'launch-native-query-preservation');
  blockDefaultFetch();
  const service = await startNativeService(context, { injectNativeRoutingFetch: true });
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, binding.id, 'low', {}, {
      metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
      cache_control_metadata: { source: 'fixture' },
    }, false, '/v1/messages?beta=true&beta=false');
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, consumerId, service.proxy.token, notices);
    const response = await request;

    expect(response.status).toContain('200');
    expect(service.observation.requestUrl).toBe('/v1/messages?beta=true&beta=false');
    expect(service.observation.body?.model).toBe('claude-fixture-upstream-model');
    expect(service.observation.body?.output_config).toEqual({ effort: 'low' });
    expect(service.observation.body?.max_tokens).toBe(80);
    expect(service.observation.body?.cache_control_metadata).toEqual({ source: 'fixture' });
    expect(response.body.model).toBe(binding.id);
  } finally {
    notices?.close();
    await service.close();
  }
}, 20_000);

it('routes the visible auto model through native Claude and echoes auto to the client', async () => {
  const context = nativeRoutingContext('auto');
  const sessionId = '44444444-4444-4444-8444-444444444444';
  assertIsolatedRoutingSession(sessionId);
  blockDefaultFetch();
  const service = await startNativeService(context, { injectNativeRoutingFetch: true });
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, 'auto', 'low');
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, consumerId, service.proxy.token, notices);
    const response = await request;

    expect(response.body.raw).toBeUndefined();
    expect(response.body.error).toBeUndefined();
    expect(response.status).toContain('200');
    expect(service.observation.body?.model).toBe('claude-fixture-upstream-model');
    expect(service.observation.authorization).toBe('Bearer fixture-native-token');
    expect(response.body.model).toBe('auto');
  } finally {
    notices?.close();
    await service.close();
  }
}, 20_000);

it('preserves native OAuth headers, cache controls, and binding echo in a streaming request', async () => {
  const sessionId = '55555555-5555-4555-8555-555555555555';
  const context = nativeRoutingContext();
  assertIsolatedRoutingSession(sessionId);
  const binding = await createBoundRoutingJob(context, sessionId, 'launch-native-streaming');
  blockDefaultFetch();
  const service = await startNativeService(context, { injectNativeRoutingFetch: true });
  const cacheControl = { type: 'ephemeral', ttl: '1h' };
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const request = sendBoundRequest(
      service.proxy,
      service.certificates.caCert,
      sessionId,
      binding.id,
      'low',
      {
        'Anthropic-Beta': 'fixture-beta-feature',
        'Anthropic-Version': 'fixture-version',
        'X-Fixture-Client': 'fixture-preserved-header',
      },
      {
        stream: true,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Cached prefix', cache_control: cacheControl }] }],
      },
    );
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, consumerId, service.proxy.token, notices);
    const response = await request;

    expect(response.status).toContain('200');
    expect(service.observation.body?.model).toBe('claude-fixture-upstream-model');
    expect(service.observation.body?.messages).toEqual([{
      role: 'user', content: [{ type: 'text', text: 'Cached prefix', cache_control: cacheControl }],
    }]);
    expect(service.observation.beta).toMatch(/^oauth-[^,]+,fixture-beta-feature$/);
    expect(service.observation.version).toBe('fixture-version');
    expect(service.observation.customHeader).toBe('fixture-preserved-header');
    expect(service.observation.session).toBe(sessionId);
    expect(service.observation.authorization).toBe('Bearer fixture-native-token');
    expect(response.body.raw).toContain(`"model":"${binding.id}"`);
    const updated = await resolveRoutingBinding({ sessionId, modelId: binding.id });
    expect(updated.revision).toBe(binding.revision);
    expect(updated.decision.target).toEqual(binding.decision.target);
    expect(updated.decision.reason).toBe(binding.decision.reason);
    expect(updated.decision.estimate.amount).toBeUndefined();
  } finally {
    notices?.close();
    await service.close();
  }
}, 20_000);
