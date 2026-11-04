import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  resolveProviderAccountAuth: vi.fn(async (providerId: string, account: { id: string }) =>
    providerId.startsWith('fixture-') && account.id === 'default'
      ? { apiKey: 'fixture-recovery-fallback-key' }
      : Promise.reject(new Error('Unexpected provider credential lookup.'))),
}));
import { resolveProviderAccountAuth } from '../src/env.js';
import { buildRoutingCatalog } from '../src/model-routing.js';
import { resolveRoutingBinding } from '../src/routing-bindings.js';
import type { RoutingControlContext } from '../src/proxy-routing-control.js';
import { acknowledgment, acknowledgeLaunchNotice, blockNonLoopbackFetch, isolatedSessionId, noticeOrResponse,
  readNoticeSequence, registerConsumer, requestJson, safeResponseSummary, sdkRoutingContext, sendBoundRequest,
  startSdkService } from './fixtures/model-routing-proxy.js';
import type { ConnectedNoticeStream } from './fixtures/model-routing-proxy.js';
import { prepareAndLaunch } from './fixtures/model-routing-handoff-control.js';
import { input, observation, provider } from './model-routing-fixtures.js';

const fallbackRef = { providerId: 'fixture-native-recovery-fallback-provider', modelId: 'fixture-native-recovery-fallback-model' };
const fallbackUpstreamModel = 'fixture-native-recovery-fallback-upstream';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(resolveProviderAccountAuth).mockClear();
});

async function startNativeCredentialMissingRecoveryService(observed: { nativeCredentialReads: number; nativeFetchCalls: number }) {
  return startSdkService(endpoint => {
    const nativeRef = { providerId: 'anthropic', modelId: 'claude-fixture-subscription-model' };
    const fetchedAt = '2026-10-01T00:00:00.000Z';
    const nativeProvider = provider({
      id: nativeRef.providerId,
      templateId: 'anthropic',
      credentialSource: 'claude-code',
      billing: { kind: 'subscription', source: 'fixture-plan', observedAt: fetchedAt },
      modelsCache: { fetchedAt, source: 'harness', models: [{ id: nativeRef.modelId, name: nativeRef.modelId,
        upstreamModelId: 'claude-fixture-upstream-model', modelFormat: 'anthropic', contextWindow: 70_000,
        outputTokenLimit: 12_000, supportedParameters: ['tools'], supportedReasoningEfforts: ['low'],
        pricing: { input: 2, output: 8, source: 'fixture-pricing', observedAt: fetchedAt } }] },
    });
    const catalog = buildRoutingCatalog(input([nativeProvider], {
      credentials: [observation(nativeProvider.id, 'oauth')],
      discovery: [{ providerId: nativeProvider.id, status: 'live', cacheFetchedAt: fetchedAt }],
    }));
    const context: RoutingControlContext = {
      proxyToken: 'fixture-proxy-token',
      routerTarget: nativeRef,
      config: { enabled: true, visibleModelId: 'auto', cheapFallback: nativeRef, pool: [nativeRef],
        categories: { implementation: { target: nativeRef, effort: 'low' } } },
      catalog,
      workload: { cacheRead: 0, cacheWrite: 0 },
    };
    const nativeModel = context.catalog.models[0]!;
    const fallbackContext = sdkRoutingContext(undefined, endpoint, { providerId: fallbackRef.providerId,
      modelId: fallbackRef.modelId, upstreamModelId: fallbackUpstreamModel });
    const fallbackModel = fallbackContext.catalog.models[0]!;
    fallbackModel.capabilities = { ...fallbackModel.capabilities, tools: true };
    fallbackModel.confirmedCapabilities = [...fallbackModel.confirmedCapabilities, 'tools'];
    context.catalog = { ...context.catalog, models: [nativeModel, fallbackModel] };
    context.config = { ...context.config, categories: { implementation: { target: nativeModel.ref, effort: 'low',
      fallbacks: [{ ...fallbackRef, effort: 'low' }] } } };
    return context;
  }, _endpoint => [{ ...fallbackRef, upstreamModelId: fallbackUpstreamModel,
    npm: '@ai-sdk/openai-compatible', modelFormat: 'openai' }], {}, undefined, undefined, {
    fetchForEndpoint: () => async () => {
      observed.nativeFetchCalls++;
      throw new Error('Native transport must not start without credentials.');
    },
    resolveClaudeCodeAuth: async () => {
      observed.nativeCredentialReads++;
      return null;
    },
  });
}

