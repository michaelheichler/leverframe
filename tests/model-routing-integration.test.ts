import { dirname, relative, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildRoutingCatalog, projectRoutingPromptPolicy } from '../src/model-routing.js';
import { ROUTING_LAUNCH_ACTION, ROUTING_PREPARE_ACTION } from '../src/constants.js';
import { getAppHome } from '../src/paths.js';
import { startHttpProxy } from '../src/http-proxy/server.js';
import { httpProxyModelId } from '../src/http-proxy/routes.js';
import { routingBindingStatePath, resolveRoutingBinding } from '../src/routing-bindings.js';
import type { RoutingControlContext } from '../src/proxy-routing-control.js';
import { input, observation, provider } from './model-routing-fixtures.js';
import { acknowledgment, isolatedSessionId, nativeRoutingContext, noticeOrResponse,
  readNoticeSequence, registerConsumer, requestJson, sendBoundRequest, sdkRoutingContext, startSdkService } from './fixtures/model-routing-proxy.js';
import { prepareAndLaunch } from './fixtures/model-routing-handoff-control.js';

const target = { providerId: 'fixture-control-provider', modelId: 'fixture-control-model' };
const proxyToken = 'fixture-proxy-token';
const testHome = process.env['LEVERFRAME_TEST_HOME'];

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function controlContext(): RoutingControlContext {
  const registeredProvider = provider({
    id: target.providerId,
    templateId: 'fixture',
    billing: { kind: 'metered', source: 'fixture-billing', observedAt: '2026-10-01T00:00:00.000Z' },
    modelsCache: {
      fetchedAt: '2026-10-01T00:00:00.000Z',
      source: 'account',
      models: [{
        id: target.modelId,
        name: target.modelId,
        upstreamModelId: 'fixture-upstream-model',
        modelFormat: 'anthropic',
        contextWindow: 70_000,
        outputTokenLimit: 8_192,
        supportedReasoningEfforts: ['low'],
        pricing: { input: 2, output: 8, source: 'fixture-pricing' },
      }],
    },
  });
  const snapshot = input([registeredProvider], {
    credentials: [observation(registeredProvider.id)],
    discovery: [{ providerId: registeredProvider.id, status: 'live', cacheFetchedAt: '2026-10-01T00:00:00.000Z' }],
  });
  return {
    proxyToken,
    config: {
      enabled: true,
      cheapFallback: target,
      pool: [target],
      categories: { implementation: { target, effort: 'low' } },
    },
    catalog: buildRoutingCatalog(snapshot),
    workload: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
  };
}

async function startControlServer(context: RoutingControlContext) {
  const { proxyToken: _proxyToken, ...routing } = context;
  const proxy = await startHttpProxy({ routes: [], routing, proxyAuthToken: proxyToken });
  return { proxy, origin: `http://${proxy.host}:${proxy.port}` };
}

function assertSessionStateIsIsolated(sessionId: string): void {
  expect(testHome).toBeTruthy();
  expect(isInside(testHome!, getAppHome())).toBe(true);
  expect(isInside(testHome!, dirname(routingBindingStatePath(sessionId)))).toBe(true);
}


it('launches a host-selected binding over the authenticated loopback control endpoint', async () => {
  const sessionId = 'session-routing-control';
  assertSessionStateIsIsolated(sessionId);
  const context = controlContext();
  context.catalog.models[0]!.capabilities = { ...context.catalog.models[0]!.capabilities, tools: true };
  context.catalog.models[0]!.confirmedCapabilities = [...context.catalog.models[0]!.confirmedCapabilities, 'tools'];
  const { proxy, origin } = await startControlServer(context);

  try {
    const { preparation, launch } = await prepareAndLaunch(`${origin}/v1/leverframe/routing-launch`, context, {
      sessionId, launchId: 'launch-through-control', agentType: 'reviewer', category: 'implementation',
      effort: 'low', task: 'Review the integration fixture',
      clientConfig: { enabled: true, categories: { implementation: { target: { providerId: 'attacker', modelId: 'model' } } } },
    });
    const clientBinding = launch.body as {
      modelId: string; policyModelId: string; effort?: string; contextWindow?: number; revision: number;
    };
    const binding = await resolveRoutingBinding({ sessionId, modelId: clientBinding.modelId });

    expect(preparation.status).toBe(200);
    expect(launch.status).toBe(200);
    expect(clientBinding.modelId).not.toBe(target.modelId);
    expect(clientBinding.policyModelId).toBe(httpProxyModelId(target.providerId, target.modelId));
    expect(clientBinding.modelId).not.toBe(clientBinding.policyModelId);
    expect(clientBinding).toMatchObject({ effort: 'low', contextWindow: 70_000, revision: 1 });
    expect(binding.decision.target).toEqual(target);
    expect(binding.decision.effort).toBe('low');
  } finally {
    await proxy.close();
  }
});

