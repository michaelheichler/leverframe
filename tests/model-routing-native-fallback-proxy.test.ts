import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  resolveProviderAccountAuth: vi.fn(async (providerId: string, account: { id: string }) => {
    if (providerId.startsWith('fixture-') && account.id === 'default') return { apiKey: 'fixture-sdk-api-key' };
    throw new Error('Unexpected SDK provider credential lookup.');
  }),
}));
import { resolveProviderAccountAuth } from '../src/env.js';
import { buildRoutingCatalog, type ModelRef, type RoutingConfig } from '../src/model-routing.js';
import { createRoutingBinding, listRoutingNotices, resolveRoutingBinding } from '../src/routing-bindings.js';
import { getInferenceRequestLogPath, resetTraceLog } from '../src/log-paths.js';
import { input, observation, provider } from './model-routing-fixtures.js';
import { acknowledgment, blockNonLoopbackFetch, isolatedSessionId, noticeOrResponse, readNotice,
  readNoticeSequence, registerConsumer, requestJson, sendBoundRequest, startNativeService } from './fixtures/model-routing-proxy.js';
import type { ConnectedNoticeStream, NoticeStream } from './fixtures/model-routing-proxy.js';

const originalTotalTimeout = vi.hoisted(() => {
  const value = process.env['LEVERFRAME_TOTAL_TIMEOUT_MS'];
  process.env['LEVERFRAME_TOTAL_TIMEOUT_MS'] = '2000';
  return value;
});
const primary: ModelRef = { providerId: 'anthropic', modelId: 'claude-router-primary-model' };
const replacement: ModelRef = { providerId: 'anthropic', modelId: 'claude-router-replacement-model' };
const primaryUpstream = 'claude-router-primary-upstream';
const replacementUpstream = 'claude-router-replacement-upstream';
const agentTool = { name: 'Agent', description: 'Delegate a reviewed task.', input_schema: { type: 'object' } };

afterAll(() => {
  if (originalTotalTimeout === undefined) delete process.env['LEVERFRAME_TOTAL_TIMEOUT_MS'];
  else process.env['LEVERFRAME_TOTAL_TIMEOUT_MS'] = originalTotalTimeout;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(resolveProviderAccountAuth).mockClear();
});

function nativeContext() {
  const fetchedAt = '2026-10-01T00:00:00.000Z';
  const nativeProvider = provider({
    id: primary.providerId,
    templateId: 'anthropic',
    credentialSource: 'claude-code',
    authType: 'oauth',
    billing: { kind: 'subscription', source: 'fixture-plan', observedAt: fetchedAt },
    modelsCache: { fetchedAt, source: 'harness', models: [
      { id: primary.modelId, name: primary.modelId, upstreamModelId: primaryUpstream, modelFormat: 'anthropic',
        contextWindow: 70_000, outputTokenLimit: 12_000, supportedReasoningEfforts: ['low'],
        supportedParameters: ['tools'], pricing: { input: 2, output: 8, source: 'fixture-pricing', observedAt: fetchedAt } },
      { id: replacement.modelId, name: replacement.modelId, upstreamModelId: replacementUpstream, modelFormat: 'anthropic',
        contextWindow: 70_000, outputTokenLimit: 12_000, supportedReasoningEfforts: ['low'],
        supportedParameters: ['tools'], pricing: { input: 2, output: 8, source: 'fixture-pricing', observedAt: fetchedAt } },
    ] },
  });
  const catalog = buildRoutingCatalog(input([nativeProvider], {
    credentials: [observation(nativeProvider.id, 'oauth')],
    discovery: [{ providerId: nativeProvider.id, status: 'live', cacheFetchedAt: fetchedAt }],
  }));
  const config: RoutingConfig = { enabled: true, visibleModelId: 'auto', cheapFallback: primary,
    routerFallbacks: [replacement], pool: [primary, replacement] };
  return { proxyToken: 'fixture-proxy-token', routerTarget: primary, config, catalog,
    workload: { cacheRead: 0, cacheWrite: 0 } };
}

