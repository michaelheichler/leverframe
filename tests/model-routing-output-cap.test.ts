import { afterEach, expect, it, vi } from 'vitest';

const credential = vi.hoisted(() => ({
  resolveProviderAccountAuth: vi.fn(async () => ({ apiKey: 'fixture-provider-key' })),
}));

vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  resolveProviderAccountAuth: credential.resolveProviderAccountAuth,
}));

import { runInNewContext } from 'node:vm';
import { applyRoutingPatchComposition } from '../src/patch-transforms-routing-composition.js';
import {
  acknowledgeLaunchNotice,
  assertIsolatedRoutingSession,
  createBoundRoutingJob,
  nativeRoutingContext,
  readNoticeSequence,
  registerConsumer,
  sdkRoutingContext,
  sendBoundRequest,
  startNativeService,
  startSdkService,
} from './fixtures/model-routing-proxy.js';
import { claudeAgentRoutingNoticeCompositionSource } from './fixtures/claude-agent-2.1.314-routing-composition.js';
import { ROUTING_TEST_PROMPT_POLICY, routingHandoffSchemaGlobals } from './fixtures/claude-agent-2.1.314-routing.js';

const outputLimit = 64;
const sdkSessionAbove = '17171717-1717-4717-8717-171717171717';
const sdkSessionAt = '18181818-1818-4818-8818-181818181818';
const nativeSessionAbove = '19191919-1919-4919-8919-191919191919';
const nativeSessionAt = '20202020-2020-4020-8020-202020202020';

function blockDefaultFetch(): void {
  vi.stubGlobal('fetch', async () => { throw new Error('Default fetch is disabled in native output-cap fixtures.'); });
}

afterEach(() => vi.unstubAllGlobals());

interface SourcedRequest {
  model: string;
  max_tokens: number;
  metadata: Record<string, unknown>;
  effort: string;
  thinking?: unknown;
  contextWindow: number;
  agentContext: Record<string, unknown>;
}

function sourcedNativeRequest(maxOutputTokens?: number) {
  const policyModelId = 'claude-native-output-cap-model';
  const bindingId = 'opaque-output-cap-binding';
  const nativeMetadata = {
    [policyModelId]: { id: policyModelId, context_window: 50_000,
      runtime: { max_input_tokens: 50_000, ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }), effort_levels: ['low'] } },
  };
  const source = claudeAgentRoutingNoticeCompositionSource();
  const transformed = applyRoutingPatchComposition(source, 'auto', {
    routingEnabled: true,
    routingPolicyModelId: 'leverframe:front:router',
    routingPromptPolicy: ROUTING_TEST_PROMPT_POLICY,
    routingMetadata: { contextWindow: 90_000, maxOutputTokens: 12_000, supportedReasoningEfforts: ['low'] },
    routingTargetMetadata: {},
  });
  expect(transformed.results.some(result => result.status === 'FAIL')).toBe(false);
  const executable = transformed.content.replace(/import\{[^}]+\}from"[^"]+";/g, '')
    .replace(/export\{[^}]+\};/g, '');
  let metadataLookup: ((model: string) => Record<string, unknown> | undefined) | undefined;
  const sent = vi.fn((request: SourcedRequest) => request);
  const functions = runInNewContext(executable + '\n;({buildRequest,yUe})', {
    ...routingHandoffSchemaGlobals(),
    process: { env: {} },
    Die: () => [],
    gOe: () => false,
    e3: () => false,
    uV: () => false,
    pV: () => undefined,
    lr: () => ({ availableModels: ['leverframe:front:router'] }),
    wK: () => false,
    Qdt: () => ({ kind: 'model' }),
    Dt: (value: string) => value.trim().toLowerCase(),
    v_: () => false,
    Pw: () => null,
    dr: () => false,
    beo: () => true,
    Rw: (model: string) => model,
    Se: () => ({ modelOverrides: {} }),
    Cge: () => ({}),
    HTn: (model: string) => model,
    hso: () => false,
    yK: () => false,
    kK: () => false,
    bK: () => false,
    HS: () => false,
    tos: () => null,
    s8t: (tools: unknown[]) => tools,
    gt: {},
    zP: (model: string) => model,
    hV: (model: string) => model,
    sG: (model: string) => model,
    jn: (model: string) => model,
    D0: {},
    cG: () => undefined,
    Xy: (_catalog: unknown, models: string[]) => nativeMetadata[models.find(model => model in nativeMetadata) as keyof typeof nativeMetadata],
    ln: () => nativeMetadata,
    __lfModelMeta: (model: string) => metadataLookup?.(model),
    a6e: (value: { agentContext: Record<string, unknown> }) => value.agentContext,
    send: sent,
  }) as { buildRequest: (request: SourcedRequest, messages: unknown) => SourcedRequest;
    yUe: (model: string) => Record<string, unknown> | undefined };
  metadataLookup = functions.yUe;
  return { functions, sent, policyModelId, bindingId };
}

it('rejects an SDK bound request above its confirmed output limit before provider dispatch', async () => {
  assertIsolatedRoutingSession(sdkSessionAbove);
  const service = await startSdkService(endpoint => {
    const context = sdkRoutingContext(undefined, endpoint);
    return { ...context, catalog: { ...context.catalog,
      models: context.catalog.models.map(model => ({ ...model, maxOutputTokens: outputLimit })) } };
  });
  const binding = await createBoundRoutingJob(service.context, sdkSessionAbove, 'launch-sdk-output-over-cap');

  try {
    const response = await sendBoundRequest(service.proxy, service.certificates.caCert, sdkSessionAbove, binding.id, 'low', {},
      { max_tokens: outputLimit + 1 });

    expect(response.status, JSON.stringify(response.body)).toContain('400');
    expect(service.upstreamBodies).toHaveLength(0);
  } finally {
    await service.close();
  }
}, 20_000);