it('rejects an unauthenticated launch before parsing its request body', async () => {
  const { proxy, origin } = await startControlServer(controlContext());

  try {
    const response = await fetch(`${origin}/v1/leverframe/routing-launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(response.status).toBe(401);
  } finally {
    await proxy.close();
  }
});

it('returns a discovered native upstream identity separately from its binding ID', async () => {
  const sessionId = 'session-native-control-identity';
  assertSessionStateIsIsolated(sessionId);
  const context = nativeRoutingContext();
  context.catalog.models[0]!.capabilities = { ...context.catalog.models[0]!.capabilities, tools: true };
  context.catalog.models[0]!.confirmedCapabilities = [...context.catalog.models[0]!.confirmedCapabilities, 'tools'];
  const nativeModel = context.catalog.models.find(model => model.ref.providerId === context.routerTarget?.providerId
    && model.ref.modelId === context.routerTarget?.modelId);
  const { proxy, origin } = await startControlServer(context);

  try {
    const { preparation, launch } = await prepareAndLaunch(`${origin}/v1/leverframe/routing-launch`, context, {
      sessionId, launchId: 'launch-native-control', agentType: 'reviewer', category: 'implementation',
      effort: 'low', task: 'Use native policy identity',
    });
    const result = launch.body as { modelId: string; policyModelId: string };

    expect(preparation.status).toBe(200);
    expect(launch.status).toBe(200);
    expect(result.policyModelId).toBe(nativeModel?.upstreamModelId);
    expect(result.modelId).not.toBe(result.policyModelId);
  } finally {
    await proxy.close();
  }
});

it('uses the eligible identity row when stale metadata shares the selected native model reference', async () => {
  const sessionId = 'session-native-control-row-selection';
  assertSessionStateIsIsolated(sessionId);
  const context = nativeRoutingContext();
  context.catalog.models[0]!.capabilities = { ...context.catalog.models[0]!.capabilities, tools: true };
  context.catalog.models[0]!.confirmedCapabilities = [...context.catalog.models[0]!.confirmedCapabilities, 'tools'];
  const eligible = context.catalog.models[0]!;
  context.catalog = { ...context.catalog, models: [
    { ...eligible, upstreamModelId: 'stale-native-upstream', credential: { ...eligible.credential, available: false } },
    eligible,
  ] };
  const { proxy, origin } = await startControlServer(context);

  try {
    const { preparation, launch } = await prepareAndLaunch(`${origin}/v1/leverframe/routing-launch`, context, {
      sessionId, launchId: 'launch-native-valid-row', agentType: 'reviewer', category: 'implementation',
      effort: 'low', task: 'Resolve valid native identity',
    });
    const result = launch.body as { policyModelId: string };

    expect(preparation.status).toBe(200);
    expect(launch.status, JSON.stringify(launch.body)).toBe(200);
    expect(result.policyModelId).toBe(eligible.upstreamModelId);
  } finally {
    await proxy.close();
  }
});

it('selects a confirmed capable pool model through the authenticated launch endpoint', async () => {
  const sessionId = 'session-control-category-requirements';
  assertSessionStateIsIsolated(sessionId);
  const cheap = { providerId: 'fixture-cheap-limited-provider', modelId: 'fixture-cheap-limited-model' };
  const eligible = { providerId: 'fixture-capable-provider', modelId: 'fixture-capable-model' };
  const providers = [
    provider({ id: cheap.providerId, templateId: 'fixture', modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z',
      source: 'account', models: [{ id: cheap.modelId, name: cheap.modelId, upstreamModelId: 'cheap-limited-upstream',
        modelFormat: 'anthropic', contextWindow: 24_000, outputTokenLimit: 4_000, supportedParameters: ['tools'], vision: false,
        supportedReasoningEfforts: ['low'], pricing: { input: 0.1, output: 0.2, source: 'fixture-pricing' } }] } }),
    provider({ id: eligible.providerId, templateId: 'fixture', modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z',
      source: 'account', models: [{ id: eligible.modelId, name: eligible.modelId, upstreamModelId: 'eligible-upstream',
        modelFormat: 'anthropic', contextWindow: 96_000, outputTokenLimit: 12_000, supportedParameters: ['tools'], vision: true,
        supportedReasoningEfforts: ['low'], pricing: { input: 8, output: 24, source: 'fixture-pricing' } }] } }),
  ];
  const snapshot = input(providers, {
    credentials: providers.map(item => observation(item.id)),
    discovery: providers.map(item => ({ providerId: item.id, status: 'live' as const, cacheFetchedAt: '2026-10-01T00:00:00.000Z' })),
  });
  const context: RoutingControlContext = {
    proxyToken,
    config: { enabled: true, cheapFallback: eligible, pool: [cheap, eligible], categories: {
      implementation: { effort: 'low', requirements: { capabilities: ['images'], contextTokens: 60_000 } },
    } },
    catalog: buildRoutingCatalog(snapshot),
    workload: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
  };
  const { proxy, origin } = await startControlServer(context);

  try {
    const { preparation, launch } = await prepareAndLaunch(`${origin}/v1/leverframe/routing-launch`, context, {
      sessionId, launchId: 'launch-capable-pool-model', agentType: 'reviewer', category: 'implementation',
      effort: 'low', task: 'Select a model with confirmed image and context support',
      clientConfig: { requirements: { capabilities: ['websocket'], contextTokens: 999_999 }, requirementsFromConfig: true },
    });
    const clientBinding = launch.body as { modelId: string; policyModelId: string; revision: number };
    const binding = await resolveRoutingBinding({ sessionId, modelId: clientBinding.modelId });

    expect(preparation.status).toBe(200);
    expect(launch.status, JSON.stringify(launch.body)).toBe(200);
    expect(clientBinding.policyModelId).toBe(httpProxyModelId(eligible.providerId, eligible.modelId));
    expect(binding.decision.target).toEqual(eligible);
    expect(binding.requirements).toMatchObject({ capabilities: ['tools', 'images'], contextTokens: 60_000, requireExternalBounds: true });
  } finally {
    await proxy.close();
  }
});

it('uses host requirements when a launch payload supplies forged requirement metadata', async () => {
  const sessionId = 'session-control-forged-requirements';
  assertSessionStateIsIsolated(sessionId);
  const context = controlContext();
  context.catalog.models[0]!.capabilities = { ...context.catalog.models[0]!.capabilities, tools: true, images: true };
  context.catalog.models[0]!.confirmedCapabilities = ['tools', 'images'];
  context.catalog.models[0]!.contextWindowConfirmed = true;
  context.catalog.models[0]!.maxOutputTokens = 8_192;
  context.config.categories = { implementation: { target, effort: 'low', requirements: {
    capabilities: ['images'], contextTokens: 40_000,
  } } };
  const { proxy, origin } = await startControlServer(context);

  try {
    const task = 'Use the authenticated host policy for specialist requirements';
    const policy = projectRoutingPromptPolicy(context.config);
    const handoff = { version: 1, originalTask: task, requiredConstraints: [], toolInstructions: [], evidence: [], jobState: '' };
    const preparationResponse = await fetch(`${origin}/v1/leverframe/routing-launch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxyToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: ROUTING_PREPARE_ACTION, version: 1, policy, agentType: 'reviewer',
        category: 'implementation', delegatedTask: task, originalTask: task,
        requiredConstraints: [], toolInstructions: [], evidence: [], jobState: '' }),
    });
    const prepared = await preparationResponse.json() as { prompt: string };
    const launchResponse = await fetch(`${origin}/v1/leverframe/routing-launch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxyToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: ROUTING_LAUNCH_ACTION, sessionId, launchId: 'launch-forged-requirements',
        role: 'specialist', agentType: 'reviewer', category: 'implementation', effort: 'low',
        task: prepared.prompt, resume: false, originalPrompt: prepared.prompt, delegatedTask: task, handoff, policy,
        requirements: { capabilities: ['websocket'], contextTokens: 999_999 }, requirementsFromConfig: true }),
    });
    const launched = await launchResponse.json() as { modelId: string; policyModelId: string };
    const binding = await resolveRoutingBinding({ sessionId, modelId: launched.modelId });

    expect(preparationResponse.status).toBe(200);
    expect(launchResponse.status, JSON.stringify(launched)).toBe(200);
    expect(launched.policyModelId).toBe(httpProxyModelId(target.providerId, target.modelId));
    expect(binding.requirements).toMatchObject({ capabilities: ['tools', 'images'], contextTokens: 40_000, requireExternalBounds: true });
  } finally {
    await proxy.close();
  }
});

it('reuses the accepted binding when server category requirements change on an identical launch retry', async () => {
  const sessionId = 'session-control-category-requirements-retry';
  assertSessionStateIsIsolated(sessionId);
  const context = controlContext();
  context.catalog.models[0]!.capabilities = { ...context.catalog.models[0]!.capabilities, tools: true, images: true, reasoning: true };
  context.catalog.models[0]!.confirmedCapabilities = ['tools', 'images', 'reasoning'];
  context.catalog.models[0]!.contextWindowConfirmed = true;
  context.catalog.models[0]!.maxOutputTokens = 8_192;
  const requirements: { capabilities: ('images' | 'reasoning')[]; contextTokens: number } = {
    capabilities: ['images'], contextTokens: 20_000,
  };
  context.config.categories = { implementation: { effort: 'low', requirements } };
  const { proxy, origin } = await startControlServer(context);

  try {
    const launchInput = { sessionId, launchId: 'launch-requirements-retry', agentType: 'reviewer', category: 'implementation',
      effort: 'low', task: 'Retry the same reviewed specialist launch' };
    const first = await prepareAndLaunch(`${origin}/v1/leverframe/routing-launch`, context, launchInput);
    const firstResult = first.launch.body as { modelId: string; policyModelId: string; effort: string; revision: number };
    const firstBinding = await resolveRoutingBinding({ sessionId, modelId: firstResult.modelId });
    requirements.capabilities = ['reasoning'];
    requirements.contextTokens = 30_000;
    const retry = await prepareAndLaunch(`${origin}/v1/leverframe/routing-launch`, context, launchInput);
    const retryResult = retry.launch.body as { modelId: string; policyModelId: string; effort: string; revision: number };
    const retryBinding = await resolveRoutingBinding({ sessionId, modelId: retryResult.modelId });

    expect(first.preparation.status).toBe(200);
    expect(first.launch.status, JSON.stringify(first.launch.body)).toBe(200);
    expect(retry.preparation.status).toBe(200);
    expect(retry.launch.status, JSON.stringify(retry.launch.body)).toBe(200);
    expect(retryResult).toEqual(firstResult);
    expect(retryBinding.decision).toEqual(firstBinding.decision);
    expect(retryBinding.requirements).toEqual(firstBinding.requirements);
    expect(retryBinding.requirements).toMatchObject({ capabilities: ['tools', 'images'], contextTokens: 20_000, requireExternalBounds: true });
  } finally {
    await proxy.close();
  }
});

it('uses changed category requirements for a fresh authenticated launch', async () => {
  const sessionId = 'session-control-category-requirements-fresh';
  assertSessionStateIsIsolated(sessionId);
  const context = controlContext();
  context.catalog.models[0]!.capabilities = { ...context.catalog.models[0]!.capabilities, tools: true, images: true, reasoning: true };
  context.catalog.models[0]!.confirmedCapabilities = ['tools', 'images', 'reasoning'];
  context.catalog.models[0]!.contextWindowConfirmed = true;
  context.catalog.models[0]!.maxOutputTokens = 8_192;
  const requirements: { capabilities: ('images' | 'reasoning')[]; contextTokens: number } = {
    capabilities: ['images'], contextTokens: 20_000,
  };
  context.config.categories = { implementation: { effort: 'low', requirements } };
  const { proxy, origin } = await startControlServer(context);

  try {
    requirements.capabilities = ['reasoning'];
    requirements.contextTokens = 30_000;
    const { preparation, launch } = await prepareAndLaunch(`${origin}/v1/leverframe/routing-launch`, context, {
      sessionId, launchId: 'launch-new-requirements', agentType: 'reviewer', category: 'implementation',
      effort: 'low', task: 'Apply the current category requirements to this new launch',
    });
    const result = launch.body as { modelId: string; policyModelId: string };
    const binding = await resolveRoutingBinding({ sessionId, modelId: result.modelId });

    expect(preparation.status).toBe(200);
    expect(launch.status, JSON.stringify(launch.body)).toBe(200);
    expect(result.policyModelId).toBe(httpProxyModelId(target.providerId, target.modelId));
    expect(binding.requirements).toMatchObject({ capabilities: ['tools', 'reasoning'], contextTokens: 30_000, requireExternalBounds: true });
  } finally {
    await proxy.close();
  }
});

it('keeps saved category requirements on authenticated resume after configuration changes', async () => {
  const sessionId = 'session-control-requirements-resume';
  assertSessionStateIsIsolated(sessionId);
  const context = controlContext();
  context.catalog.models[0]!.capabilities = { ...context.catalog.models[0]!.capabilities, tools: true, images: true, reasoning: true };
  context.catalog.models[0]!.confirmedCapabilities = ['tools', 'images', 'reasoning'];
  context.catalog.models[0]!.contextWindowConfirmed = true;
  context.catalog.models[0]!.maxOutputTokens = 8_192;
  const requirements: { capabilities: ('images' | 'reasoning')[]; contextTokens: number } = {
    capabilities: ['images'], contextTokens: 20_000,
  };
  context.config.categories = { implementation: { effort: 'low', requirements } };
  const { proxy, origin } = await startControlServer(context);

  try {
    const launchInput = { sessionId, launchId: 'launch-requirements-resume', agentType: 'reviewer', category: 'implementation',
      effort: 'low', task: 'Resume the accepted specialist under its original requirements' };
    const first = await prepareAndLaunch(`${origin}/v1/leverframe/routing-launch`, context, launchInput);
    const firstResult = first.launch.body as { modelId: string; policyModelId: string; effort: string; revision: number };
    const firstBinding = await resolveRoutingBinding({ sessionId, modelId: firstResult.modelId });
    requirements.capabilities = ['reasoning'];
    requirements.contextTokens = 30_000;
    const resumeResponse = await fetch(`${origin}/v1/leverframe/routing-launch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxyToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, launchId: launchInput.launchId, role: 'specialist', agentType: 'reviewer',
        category: 'implementation', effort: 'low', task: first.preparation.body.prompt, resume: true }),
    });
    const resumedResult = await resumeResponse.json() as { modelId: string; policyModelId: string; effort: string; revision: number };
    const resumedBinding = await resolveRoutingBinding({ sessionId, modelId: resumedResult.modelId });

    expect(first.preparation.status).toBe(200);
    expect(first.launch.status, JSON.stringify(first.launch.body)).toBe(200);
    expect(resumeResponse.status, JSON.stringify(resumedResult)).toBe(200);
    expect(resumedResult).toMatchObject({ ...firstResult, handoff: firstBinding.handoff });
    expect(resumedBinding.decision).toEqual(firstBinding.decision);
    expect(resumedBinding.requirements).toEqual(firstBinding.requirements);
    expect(resumedBinding.requirements).toMatchObject({ capabilities: ['tools', 'images'], contextTokens: 20_000, requireExternalBounds: true });
  } finally {
    await proxy.close();
  }
});

