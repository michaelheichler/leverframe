import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ROUTING_SNAPSHOT_LABEL } from '../src/constants.js';
import { prepareRoutingHandoff, projectRoutingPromptPolicy } from '../src/model-routing.js';
import { createRoutingBinding, resolveRoutingBinding } from '../src/routing-bindings.js';
import {
  acknowledgment,
  assertIsolatedRoutingSession,
  nativeRoutingContext,
  noticeOrResponse,
  readNoticeSequence,
  registerConsumer,
  requestJson,
  safeResponseSummary,
  sdkRoutingContext,
  sendBoundRequest,
  startNativeService,
  startSdkService,
} from './fixtures/model-routing-proxy.js';

const credential = vi.hoisted(() => ({ resolveProviderAccountAuth: vi.fn(async () => ({ apiKey: 'fixture-provider-key' })) }));

vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  resolveProviderAccountAuth: credential.resolveProviderAccountAuth,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  credential.resolveProviderAccountAuth.mockClear();
});

async function prepareBinding(context: ReturnType<typeof nativeRoutingContext>, sessionId: string, launchId: string) {
  const category = 'implementation';
  context.config = { ...context.config, categories: { [category]: { target: context.routerTarget!, effort: 'low',
    instructions: 'Keep the task and provider context intact across the handoff.' } } };
  const policy = projectRoutingPromptPolicy(context.config);
  const prepared = prepareRoutingHandoff({ policy, agentType: 'reviewer', explicitCategory: category,
    delegatedTask: 'Inspect the request translation and preserve its system prefix.',
    originalTask: 'Keep the routed provider identity and original system context stable.',
    requiredConstraints: ['Preserve the native system blocks.', 'Keep the session identity unchanged.'],
    toolInstructions: ['Retain the tool result as attributed evidence.'],
    evidence: [{ source: 'tool-result', content: 'The prior tool call found a cacheable system prefix.' }],
    jobState: 'The first turn completed and the follow-up adds one tool result.' });
  const reviewedTask = JSON.stringify(prepared.envelope);
  const handoff = { version: 1 as const, agentType: 'reviewer', reviewedTask, prefix: prepared.envelope.prefix,
    provenance: prepared.provenance as 'explicit' };
  const binding = await createRoutingBinding({ sessionId, launchId, role: 'specialist', category,
    agentType: 'reviewer', task: reviewedTask, handoff, config: context.config, catalog: context.catalog,
    workload: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 } });
  return { reviewedTask, handoff, binding };
}