function quotaResponseFor(model: string) {
  return (body: Record<string, unknown>) => body.model === model ? {
    status: 429,
    body: { type: 'error', error: { type: 'rate_limit_error', message: 'Fixture provider quota exhausted.' } },
  } : undefined;
}

it('sends the front router replacement only after the connected consumer acknowledges the Agent request notice', async () => {
  blockNonLoopbackFetch();
  const session = isolatedSessionId();
  const context = nativeContext();
  const system = [
    { type: 'text', text: 'First native cached system block', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'Second native cached system block', cache_control: { type: 'ephemeral' } },
  ];
  const service = await startNativeService(context, { injectNativeRoutingFetch: true,
    responseForRequest: quotaResponseFor(primaryUpstream) });
  let connectedStream: ConnectedNoticeStream | undefined;
  let stream: NoticeStream | undefined;
  let notices: ReturnType<typeof readNoticeSequence> | undefined;
  const downstreamEvents: Array<'headers' | 'data'> = [];
  let request: Promise<Awaited<ReturnType<typeof sendBoundRequest>>> = Promise.resolve({ status: '', body: {} });

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    expect(consumer.status).toBe(200);
    notices = readNoticeSequence(service.proxy.port, session, String(consumer.body.consumerId), service.proxy.token);
    const connected = await notices.connected;
    connectedStream = connected;
    expect(connected.status).toBe(200);
    request = sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
      output_config: {}, system, tools: [agentTool],
    }, false, '/v1/messages', event => downstreamEvents.push(event.kind));
    const launch = await notices.nextNotice();

    expect(service.observation.requests).toHaveLength(0);
    expect(downstreamEvents).toEqual([]);
    expect(launch.notice).toMatchObject({ kind: 'launch', sessionId: session, target: primary, acknowledged: false });
    const launchAck = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(launch.notice, String(consumer.body.consumerId)));
    expect(launchAck).toMatchObject({ status: 200, body: { acknowledged: true } });

    stream = await notices.nextNotice();
    expect(stream.notice).toMatchObject({ sessionId: session, previous: primary, target: replacement, acknowledged: false });
    expect(service.observation.requests).toHaveLength(1);
    expect(downstreamEvents).toEqual([]);
    expect(service.observation.requests[0]?.body.model).toBe(primaryUpstream);
    expect(service.observation.requests[0]?.body.tools).toEqual([agentTool]);
    expect(service.observation.requests[0]?.body.system).toEqual(system);

    const acknowledged = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(stream!.notice, String(consumer.body.consumerId)));
    const response = await request;

    expect(acknowledged).toMatchObject({ status: 200, body: { acknowledged: true } });
    expect(response.status).toContain('200');
    expect(service.observation.requests).toHaveLength(2);
    expect(service.observation.requests[1]?.body.model).toBe(replacementUpstream);
    expect(service.observation.requests[1]?.body.tools).toEqual([agentTool]);
    expect(service.observation.requests[1]?.body.system).toEqual(system);
    const completion = await notices.nextNotice();
    expect(completion.notice).toMatchObject({ kind: 'request_completed', sessionId: session, target: replacement,
      acknowledged: false });
  } finally {
    connectedStream?.close();
    notices?.close();
    await Promise.allSettled([request]);
    await service.close();
  }
}, 10_000);