it('keeps an automatic external launch on a candidate with confirmed context and output bounds', async () => {
  const sessionId = 'session-control-external-bounds';
  assertSessionStateIsIsolated(sessionId);
  const missingOutputBound = { providerId: 'fixture-unbounded-provider', modelId: 'fixture-unbounded-model' };
  const bounded = { providerId: 'fixture-bounded-provider', modelId: 'fixture-bounded-model' };
  const providers = [
    provider({ id: missingOutputBound.providerId, templateId: 'fixture', modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z',
      source: 'account', models: [{ id: missingOutputBound.modelId, name: missingOutputBound.modelId,
        upstreamModelId: 'unbounded-upstream', modelFormat: 'anthropic', contextWindow: 96_000, supportedParameters: ['tools'],
        supportedReasoningEfforts: ['low'], pricing: { input: 0.1, output: 0.2, source: 'fixture-pricing' } }] } }),
    provider({ id: bounded.providerId, templateId: 'fixture', modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z',
      source: 'account', models: [{ id: bounded.modelId, name: bounded.modelId, upstreamModelId: 'bounded-upstream',
        modelFormat: 'anthropic', contextWindow: 96_000, outputTokenLimit: 12_000, supportedParameters: ['tools'],
        supportedReasoningEfforts: ['low'], pricing: { input: 8, output: 24, source: 'fixture-pricing' } }] } }),
  ];
  const snapshot = input(providers, {
    credentials: providers.map(item => observation(item.id)),
    discovery: providers.map(item => ({ providerId: item.id, status: 'live' as const, cacheFetchedAt: '2026-10-01T00:00:00.000Z' })),
  });
  const context: RoutingControlContext = {
    proxyToken,
    config: { enabled: true, cheapFallback: bounded, pool: [missingOutputBound, bounded],
      categories: { implementation: { effort: 'low' } } },
    catalog: buildRoutingCatalog(snapshot),
    workload: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
  };
  const { proxy, origin } = await startControlServer(context);

  try {
    const { preparation, launch } = await prepareAndLaunch(`${origin}/v1/leverframe/routing-launch`, context, {
      sessionId, launchId: 'launch-bounded-external-model', agentType: 'reviewer', category: 'implementation',
      effort: 'low', task: 'Choose an external model with confirmed request limits',
    });

    expect(preparation.status).toBe(200);
    expect(launch.status, JSON.stringify(launch.body)).toBe(200);
    const clientBinding = launch.body as { modelId: string; policyModelId: string };
    const binding = await resolveRoutingBinding({ sessionId, modelId: clientBinding.modelId });

    expect(clientBinding.policyModelId).toBe(httpProxyModelId(bounded.providerId, bounded.modelId));
    expect(binding.decision.target).toEqual(bounded);
    expect(binding.requirements).toMatchObject({ capabilities: ['tools'], requireExternalBounds: true });
  } finally {
    await proxy.close();
  }
});