it('preserves the reviewed native handoff, cache blocks, OAuth identity, and session over two proxied turns', async () => {
  const sessionId = randomUUID();
  assertIsolatedRoutingSession(sessionId);
  const context = nativeRoutingContext();
  const launch = await prepareBinding(context, sessionId, randomUUID());
  const { proxy, certificates, observation, close } = await startNativeService(context, { injectNativeRoutingFetch: true });
  vi.stubGlobal('fetch', async () => { throw new Error('Default fetch is disabled in native transport fixtures.'); });
  const system = [{ type: 'text', text: 'Native OAuth identity and account instructions.',
    cache_control: { type: 'ephemeral', ttl: '1h' } },
  { type: 'text', text: 'Stable provider system context.', cache_control: { type: 'ephemeral' } }];
  const firstMessages = [{ role: 'user', content: `${ROUTING_SNAPSHOT_LABEL}${launch.reviewedTask}` }];
  const secondMessages = [...firstMessages, { role: 'assistant', content: 'I checked the first turn.' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fixture-tool-result',
      content: 'The tool confirms the system prefix remains cacheable.' }] }];
  const sharedBody = { system, cache_control: { type: 'ephemeral', ttl: '1h' },
    cache_control_metadata: { session: sessionId, prefix: 'stable' } };
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(proxy.port, sessionId, proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(proxy.port, sessionId, consumerId, proxy.token);
    expect((await notices.connected).status).toBe(200);
    const firstRequest = sendBoundRequest(proxy, certificates.caCert, sessionId, launch.binding.id, 'low',
      { 'X-Fixture-Client': 'native-handoff' }, { ...sharedBody, messages: firstMessages });
    const launchOutcome = await noticeOrResponse(notices.nextNotice(), firstRequest);
    expect(launchOutcome.kind, JSON.stringify(safeResponseSummary(launchOutcome))).toBe('notice');
    expect(launchOutcome.stream!.notice).toMatchObject({ kind: 'launch', sessionId, acknowledged: false });
    const launchAck = await requestJson(proxy.port, '/v1/leverframe/routing-notice-ack', proxy.token,
      acknowledgment(launchOutcome.stream!.notice, consumerId));
    expect(launchAck).toMatchObject({ status: 200, body: { acknowledged: true } });
    const first = await firstRequest;
    const secondRequest = sendBoundRequest(proxy, certificates.caCert, sessionId, launch.binding.id, 'low',
      { 'X-Fixture-Client': 'native-handoff' }, { ...sharedBody, messages: secondMessages });
    const secondOutcome = await noticeOrResponse(notices.nextNotice(), secondRequest);
    expect(secondOutcome.kind, JSON.stringify(safeResponseSummary(secondOutcome))).toBe('notice');
    expect(secondOutcome.stream!.notice).toMatchObject({ kind: 'request_completed', sessionId,
      modelId: launch.binding.id, revision: launch.binding.revision, reason: 'request_completed',
      target: launch.binding.decision.target, acknowledged: false });
    const secondAck = await requestJson(proxy.port, '/v1/leverframe/routing-notice-ack', proxy.token,
      acknowledgment(secondOutcome.stream!.notice, consumerId));
    expect(secondAck).toMatchObject({ status: 200, body: { acknowledged: true } });
    const second = await secondRequest;
    const saved = await resolveRoutingBinding({ sessionId, modelId: launch.binding.id });
    const bodies = observation.requests.map(request => request.body);

    expect([first.status, second.status], JSON.stringify([first.body, second.body])).toEqual(
      expect.arrayContaining([expect.stringContaining('200'), expect.stringContaining('200')]));
    expect(observation.requests).toHaveLength(2);
    expect(observation.requests.map(request => ({ authorization: request.authorization, session: request.session,
      customHeader: request.customHeader }))).toEqual([
      { authorization: 'Bearer fixture-native-token', session: sessionId, customHeader: 'native-handoff' },
      { authorization: 'Bearer fixture-native-token', session: sessionId, customHeader: 'native-handoff' },
    ]);
    expect(bodies.map(body => body['system'])).toEqual([system, system]);
    expect(bodies.map(body => body['cache_control'])).toEqual([sharedBody.cache_control, sharedBody.cache_control]);
    expect(bodies.map(body => body['cache_control_metadata'])).toEqual([sharedBody.cache_control_metadata,
      sharedBody.cache_control_metadata]);
    const firstNativeMessages = bodies[0]!['messages'] as unknown[];
    const secondNativeMessages = bodies[1]!['messages'] as unknown[];
    expect(firstNativeMessages[0]).toEqual(firstMessages[0]);
    expect(secondNativeMessages[0]).toEqual(firstMessages[0]);
    expect(secondNativeMessages[2]).toEqual(secondMessages[2]);
    expect(saved.handoff).toEqual(launch.handoff);
    expect(JSON.parse(saved.handoff!.reviewedTask)).toMatchObject({ task: {
      delegatedTask: 'Inspect the request translation and preserve its system prefix.',
      originalTask: 'Keep the routed provider identity and original system context stable.',
      requiredConstraints: ['Preserve the native system blocks.', 'Keep the session identity unchanged.'],
      evidence: [{ source: 'tool-result', content: 'The prior tool call found a cacheable system prefix.' }],
      jobState: 'The first turn completed and the follow-up adds one tool result.',
    } });
  } finally {
    notices?.close();
    await close();
  }
});