it('allows an SDK bound request at its confirmed output limit', async () => {
  assertIsolatedRoutingSession(sdkSessionAt);
  const service = await startSdkService(endpoint => {
    const context = sdkRoutingContext(undefined, endpoint);
    return { ...context, catalog: { ...context.catalog,
      models: context.catalog.models.map(model => ({ ...model, maxOutputTokens: outputLimit })) } };
  });
  const binding = await createBoundRoutingJob(service.context, sdkSessionAt, 'launch-sdk-output-at-cap');
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, sdkSessionAt, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, sdkSessionAt, consumerId, service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, sdkSessionAt, binding.id, 'low', {},
      { max_tokens: outputLimit });
    await acknowledgeLaunchNotice(service.proxy.port, sdkSessionAt, consumerId, service.proxy.token, notices);
    const response = await request;

    expect(response.status, JSON.stringify(response.body)).toContain('200');
    expect(service.upstreamBodies).toHaveLength(1);
  } finally {
    notices?.close();
    await service.close();
  }
}, 20_000);

it('rejects a native bound request above its confirmed output limit before credentials or provider dispatch', async () => {
  const context = nativeRoutingContext();
  context.catalog = { ...context.catalog,
    models: context.catalog.models.map(model => ({ ...model, maxOutputTokens: outputLimit })) };
  assertIsolatedRoutingSession(nativeSessionAbove);
  const binding = await createBoundRoutingJob(context, nativeSessionAbove, 'launch-native-output-over-cap');
  blockDefaultFetch();
  const service = await startNativeService(context, { injectNativeRoutingFetch: true });

  try {
    const response = await sendBoundRequest(service.proxy, service.certificates.caCert, nativeSessionAbove, binding.id, 'low', {},
      { max_tokens: outputLimit + 1 });

    expect(response.status, JSON.stringify(response.body)).toContain('400');
    expect(service.observation.credentialReads).toBe(0);
    expect(service.observation.nativeFetchCalls).toBe(0);
    expect(service.observation.body).toBeUndefined();
  } finally {
    await service.close();
  }
}, 20_000);

it('allows a native bound request at its confirmed output limit', async () => {
  const context = nativeRoutingContext();
  context.catalog = { ...context.catalog,
    models: context.catalog.models.map(model => ({ ...model, maxOutputTokens: outputLimit })) };
  assertIsolatedRoutingSession(nativeSessionAt);
  const binding = await createBoundRoutingJob(context, nativeSessionAt, 'launch-native-output-at-cap');
  blockDefaultFetch();
  const service = await startNativeService(context, { injectNativeRoutingFetch: true });
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, nativeSessionAt, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, nativeSessionAt, consumerId, service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, nativeSessionAt, binding.id, 'low', {},
      { max_tokens: outputLimit });
    await acknowledgeLaunchNotice(service.proxy.port, nativeSessionAt, consumerId, service.proxy.token, notices);
    const response = await request;

    expect(response.status, JSON.stringify(response.body)).toContain('200');
    expect(service.observation.credentialReads).toBe(1);
    expect(service.observation.nativeFetchCalls).toBe(1);
  } finally {
    notices?.close();
    await service.close();
  }
}, 20_000);

it('rejects a sourced native request above its metadata output cap before the sender', () => {
  const { functions, sent, policyModelId, bindingId } = sourcedNativeRequest(outputLimit);
  const request: SourcedRequest = { model: policyModelId, max_tokens: outputLimit + 1, metadata: {}, effort: 'low',
    contextWindow: 50_000, agentContext: { leverframeRoutingBinding: bindingId, leverframeRoutingPolicyModel: policyModelId } };

  expect(() => sent(functions.buildRequest(request, null))).toThrow();
  expect(sent).not.toHaveBeenCalled();
});

it('allows a sourced native request at its metadata output cap and keeps the hidden binding identity', () => {
  const { functions, sent, policyModelId, bindingId } = sourcedNativeRequest(outputLimit);
  const request: SourcedRequest = { model: policyModelId, max_tokens: outputLimit, metadata: {}, effort: 'low',
    contextWindow: 50_000, agentContext: { leverframeRoutingBinding: bindingId, leverframeRoutingPolicyModel: policyModelId } };

  expect(sent(functions.buildRequest(request, null))).toMatchObject({ model: bindingId, max_tokens: outputLimit });
  expect(sent).toHaveBeenCalledOnce();
});

it('fails closed instead of inventing a native output cap when metadata has no limit', () => {
  const { functions, sent, policyModelId, bindingId } = sourcedNativeRequest();
  const request: SourcedRequest = { model: policyModelId, max_tokens: outputLimit, metadata: {}, effort: 'low',
    contextWindow: 50_000, agentContext: { leverframeRoutingBinding: bindingId, leverframeRoutingPolicyModel: policyModelId } };

  expect(() => sent(functions.buildRequest(request, null))).toThrow();
  expect(sent).not.toHaveBeenCalled();
});