it('rejects an explicitly selected external model without confirmed limits before persisting a binding', async () => {
  const sessionId = 'session-control-unbounded-explicit-target';
  assertSessionStateIsIsolated(sessionId);
  const unbounded = { providerId: 'fixture-explicit-unbounded-provider', modelId: 'fixture-explicit-unbounded-model' };
  const registered = provider({ id: unbounded.providerId, templateId: 'fixture', modelsCache: {
    fetchedAt: '2026-10-01T00:00:00.000Z', source: 'account', models: [{ id: unbounded.modelId, name: unbounded.modelId,
      upstreamModelId: 'explicit-unbounded-upstream', modelFormat: 'anthropic', contextWindow: 64_000,
      supportedParameters: ['tools'], supportedReasoningEfforts: ['low'],
      pricing: { input: 2, output: 8, source: 'fixture-pricing' } }],
  } });
  const context: RoutingControlContext = {
    proxyToken,
    config: { enabled: true, cheapFallback: unbounded, pool: [unbounded],
      categories: { implementation: { target: unbounded, effort: 'low' } } },
    catalog: buildRoutingCatalog(input([registered], {
      credentials: [observation(registered.id)],
      discovery: [{ providerId: registered.id, status: 'live', cacheFetchedAt: '2026-10-01T00:00:00.000Z' }],
    })),
    workload: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
  };
  const { proxy, origin } = await startControlServer(context);

  try {
    const { preparation, launch } = await prepareAndLaunch(`${origin}/v1/leverframe/routing-launch`, context, {
      sessionId, launchId: 'launch-explicit-unbounded-target', agentType: 'reviewer', category: 'implementation',
      effort: 'low', task: 'Keep an explicit external target with unknown output limits out of saved work',
    });

    expect(preparation.status).toBe(200);
    expect(launch.status).toBe(400);
    expect(launch.body).toMatchObject({ error: { code: 'routing_ineligible_target' } });
    expect(existsSync(routingBindingStatePath(sessionId))).toBe(false);
  } finally {
    await proxy.close();
  }
});