it('preserves completed tool history through acknowledged native fallback', async () => {
  blockNonLoopbackFetch();
  const session = isolatedSessionId();
  const context = nativeContext();
  const messages = [
    { role: 'user', content: 'Start the reviewed task.' },
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'call-one', name: 'Agent', input: { task: 'Inspect the first item.' } },
      { type: 'tool_use', id: 'call-two', name: 'Agent', input: { task: 'Inspect the second item.' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call-one', content: 'First item is valid.' },
      { type: 'tool_result', tool_use_id: 'call-two', content: 'Second item is valid.' },
      { type: 'text', text: 'Continue with both results.' },
    ] },
  ];
  const service = await startNativeService(context, { injectNativeRoutingFetch: true,
    responseForRequest: quotaResponseFor(primaryUpstream) });
  let stream: NoticeStream | undefined;
  let connected: ConnectedNoticeStream | undefined;
  let notices: ReturnType<typeof readNoticeSequence> | undefined;
  let request: Promise<Awaited<ReturnType<typeof sendBoundRequest>>> = Promise.resolve({ status: '', body: {} });

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    expect(consumer.status).toBe(200);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(service.proxy.port, session, consumerId, service.proxy.token);
    connected = await notices.connected;
    expect(connected.status).toBe(200);
    request = sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
      output_config: {}, tools: [agentTool], messages,
    }, false, '/v1/messages');
    const launch = await notices.nextNotice();
    expect(launch.notice).toMatchObject({ kind: 'launch', sessionId: session, target: primary, acknowledged: false });
    const launchAck = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(launch.notice, consumerId));
    expect(launchAck).toMatchObject({ status: 200, body: { acknowledged: true } });

    const observed = await noticeOrResponse(notices.nextNotice(), request);
    stream = observed.stream;
    expect(observed.kind, JSON.stringify({ kind: observed.kind, status: observed.response?.status,
      error: String(observed.error) })).toBe('notice');
    expect(stream?.notice).toMatchObject({ previous: primary, target: replacement,
      reason: 'quota_exhausted', acknowledged: false });
    expect(service.observation.requests).toHaveLength(1);
    expect(service.observation.requests[0]?.body.model).toBe(primaryUpstream);
    expect(service.observation.requests[0]?.body.messages).toEqual(messages);

    const fallbackAck = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(stream!.notice, consumerId));
    const response = await request;

    expect(fallbackAck).toMatchObject({ status: 200, body: { acknowledged: true } });
    expect(response.status).toContain('200');
    expect(service.observation.requests).toHaveLength(2);
    expect(service.observation.requests[1]?.body.model).toBe(replacementUpstream);
    expect(service.observation.requests[1]?.body.messages).toEqual(messages);
  } finally {
    stream?.close();
    connected?.close();
    notices?.close();
    await Promise.allSettled([request]);
    await service.close();
  }
}, 10_000);

it('does not forward proxy-private headers to the native upstream', async () => {
  blockNonLoopbackFetch();
  const session = isolatedSessionId();
  const context = nativeContext();
  context.config = { ...context.config, routerFallbacks: [] };
  const binding = await createRoutingBinding({ sessionId: session, launchId: `private-headers-${randomUUID()}`,
    role: 'router', task: '', config: context.config, catalog: context.catalog, workload: context.workload });
  const service = await startNativeService(context, { injectNativeRoutingFetch: true });
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    notices = readNoticeSequence(service.proxy.port, session, String(consumer.body.consumerId), service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, session, binding.id, 'low', {
      'x-leverframe-routing-binding': 'fixture-binding-value',
      'x-leverframe-fixture-metadata': 'fixture-private-value',
    });
    const launch = await notices.nextNotice();
    expect(service.observation.requests).toHaveLength(0);
    expect(launch.notice).toMatchObject({ kind: 'launch', modelId: binding.id, acknowledged: false });
    const ack = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(launch.notice, String(consumer.body.consumerId)));
    expect(ack.status).toBe(200);
    const response = await request;

    expect(response.status).toContain('200');
    expect(service.observation.requests[0]?.internalHeaders).toEqual([]);
  } finally {
    notices?.close();
    await service.close();
  }
}, 10_000);
it('does not send a replacement after the connected notice consumer disconnects', async () => {
  blockNonLoopbackFetch();
  const session = isolatedSessionId();
  const service = await startNativeService(nativeContext(), { injectNativeRoutingFetch: true,
    responseForRequest: quotaResponseFor(primaryUpstream) });
  let stream: NoticeStream | undefined;
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    notices = readNoticeSequence(service.proxy.port, session, String(consumer.body.consumerId), service.proxy.token);
    const connected = await notices.connected;
    expect(connected.status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
      output_config: {}, tools: [agentTool],
    });
    const launch = await notices.nextNotice();
    expect(launch.notice).toMatchObject({ kind: 'launch', sessionId: session, acknowledged: false });
    const launchAck = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(launch.notice, String(consumer.body.consumerId)));
    expect(launchAck.status).toBe(200);
    stream = await notices.nextNotice();
    expect(service.observation.requests).toHaveLength(1);
    expect(stream.notice).toMatchObject({ reason: 'quota_exhausted', acknowledged: false });
    stream?.close();
    await stream?.closed;

    await request;

    expect(service.observation.requests).toHaveLength(1);
  } finally {
    stream?.close();
    notices?.close();
    await service.close();
  }
}, 10_000);
it('does not send a second native model POST after an upstream 401 before notice acknowledgment', async () => {
  blockNonLoopbackFetch();
  const session = isolatedSessionId();
  const service = await startNativeService(nativeContext(), { injectNativeRoutingFetch: true,
    responseForRequest: () => ({ status: 401, body: { error: { type: 'authentication_error',
      message: 'Loopback fixture rejected the primary credential.' } } }) });
  let stream: NoticeStream | undefined;
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    notices = readNoticeSequence(service.proxy.port, session, String(consumer.body.consumerId), service.proxy.token);
    expect((await notices.connected).status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
      output_config: {}, tools: [agentTool],
    });
    const launch = await notices.nextNotice();
    expect(launch.notice).toMatchObject({ kind: 'launch', sessionId: session, acknowledged: false });
    const launchAck = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(launch.notice, String(consumer.body.consumerId)));
    expect(launchAck.status).toBe(200);
    stream = await notices.nextNotice();

    expect(stream.notice).toMatchObject({ reason: 'credential_rejected', previous: primary, target: replacement,
      acknowledged: false });
    expect(service.observation.requests).toHaveLength(1);
    expect(service.observation.requests[0]?.body.model).toBe(primaryUpstream);
    stream?.close();
    await stream?.closed;
    await request;

    expect(service.observation.requests).toHaveLength(1);
  } finally {
    stream?.close();
    notices?.close();
    await service.close();
  }
}, 20_000);