it('keeps the SDK upstream body and authenticated request identity stable across a tool-result follow-up', async () => {
  const sessionId = randomUUID();
  assertIsolatedRoutingSession(sessionId);
  const service = await startSdkService(endpoint => sdkRoutingContext(undefined, endpoint));
  const context = service.context;
  const launch = await prepareBinding(context, sessionId, randomUUID());
  const firstMessages = [{ role: 'user', content: `${ROUTING_SNAPSHOT_LABEL}${launch.reviewedTask}` }];
  const secondMessages = [...firstMessages, { role: 'assistant', content: 'The first turn used the accepted prefix.' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fixture-sdk-tool', content: 'The follow-up evidence.' }] }];
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, sessionId, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, sessionId, consumerId, service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const firstRequest = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, launch.binding.id, 'low', {}, {
      system: [{ type: 'text', text: 'Stable SDK system prefix.', cache_control: { type: 'ephemeral' } }], messages: firstMessages,
    });
    const launchOutcome = await noticeOrResponse(notices.nextNotice(), firstRequest);
    expect(launchOutcome.kind, JSON.stringify(safeResponseSummary(launchOutcome))).toBe('notice');
    expect(launchOutcome.stream!.notice).toMatchObject({ kind: 'launch', sessionId, acknowledged: false });
    const launchAck = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(launchOutcome.stream!.notice, consumerId));
    expect(launchAck).toMatchObject({ status: 200, body: { acknowledged: true } });
    const first = await firstRequest;
    const secondRequest = sendBoundRequest(service.proxy, service.certificates.caCert, sessionId, launch.binding.id, 'low', {}, {
      system: [{ type: 'text', text: 'Stable SDK system prefix.', cache_control: { type: 'ephemeral' } }], messages: secondMessages,
    });
    const secondOutcome = await noticeOrResponse(notices.nextNotice(), secondRequest);
    expect(secondOutcome.kind, JSON.stringify(safeResponseSummary(secondOutcome))).toBe('notice');
    expect(secondOutcome.stream!.notice).toMatchObject({ kind: 'request_completed', sessionId,
      modelId: launch.binding.id, revision: launch.binding.revision, reason: 'request_completed',
      target: launch.binding.decision.target, acknowledged: false });
    const secondAck = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(secondOutcome.stream!.notice, consumerId));
    expect(secondAck).toMatchObject({ status: 200, body: { acknowledged: true } });
    const second = await secondRequest;

    expect([first.status, second.status], JSON.stringify([first.body, second.body])).toEqual(
      expect.arrayContaining([expect.stringContaining('200'), expect.stringContaining('200')]));
    expect(service.upstreamBodies).toHaveLength(2);
    expect(service.upstreamBodies.map(body => body['model'])).toEqual(['fixture-upstream-model', 'fixture-upstream-model']);
    const firstUpstreamMessages = service.upstreamBodies[0]?.['messages'] as Array<Record<string, unknown>>;
    const secondUpstreamMessages = service.upstreamBodies[1]?.['messages'] as Array<Record<string, unknown>>;
    expect(firstUpstreamMessages[0]).toEqual(secondUpstreamMessages[0]);
    expect(firstUpstreamMessages[1]?.['content']).toContain(`${ROUTING_SNAPSHOT_LABEL}${launch.reviewedTask}`);
    expect(secondUpstreamMessages[1]?.['content']).toContain(`${ROUTING_SNAPSHOT_LABEL}${launch.reviewedTask}`);
    expect(JSON.stringify(secondUpstreamMessages)).toContain('The follow-up evidence.');
    expect(secondUpstreamMessages.length).toBeGreaterThan(firstUpstreamMessages.length);
    expect(service.upstreamHeaders).toHaveLength(2);
    expect(service.upstreamHeaders.map(headers => headers['authorization'])).toEqual([
      'Bearer fixture-provider-key', 'Bearer fixture-provider-key',
    ]);
  } finally {
    notices?.close();
    await service.close();
  }
});