it('rejects a stricter request before dispatch while retaining the accepted binding', async () => {
  const sessionId = isolatedSessionId();
  const service = await startSdkService(endpoint => {
    const context = sdkRoutingContext(undefined, endpoint, { providerId: 'fixture-context-provider',
      modelId: 'fixture-context-limited-model', upstreamModelId: 'fixture-context-limited-upstream' });
    const model = context.catalog.models[0]!;
    model.capabilities = { ...model.capabilities, tools: true };
    model.confirmedCapabilities = [...model.confirmedCapabilities, 'tools'];
    model.contextWindow = 16_000;
    model.contextWindowConfirmed = true;
    model.maxOutputTokens = 13_000;
    context.config = { ...context.config, categories: { implementation: { target: context.routerTarget,
      effort: 'low', requirements: { contextTokens: 1_000 } } } };
    return context;
  });
  const origin = `http://${service.proxy.host}:${service.proxy.port}`;
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const { preparation, launch } = await prepareAndLaunch(`${origin}/v1/leverframe/routing-launch`, service.context, {
      sessionId, launchId: 'launch-context-limited-model', agentType: 'reviewer', category: 'implementation',
      effort: 'low', task: 'Respect the accepted specialist context limit',
    });
    expect(preparation.status).toBe(200);
    expect(launch.status, JSON.stringify(launch.body)).toBe(200);
    const accepted = launch.body as { modelId: string; policyModelId: string; effort: string; revision: number };
    const binding = await resolveRoutingBinding({ sessionId, modelId: accepted.modelId });
    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    expect(consumer.status).toBe(200);
    notices = readNoticeSequence(service.proxy.port, sessionId, String(consumer.body.consumerId), service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, accepted.modelId, 'low', {}, {
      max_tokens: 12_000, messages: [{ role: 'user', content: 'Review this context-bound request. '.repeat(300) }],
    });
    const observed = await noticeOrResponse(notices.nextNotice(), request);
    expect(observed.kind, JSON.stringify(observed.response?.body)).toBe('notice');
    expect(observed.stream!.notice).toMatchObject({ kind: 'launch', sessionId, acknowledged: false });
    const launchAck = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(observed.stream!.notice, String(consumer.body.consumerId)));
    expect(launchAck).toMatchObject({ status: 200, body: { acknowledged: true } });
    const response = await request;
    const after = await resolveRoutingBinding({ sessionId, modelId: accepted.modelId });

    expect(response.status).toContain('400');
    expect(response.body).toMatchObject({ error: { type: 'invalid_request_error',
      message: expect.stringContaining('context limit') } });
    expect(service.upstreamBodies).toEqual([]);
    expect(after).toMatchObject({ id: binding.id, revision: binding.revision, identity: binding.identity,
      decision: binding.decision, requirements: binding.requirements });
  } finally {
    notices?.close();
    await service.close();
  }
});