it('does not send a replacement after the total request deadline expires without acknowledgment', async () => {
  blockNonLoopbackFetch();
  const session = isolatedSessionId();
  const service = await startNativeService(nativeContext(), { injectNativeRoutingFetch: true,
    responseForRequest: quotaResponseFor(primaryUpstream) });
  let stream: NoticeStream | undefined;
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    notices = readNoticeSequence(service.proxy.port, session, String(consumer.body.consumerId), service.proxy.token);
    const connected = await notices.connected;
    expect(connected.status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
      output_config: {}, tools: [agentTool],
    });
    const launch = await notices.nextNotice();
    expect(launch.notice).toMatchObject({ kind: 'launch', sessionId: session, acknowledged: false });
    const launchAck = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(launch.notice, String(consumer.body.consumerId)));
    expect(launchAck.status).toBe(200);
    stream = await notices.nextNotice();
    expect(service.observation.requests).toHaveLength(1);
    expect(stream.notice).toMatchObject({ reason: 'quota_exhausted', acknowledged: false });

    await request;

    expect(service.observation.requests).toHaveLength(1);
  } finally {
    stream?.close();
    notices?.close();
    await service.close();
  }
}, 10_000);
it('keeps the binding on its first model when a streamed tool event is followed by upstream failure', async () => {
  blockNonLoopbackFetch();
  const logPath = getInferenceRequestLogPath();
  const testHome = process.env['LEVERFRAME_TEST_HOME'];
  expect(testHome).toBeTruthy();
  expect(relative(testHome!, logPath)).not.toMatch(/^\.\.(?:\/|$)/);
  resetTraceLog(logPath);
  const session = isolatedSessionId();
  const context = nativeContext();
  const binding = await createRoutingBinding({ sessionId: session, launchId: `streaming-router-${randomUUID()}`,
    role: 'router', task: '', config: context.config, catalog: context.catalog, workload: context.workload });
  const service = await startNativeService(context, { injectNativeRoutingFetch: true,
    streamForRequest: (body, response) => {
      if (body.stream !== true) return false;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      response.write([
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"fixture-streamed-message","type":"message","role":"assistant","model":"fixture-upstream","content":[],"usage":{"input_tokens":4,"output_tokens":0}}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"fixture-tool-call","name":"Agent","input":{}}}',
        '',
        '',
      ].join('\n'), () => response.socket?.destroy());
      return true;
    } });
  let connectedStream: ConnectedNoticeStream | undefined;
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    notices = readNoticeSequence(service.proxy.port, session, String(consumer.body.consumerId), service.proxy.token);
    connectedStream = await notices.connected;
    expect(connectedStream.status).toBe(200);

    const request = sendBoundRequest(service.proxy, service.certificates.caCert, session, binding.id, 'low', {}, {
      stream: true, tools: [agentTool],
    });
    const launch = await notices.nextNotice();
    expect(launch.notice).toMatchObject({ kind: 'launch', sessionId: session, target: primary, acknowledged: false });
    const launchAck = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(launch.notice, String(consumer.body.consumerId)));
    expect(launchAck).toMatchObject({ status: 200, body: { acknowledged: true } });
    const response = await request;

    expect(response.status).toContain('200');
    expect(response.body.raw).toContain('content_block_start');
    expect(service.observation.requests).toHaveLength(1);
    expect(service.observation.requests[0]?.body.model).toBe(primaryUpstream);
    const unchanged = await resolveRoutingBinding({ sessionId: session, modelId: binding.id });
    expect(unchanged.revision).toBe(binding.revision);
    expect(unchanged.decision.target).toEqual(primary);

    await expect.poll(async () => (await resolveRoutingBinding({ sessionId: session, modelId: binding.id })).lease,
      { interval: 10, timeout: 5_000 }).toBeUndefined();
    const durableNotices = listRoutingNotices(session, 0);
    expect(durableNotices.filter(notice => 'kind' in notice && notice.kind === 'request_completed')).toEqual([]);
    const routingEvents = readFileSync(logPath, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(entry => typeof entry.event === 'string' && entry.event.startsWith('routing_'));
    expect(routingEvents).not.toHaveLength(0);
    expect(routingEvents.filter(entry => entry.event === 'routing_request_completed')).toEqual([]);
    expect(routingEvents.some(entry => ['routing_request_failed', 'routing_request_cancelled', 'routing_request_outcome_unknown']
      .includes(String(entry.event))), JSON.stringify(routingEvents.map(entry => entry.event))).toBe(true);
    resetTraceLog(logPath);
  } finally {
    connectedStream?.close();
    notices?.close();
    await service.close();
  }
}, 10_000);