it('recovers a verifiable native binding through acknowledged credential-missing fallback', async () => {
  blockNonLoopbackFetch();
  const sessionId = isolatedSessionId();
  const observed = { nativeCredentialReads: 0, nativeFetchCalls: 0 };
  const service = await startNativeCredentialMissingRecoveryService(observed);
  const origin = `http://${service.proxy.host}:${service.proxy.port}`;
  let connected: ConnectedNoticeStream | undefined;
  let notices: ReturnType<typeof readNoticeSequence> | undefined;
  let request: Promise<Awaited<ReturnType<typeof sendBoundRequest>>> = Promise.resolve({ status: '', body: {} });

  try {
    const { preparation, launch } = await prepareAndLaunch(`${origin}/v1/leverframe/routing-launch`, service.context, {
      sessionId, launchId: 'launch-recoverable-native-credential-loss', agentType: 'reviewer', category: 'implementation',
      effort: 'low', task: 'Continue the saved native review using its authorized alternative if needed',
    });
    const accepted = launch.body as { modelId: string; policyModelId: string; revision: number };
    const binding = await resolveRoutingBinding({ sessionId, modelId: accepted.modelId });
    const recovered = await requestJson(service.proxy.port, '/v1/leverframe/routing-recovery', service.proxy.token, {
      sessionId, launchId: 'launch-recoverable-native-credential-loss', sidecarValid: true,
      agentType: 'reviewer', marker: binding.modelId,
    });

    expect(preparation.status).toBe(200);
    expect(launch.status, JSON.stringify(launch.body)).toBe(200);
    expect(binding.identity.credentialSource).toBe('claude-code');
    expect(recovered).toMatchObject({ status: 200, body: { kind: 'bound', modelId: binding.modelId,
      policyModelId: binding.identity.upstreamModelId } });
    const restored = await resolveRoutingBinding({ sessionId, modelId: binding.modelId });
    expect(restored.revision).toBe(binding.revision);
    expect(restored.decision.target).toEqual(binding.decision.target);
    expect(restored.identity).toEqual(binding.identity);

    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    connected = await notices.connected;
    expect(consumer.status).toBe(200);
    expect(connected.status).toBe(200);
    vi.mocked(resolveProviderAccountAuth).mockClear();
    request = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, binding.modelId, 'low');
    await acknowledgeLaunchNotice(service.proxy.port, sessionId, consumerId, service.proxy.token, notices);
    const observedFallback = await noticeOrResponse(notices.nextNotice(), request);
    const fallbackNotice = observedFallback.stream!;
    const stateAfterAttempt = await resolveRoutingBinding({ sessionId, modelId: binding.modelId });

    expect(observedFallback.kind, JSON.stringify({ ...safeResponseSummary(observedFallback),
      events: stateAfterAttempt.decision.events })).toBe('notice');
    expect(fallbackNotice.notice).toMatchObject({ sessionId, previous: binding.decision.target,
      target: fallbackRef, reason: 'credential_missing', cacheReuse: 'unknown', acknowledged: false });
    expect(observed.nativeCredentialReads).toBe(1);
    expect(observed.nativeFetchCalls).toBe(0);
    expect(service.upstreamBodies).toEqual([]);
    expect(vi.mocked(resolveProviderAccountAuth)).not.toHaveBeenCalled();
    const pending = await resolveRoutingBinding({ sessionId, modelId: binding.modelId });
    expect(pending).toMatchObject({ revision: fallbackNotice.notice.revision, pendingNotice: fallbackNotice.notice,
      decision: { target: fallbackRef } });

    const acknowledged = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(fallbackNotice.notice, consumerId));
    const response = await request;
    const transitioned = await resolveRoutingBinding({ sessionId, modelId: binding.modelId });

    expect(acknowledged).toMatchObject({ status: 200, body: { acknowledged: true } });
    expect(response.status).toContain('200');
    expect(service.upstreamBodies).toHaveLength(1);
    expect(service.upstreamBodies[0]?.model).toBe(fallbackUpstreamModel);
    expect(observed.nativeFetchCalls).toBe(0);
    expect(vi.mocked(resolveProviderAccountAuth).mock.calls.map(([providerId, account]) => [providerId, account.id]))
      .toEqual([[fallbackRef.providerId, 'default']]);
    expect(transitioned.decision.target).toEqual(fallbackRef);
    expect(transitioned.identity.credentialSource).toBe('registry');
    expect(transitioned.revision).toBe(pending.revision);
  } finally {
    notices?.close();
    connected?.close();
    await connected?.closed;
    await Promise.allSettled([request]);
    await service.close();
  }
}, 20_000);