it('does not send the first native model request before the launch notice is acknowledged', async () => {
  blockNonLoopbackFetch();
  const session = isolatedSessionId();
  const context = nativeContext();
  const service = await startNativeService(context, { injectNativeRoutingFetch: true });
  let stream: NoticeStream | undefined;
  let connected: ConnectedNoticeStream | undefined;
  let downstreamEvents: Array<'headers' | 'data'> = [];
  let request: Promise<Awaited<ReturnType<typeof sendBoundRequest>>> = Promise.resolve({ status: '', body: {} });

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    expect(consumer.status).toBe(200);
    const noticeEvent = readNotice(service.proxy.port, session, String(consumer.body.consumerId), service.proxy.token);
    connected = await noticeEvent.connected;
    expect(connected.status).toBe(200);
    request = sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {},
      { output_config: {}, tools: [agentTool] }, false, '/v1/messages', event => downstreamEvents.push(event.kind));
    const outcome = await noticeOrResponse(noticeEvent.notice, request);
    stream = outcome.stream;

    expect(service.observation.requests).toHaveLength(0);
    expect(downstreamEvents).toEqual([]);
    expect(outcome.kind).toBe('notice');
    expect(stream?.notice).toMatchObject({ kind: 'launch', sessionId: session,
      target: context.routerTarget, acknowledged: false });
    const ack = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(stream!.notice, String(consumer.body.consumerId)));
    expect(ack).toMatchObject({ status: 200, body: { acknowledged: true } });
    const response = await request;
    expect(response.status).toContain('200');
    expect(service.observation.requests).toHaveLength(1);
  } finally {
    stream?.close();
    connected?.close();
    await Promise.allSettled([request]);
    await service.close();
  }
}, 10_000);
