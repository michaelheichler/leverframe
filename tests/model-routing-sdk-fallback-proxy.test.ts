import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  resolveProviderAccountAuth: vi.fn(async (providerId: string, account: { id: string }) => {
    if (providerId.startsWith('fixture-') && account.id === 'default') return { apiKey: 'fixture-sdk-api-key' };
    throw new Error('Unexpected SDK provider credential lookup.');
  }),
}));
import { resolveProviderAccountAuth } from '../src/env.js';
import type { ModelRef } from '../src/model-routing.js';
import { getInferenceRequestLogPath, resetTraceLog } from '../src/log-paths.js';
import { acknowledgment, acknowledgeLaunchNotice, blockNonLoopbackFetch, isolatedSessionId, noticeOrResponse, readNoticeSequence,
  registerConsumer, requestJson, safeResponseSummary, sdkRoutingContext, sendBoundRequest, startSdkService } from './fixtures/model-routing-proxy.js';
import type { ConnectedNoticeStream, NoticeStream } from './fixtures/model-routing-proxy.js';

const originalTotalTimeout = vi.hoisted(() => {
  const value = process.env['LEVERFRAME_TOTAL_TIMEOUT_MS'];
  process.env['LEVERFRAME_TOTAL_TIMEOUT_MS'] = '2000';
  return value;
});
const agentTool = { name: 'Agent', description: 'Delegate a reviewed task.', input_schema: { type: 'object' } };

afterAll(() => {
  if (originalTotalTimeout === undefined) delete process.env['LEVERFRAME_TOTAL_TIMEOUT_MS'];
  else process.env['LEVERFRAME_TOTAL_TIMEOUT_MS'] = originalTotalTimeout;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(resolveProviderAccountAuth).mockClear();
});

async function startNonstreamApiFallbackService() {
  const primaryUpstreamModel = 'fixture-upstream-model';
  const fallbackUpstreamModel = 'fixture-api-fallback-upstream';
  const primaryProviderId = 'fixture-api-primary-provider';
  const fallbackProviderId = 'fixture-api-fallback-provider';
  let fallbackRef!: ModelRef;
  const responses = new Map<string, { status: number; body: Record<string, unknown> }>([
    [primaryUpstreamModel, { status: 401, body: { error: { message: 'Fixture API authorization rejection.' } } }],
    [fallbackUpstreamModel, { status: 200, body: { id: 'fixture-sdk-completion', object: 'chat.completion', created: 1,
      model: fallbackUpstreamModel, choices: [{ index: 0, message: { role: 'assistant', content: 'Fixture answer' },
        finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } } }],
  ]);
  const service = await startSdkService(endpoint => {
    const context = sdkRoutingContext('auto', endpoint, { providerId: primaryProviderId,
      modelId: 'fixture-api-primary-model', upstreamModelId: primaryUpstreamModel });
    const primaryRef = context.routerTarget!;
    const fallbackContext = sdkRoutingContext('auto', endpoint, { providerId: fallbackProviderId,
      modelId: 'fixture-api-fallback-model', upstreamModelId: fallbackUpstreamModel });
    fallbackRef = fallbackContext.routerTarget!;
    const primaryModel = context.catalog.models[0]!;
    const fallbackModel = fallbackContext.catalog.models[0]!;
    const toolsPrimary = { ...primaryModel, capabilities: { ...primaryModel.capabilities, tools: true },
      confirmedCapabilities: [...primaryModel.confirmedCapabilities, 'tools' as const] };
    const toolsFallback = { ...fallbackModel, capabilities: { ...fallbackModel.capabilities, tools: true },
      confirmedCapabilities: [...fallbackModel.confirmedCapabilities, 'tools' as const] };
    context.catalog = { ...context.catalog, models: [toolsPrimary, toolsFallback] };
    context.config = { ...context.config, cheapFallback: primaryRef, routerFallbacks: [fallbackRef], pool: [primaryRef, fallbackRef] };
    return context;
  }, _endpoint => [{ ...fallbackRef, upstreamModelId: fallbackUpstreamModel,
    npm: '@ai-sdk/openai-compatible', modelFormat: 'openai' }],
  { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai' }, body => responses.get(String(body.model)));
  return { service, fallbackRef, primaryUpstreamModel, fallbackUpstreamModel, primaryProviderId, fallbackProviderId, responses };
}

async function startStreamingSdkFallback(providerNamespace = 'fixture-stream') {
  const primaryUpstreamModel = 'fixture-upstream-model';
  const fallbackUpstreamModel = 'fixture-stream-fallback-upstream';
  const primaryProviderId = `${providerNamespace}-primary-provider`;
  const fallbackProviderId = `${providerNamespace}-fallback-provider`;
  let fallbackRef!: ModelRef;
  const service = await startSdkService(endpoint => {
    const context = sdkRoutingContext('auto', endpoint, { providerId: primaryProviderId,
      modelId: 'fixture-stream-primary-model', upstreamModelId: primaryUpstreamModel });
    const primaryRef = context.routerTarget!;
    const fallbackContext = sdkRoutingContext('auto', endpoint, { providerId: fallbackProviderId,
      modelId: 'fixture-stream-fallback-model', upstreamModelId: fallbackUpstreamModel });
    fallbackRef = fallbackContext.routerTarget!;
    const primaryModel = context.catalog.models[0]!;
    const fallbackModel = fallbackContext.catalog.models[0]!;
    const toolsPrimary = { ...primaryModel, capabilities: { ...primaryModel.capabilities, tools: true },
      confirmedCapabilities: [...primaryModel.confirmedCapabilities, 'tools' as const] };
    const toolsFallback = { ...fallbackModel, capabilities: { ...fallbackModel.capabilities, tools: true },
      confirmedCapabilities: [...fallbackModel.confirmedCapabilities, 'tools' as const] };
    context.catalog = { ...context.catalog, models: [toolsPrimary, toolsFallback] };
    context.config = { ...context.config, cheapFallback: primaryRef, routerFallbacks: [fallbackRef], pool: [primaryRef, fallbackRef] };
    return context;
  }, _endpoint => [{ ...fallbackRef, upstreamModelId: fallbackUpstreamModel,
    npm: '@ai-sdk/openai-compatible', modelFormat: 'openai' }],
  { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai' },
  body => body.model === primaryUpstreamModel
    ? { status: 401, body: { error: { message: 'Fixture API authorization rejection.' } } } : undefined,
  (body, response) => {
    if (body.model !== fallbackUpstreamModel) return false;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([
      `data: {"id":"fixture-streamed-completion","object":"chat.completion.chunk","created":1,"model":"${fallbackUpstreamModel}","choices":[{"index":0,"delta":{"role":"assistant","content":"Fixture streamed answer"},"finish_reason":null}]}`,
      '',
      `data: {"id":"fixture-streamed-completion","object":"chat.completion.chunk","created":1,"model":"${fallbackUpstreamModel}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}`,
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n'));
    return true;
  });
  return { service, fallbackRef, primaryUpstreamModel, fallbackUpstreamModel, primaryProviderId, fallbackProviderId };
}

it('correlates fallback attempts and usage in the default inference log without request secrets', async () => {
  blockNonLoopbackFetch();
  vi.mocked(resolveProviderAccountAuth).mockClear();
  const session = isolatedSessionId();
  const logPath = getInferenceRequestLogPath();
  const testHome = process.env['LEVERFRAME_TEST_HOME'];
  expect(testHome).toBeTruthy();
  expect(relative(testHome!, logPath)).not.toMatch(/^\.\.(?:\/|$)/);
  resetTraceLog(logPath);
  const promptSentinel = 'ROUTING_LOG_PROMPT_SECRET_SENTINEL';
  const headerSentinel = 'ROUTING_LOG_HEADER_SECRET_SENTINEL';
  const { service, fallbackRef, primaryUpstreamModel, fallbackUpstreamModel }
    = await startStreamingSdkFallback('fixture-routing-log');
  let stream: NoticeStream | undefined;
  let connected: ConnectedNoticeStream | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    const notices = readNoticeSequence(service.proxy.port, session, consumerId, service.proxy.token);
    connected = await notices.connected;
    expect(connected.status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {
      'x-fixture-log-secret': headerSentinel,
    }, { stream: true, output_config: {}, system: [{ type: 'text', text: promptSentinel,
      cache_control: { type: 'ephemeral' } }], tools: [agentTool] });
    await acknowledgeLaunchNotice(service.proxy.port, session, consumerId, service.proxy.token, notices);
    const observed = await noticeOrResponse(notices.nextNotice(), request);
    stream = observed.stream;
    expect(observed.kind, JSON.stringify(safeResponseSummary(observed))).toBe('notice');
    expect(service.upstreamBodies[0]?.model).toBe(primaryUpstreamModel);
    const ack = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(stream!.notice, String(consumer.body.consumerId)));
    const response = await request;

    expect(ack).toMatchObject({ status: 200, body: { acknowledged: true } });
    expect(response.status).toContain('200');
    expect(service.upstreamBodies).toHaveLength(2);
    expect(service.upstreamBodies[1]?.model).toBe(fallbackUpstreamModel);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    const events = lines.map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(entry => typeof entry.event === 'string' && entry.event.startsWith('routing_'));
    const attempts = events.filter(entry => entry.event === 'routing_attempt');
    const rejected = events.find(entry => entry.event === 'routing_attempt_rejected');
    const proposed = events.find(entry => entry.event === 'routing_fallback_proposed');
    const acknowledged = events.find(entry => entry.event === 'routing_fallback_acknowledged');
    const completed = events.filter(entry => entry.event === 'routing_request_completed');
    const usage = events.find(entry => entry.event === 'routing_usage' && entry.attempt === 2);

    expect(attempts.map(entry => entry.attempt)).toEqual([1, 2]);
    expect(new Set(events.map(entry => entry.requestId))).toHaveLength(1);
    expect(new Set(events.map(entry => entry.sessionHash))).toHaveLength(1);
    expect(new Set(events.map(entry => entry.bindingHash))).toHaveLength(1);
    expect(new Set(events.map(entry => entry.launchHash))).toHaveLength(1);
    expect(rejected).toMatchObject({ attempt: 1, failureReason: 'credential_rejected',
      estimate: { unit: 'estimated_api_equivalent_usd' }, actualBilling: 'unknown', subscriptionConsumption: 'unknown' });
    expect(proposed).toMatchObject({ attempt: 1, previousProvider: service.context.routerTarget?.providerId,
      provider: fallbackRef.providerId });
    expect(acknowledged).toMatchObject({ attempt: 1, previousProvider: service.context.routerTarget?.providerId,
      provider: fallbackRef.providerId });
    expect(events.indexOf(proposed!)).toBeLessThan(events.indexOf(acknowledged!));
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ attempt: 2, actualBilling: 'unknown', subscriptionConsumption: 'unknown' });
    expect(usage).toMatchObject({ attempt: 2, usageIsCumulative: true, actualBilling: 'unknown',
      estimate: { unit: 'estimated_api_equivalent_usd' } });
    expect(Number(usage?.outputTokens)).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(promptSentinel);
    expect(lines.join('\n')).not.toContain(headerSentinel);
    expect(lines.join('\n')).not.toContain('fixture-sdk-api-key');
    expect(lines.join('\n')).not.toContain('promptCacheKeyHash');
    expect(lines.join('\n')).not.toContain(session);
  } finally {
    stream?.close();
    connected?.close();
    await connected?.closed;
    await service.close();
    resetTraceLog(logPath);
  }
}, 20_000);

it('waits for an acknowledged API fallback notice and keeps auto in the client response', async () => {
  blockNonLoopbackFetch();
  vi.mocked(resolveProviderAccountAuth).mockClear();
  const session = isolatedSessionId();
  const prefix = 'Stable source-shaped cached system prefix';
  const { service, fallbackRef, primaryUpstreamModel, fallbackUpstreamModel, primaryProviderId, fallbackProviderId, responses }
    = await startNonstreamApiFallbackService();
  let stream: NoticeStream | undefined;
  let connected: ConnectedNoticeStream | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    expect(consumer.status).toBe(200);
    const consumerId = String(consumer.body.consumerId);
    const notices = readNoticeSequence(service.proxy.port, session, consumerId, service.proxy.token);
    connected = await notices.connected;
    expect(connected.status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
      output_config: {}, system: [{ type: 'text', text: prefix, cache_control: { type: 'ephemeral' } }], tools: [agentTool],
    });
    await acknowledgeLaunchNotice(service.proxy.port, session, consumerId, service.proxy.token, notices);
    const observed = await noticeOrResponse(notices.nextNotice(), request);
    stream = observed.stream;

    expect(service.upstreamBodies, JSON.stringify({ notice: { reason: stream?.notice.reason,
      previous: stream?.notice.previous, target: stream?.notice.target },
      credentialLookupCount: vi.mocked(resolveProviderAccountAuth).mock.calls.length })).toHaveLength(1);
    expect(service.upstreamBodies[0]?.model).toBe(primaryUpstreamModel);
    expect(responses.get(primaryUpstreamModel)?.status).toBe(401);
    expect(observed.kind, JSON.stringify({ session, ...safeResponseSummary(observed) })).toBe('notice');
    expect(stream?.status).toBe(200);
    expect(stream?.notice).toMatchObject({ sessionId: session, previous: service.context.routerTarget,
      target: fallbackRef, acknowledged: false });
    expect(JSON.stringify(stream?.notice)).not.toContain(prefix);
    expect(JSON.stringify(stream?.notice)).not.toContain('fixture-sdk-api-key');

    const acknowledged = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(stream!.notice, String(consumer.body.consumerId)));
    const response = await request;

    expect(acknowledged).toMatchObject({ status: 200, body: { acknowledged: true } });
    expect(response.status, JSON.stringify({ ...safeResponseSummary({ kind: 'response', response }),
      upstreamModels: service.upstreamBodies.map(body => body.model), credentialLookupCount: vi.mocked(resolveProviderAccountAuth).mock.calls.length }))
      .toContain('200');
    expect(response.body.model).toBe('auto');
    expect(service.upstreamBodies).toHaveLength(2);
    expect(service.upstreamBodies[1]?.model).toBe(fallbackUpstreamModel);
    expect(JSON.stringify(service.upstreamBodies[0]?.tools)).toContain(agentTool.name);
    expect(service.upstreamBodies[1]?.tools).toEqual(service.upstreamBodies[0]?.tools);
    expect(JSON.stringify(service.upstreamBodies[0])).toContain(prefix);
    expect(JSON.stringify(service.upstreamBodies[1])).toContain(prefix);
    expect(vi.mocked(resolveProviderAccountAuth).mock.calls.map(([providerId, account]) => [providerId, account.id]))
      .toEqual(expect.arrayContaining([[primaryProviderId, 'default'], [fallbackProviderId, 'default']]));
  } finally {
    stream?.close();
    connected?.close();
    await connected?.closed;
    await service.close();
  }
}, 20_000);

it('holds a streamed API fallback before downstream headers until the notice is acknowledged', async () => {
  blockNonLoopbackFetch();
  const session = isolatedSessionId();
  const prefix = 'Stable streamed cached system prefix';
  const { service, fallbackRef, primaryUpstreamModel, fallbackUpstreamModel, primaryProviderId, fallbackProviderId }
    = await startStreamingSdkFallback();
  let stream: NoticeStream | undefined;
  let connected: ConnectedNoticeStream | undefined;
  const downstreamEvents: Array<{ kind: 'headers' } | { kind: 'data' }> = [];

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    const notices = readNoticeSequence(service.proxy.port, session, consumerId, service.proxy.token);
    connected = await notices.connected;
    expect(connected.status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
      stream: true, output_config: {},
      system: [{ type: 'text', text: prefix, cache_control: { type: 'ephemeral' } }], tools: [agentTool],
    }, false, '/v1/messages', event => downstreamEvents.push(event));
    await acknowledgeLaunchNotice(service.proxy.port, session, consumerId, service.proxy.token, notices);
    const observed = await noticeOrResponse(notices.nextNotice(), request);
    stream = observed.stream;

    expect(observed.kind, JSON.stringify({ ...safeResponseSummary(observed),
      upstreamModels: service.upstreamBodies.map(body => body.model),
      credentialLookupCount: vi.mocked(resolveProviderAccountAuth).mock.calls.length })).toBe('notice');
    expect(stream?.notice).toMatchObject({ sessionId: session, previous: service.context.routerTarget,
      target: fallbackRef, acknowledged: false });
    expect(downstreamEvents).toEqual([]);
    expect(service.upstreamBodies, JSON.stringify({
      notice: { reason: stream?.notice.reason, previous: stream?.notice.previous, target: stream?.notice.target },
      credentialLookupCount: vi.mocked(resolveProviderAccountAuth).mock.calls.length,
    })).toHaveLength(1);
    expect(service.upstreamBodies[0]).toMatchObject({ model: primaryUpstreamModel, stream: true });

    const acknowledged = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(stream!.notice, consumerId));
    const response = await request;

    expect(acknowledged).toMatchObject({ status: 200, body: { acknowledged: true } });
    expect(downstreamEvents).toContainEqual({ kind: 'headers' });
    expect(downstreamEvents).toContainEqual({ kind: 'data' });
    expect(service.upstreamBodies).toHaveLength(2);
    expect(service.upstreamBodies[1]).toMatchObject({ model: fallbackUpstreamModel, stream: true });
    expect(JSON.stringify(service.upstreamBodies[0]?.tools)).toContain(agentTool.name);
    expect(service.upstreamBodies[1]?.tools).toEqual(service.upstreamBodies[0]?.tools);
    expect(JSON.stringify(service.upstreamBodies[0])).toContain(prefix);
    expect(JSON.stringify(service.upstreamBodies[1])).toContain(prefix);
    expect(response.status).toContain('200');
    expect(response.body.raw).toContain('Fixture streamed answer');
    expect(response.body.raw).toContain('"model":"auto"');
    expect(vi.mocked(resolveProviderAccountAuth).mock.calls.map(([providerId, account]) => [providerId, account.id]))
      .toEqual(expect.arrayContaining([[primaryProviderId, 'default'], [fallbackProviderId, 'default']]));
  } finally {
    stream?.close();
    connected?.close();
    await connected?.closed;
    await service.close();
  }
}, 20_000);

it('routes an empty primary credential through an acknowledged independent fallback', async () => {
  blockNonLoopbackFetch();
  vi.mocked(resolveProviderAccountAuth).mockClear();
  const session = isolatedSessionId();
  const { service, fallbackRef, primaryProviderId, fallbackProviderId, fallbackUpstreamModel }
    = await startStreamingSdkFallback('fixture-missing-credential-stream');
  const originalResolver = vi.mocked(resolveProviderAccountAuth).getMockImplementation()!;
  vi.mocked(resolveProviderAccountAuth).mockImplementation(async (providerId, account) => {
    if (providerId === primaryProviderId && account.id === 'default') return { apiKey: null };
    if (providerId === fallbackProviderId && account.id === 'default') return { apiKey: 'fixture-sdk-api-key' };
    throw new Error('Unexpected SDK provider credential lookup.');
  });
  const system = [
    { type: 'text', text: 'First stable cached system block', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'Second stable cached system block', cache_control: { type: 'ephemeral' } },
  ];
  let stream: NoticeStream | undefined;
  let connected: ConnectedNoticeStream | undefined;
  const downstreamEvents: Array<{ kind: 'headers' } | { kind: 'data' }> = [];

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    const notices = readNoticeSequence(service.proxy.port, session, consumerId, service.proxy.token);
    connected = await notices.connected;
    expect(connected.status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
      stream: true, output_config: {}, system, tools: [agentTool],
    }, false, '/v1/messages', event => downstreamEvents.push(event));
    await acknowledgeLaunchNotice(service.proxy.port, session, consumerId, service.proxy.token, notices);
    const observed = await noticeOrResponse(notices.nextNotice(), request);
    stream = observed.stream;

    expect(observed.kind, JSON.stringify(safeResponseSummary(observed))).toBe('notice');
    expect(stream?.notice).toMatchObject({ sessionId: session, previous: service.context.routerTarget,
      target: fallbackRef, reason: 'credential_missing', cacheReuse: 'unknown', acknowledged: false });
    expect(service.upstreamBodies).toEqual([]);
    expect(downstreamEvents).toEqual([]);
    expect(vi.mocked(resolveProviderAccountAuth).mock.calls.map(([providerId, account]) => [providerId, account.id]))
      .toEqual([[primaryProviderId, 'default']]);

    const acknowledged = await requestJson(service.proxy.port, '/v1/leverframe/routing-notice-ack', service.proxy.token,
      acknowledgment(stream!.notice, consumerId));
    const response = await request;

    expect(acknowledged).toMatchObject({ status: 200, body: { acknowledged: true } });
    expect(downstreamEvents).toContainEqual({ kind: 'headers' });
    expect(downstreamEvents).toContainEqual({ kind: 'data' });
    expect(service.upstreamBodies).toHaveLength(1);
    expect(service.upstreamBodies[0]).toMatchObject({ model: fallbackUpstreamModel, stream: true });
    const fallbackBody = JSON.stringify(service.upstreamBodies[0]);
    expect(fallbackBody).toContain(system[0].text);
    expect(fallbackBody).toContain(system[1].text);
    expect(fallbackBody.indexOf(system[0].text)).toBeLessThan(fallbackBody.indexOf(system[1].text));
    expect(service.upstreamBodies[0]?.tools).toEqual([expect.objectContaining({
      type: 'function', function: expect.objectContaining({ name: agentTool.name, parameters: agentTool.input_schema }),
    })]);
    expect(response.status).toContain('200');
    expect(response.body.raw).toContain('Fixture streamed answer');
    expect(response.body.raw).toContain('"model":"auto"');
    expect(vi.mocked(resolveProviderAccountAuth).mock.calls.map(([providerId, account]) => [providerId, account.id]))
      .toEqual([[primaryProviderId, 'default'], [fallbackProviderId, 'default']]);
  } finally {
    vi.mocked(resolveProviderAccountAuth).mockImplementation(originalResolver);
    stream?.close();
    connected?.close();
    await connected?.closed;
    await service.close();
  }
}, 20_000);

it('does not send an API fallback after the connected notice consumer disconnects', async () => {
  blockNonLoopbackFetch();
  vi.mocked(resolveProviderAccountAuth).mockClear();
  const session = isolatedSessionId();
  const primaryUpstreamModel = 'fixture-disconnect-primary-upstream';
  const fallbackUpstreamModel = 'fixture-disconnect-fallback-upstream';
  const responses = new Map<string, { status: number; body: Record<string, unknown> }>([
    [primaryUpstreamModel, { status: 401, body: { error: { message: 'Fixture API authorization rejection.' } } }],
    [fallbackUpstreamModel, { status: 200, body: { id: 'fixture-sdk-completion', object: 'chat.completion', created: 1,
      model: fallbackUpstreamModel, choices: [{ index: 0, message: { role: 'assistant', content: 'Fixture answer' },
        finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } } }],
  ]);
  let fallbackRef!: ModelRef;
  const service = await startSdkService(endpoint => {
    const context = sdkRoutingContext('auto', endpoint, { providerId: 'fixture-disconnect-primary-provider',
      modelId: 'fixture-disconnect-primary-model', upstreamModelId: primaryUpstreamModel });
    const primaryRef = context.routerTarget!;
    const fallbackContext = sdkRoutingContext('auto', endpoint, { providerId: 'fixture-disconnect-fallback-provider',
      modelId: 'fixture-disconnect-fallback-model', upstreamModelId: fallbackUpstreamModel });
    fallbackRef = fallbackContext.routerTarget!;
    const primaryModel = context.catalog.models[0]!;
    const fallbackModel = fallbackContext.catalog.models[0]!;
    const toolsPrimary = { ...primaryModel, capabilities: { ...primaryModel.capabilities, tools: true },
      confirmedCapabilities: [...primaryModel.confirmedCapabilities, 'tools' as const] };
    const toolsFallback = { ...fallbackModel, capabilities: { ...fallbackModel.capabilities, tools: true },
      confirmedCapabilities: [...fallbackModel.confirmedCapabilities, 'tools' as const] };
    context.catalog = { ...context.catalog, models: [toolsPrimary, toolsFallback] };
    context.config = { ...context.config, cheapFallback: primaryRef, routerFallbacks: [fallbackRef], pool: [primaryRef, fallbackRef] };
    return context;
  }, _endpoint => [{ ...fallbackRef, upstreamModelId: fallbackUpstreamModel,
    npm: '@ai-sdk/openai-compatible', modelFormat: 'openai' }],
  { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai' }, body => responses.get(String(body.model)));
  let stream: NoticeStream | undefined;
  let connected: ConnectedNoticeStream | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    const notices = readNoticeSequence(service.proxy.port, session, consumerId, service.proxy.token);
    connected = await notices.connected;
    expect(connected.status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
      output_config: {}, tools: [agentTool],
    });
    await acknowledgeLaunchNotice(service.proxy.port, session, consumerId, service.proxy.token, notices);
    const observed = await noticeOrResponse(notices.nextNotice(), request);
    stream = observed.stream;

    expect(service.upstreamBodies).toHaveLength(1);
    expect(service.upstreamBodies[0]?.model).toBe(primaryUpstreamModel);
    expect(observed.kind).toBe('notice');
    stream?.close();
    await stream?.closed;
    await request;

    expect(service.upstreamBodies).toHaveLength(1);
    expect(service.upstreamBodies.map(body => body.model)).not.toContain(fallbackUpstreamModel);
  } finally {
    stream?.close();
    connected?.close();
    await connected?.closed;
    await service.close();
  }
}, 20_000);

it('does not dispatch an API fallback after unknown upstream acceptance', async () => {
  blockNonLoopbackFetch();
  vi.mocked(resolveProviderAccountAuth).mockClear();
  const session = isolatedSessionId();
  const primaryUpstreamModel = 'fixture-unknown-primary-upstream';
  const fallbackUpstreamModel = 'fixture-unknown-fallback-upstream';
  const outcomes = new Map([[primaryUpstreamModel, { disconnect: true as const }],
    [fallbackUpstreamModel, { status: 200, body: { id: 'fixture-sdk-completion', object: 'chat.completion', created: 1,
      model: fallbackUpstreamModel, choices: [{ index: 0, message: { role: 'assistant', content: 'Fixture answer' },
        finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } } }]]);
  let fallbackRef!: ModelRef;
  const service = await startSdkService(endpoint => {
    const context = sdkRoutingContext('auto', endpoint, { providerId: 'fixture-unknown-primary-provider',
      modelId: 'fixture-unknown-primary-model', upstreamModelId: primaryUpstreamModel });
    const primaryRef = context.routerTarget!;
    const fallbackContext = sdkRoutingContext('auto', endpoint, { providerId: 'fixture-unknown-fallback-provider',
      modelId: 'fixture-unknown-fallback-model', upstreamModelId: fallbackUpstreamModel });
    fallbackRef = fallbackContext.routerTarget!;
    const primaryModel = context.catalog.models[0]!;
    const fallbackModel = fallbackContext.catalog.models[0]!;
    const toolsPrimary = { ...primaryModel, capabilities: { ...primaryModel.capabilities, tools: true },
      confirmedCapabilities: [...primaryModel.confirmedCapabilities, 'tools' as const] };
    const toolsFallback = { ...fallbackModel, capabilities: { ...fallbackModel.capabilities, tools: true },
      confirmedCapabilities: [...fallbackModel.confirmedCapabilities, 'tools' as const] };
    context.catalog = { ...context.catalog, models: [toolsPrimary, toolsFallback] };
    context.config = { ...context.config, cheapFallback: primaryRef, routerFallbacks: [fallbackRef], pool: [primaryRef, fallbackRef] };
    return context;
  }, _endpoint => [{ ...fallbackRef, upstreamModelId: fallbackUpstreamModel,
    npm: '@ai-sdk/openai-compatible', modelFormat: 'openai' }],
  { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai' }, body => outcomes.get(String(body.model)));
  let stream: NoticeStream | undefined;
  let connected: ConnectedNoticeStream | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    const notices = readNoticeSequence(service.proxy.port, session, consumerId, service.proxy.token);
    connected = await notices.connected;
    expect(connected.status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto', 'low', {}, {
      output_config: {}, tools: [agentTool],
    });
    await acknowledgeLaunchNotice(service.proxy.port, session, consumerId, service.proxy.token, notices);
    const observed = await noticeOrResponse(notices.nextNotice(), request);
    stream = observed.stream;
    const response = await request;

    expect(observed.kind).toBe('response');
    expect(response.status).not.toContain('200');
    expect(service.upstreamBodies).toHaveLength(1);
    expect(service.upstreamBodies[0]?.model).toBe(primaryUpstreamModel);
    expect(service.upstreamBodies.map(body => body.model)).not.toContain(fallbackUpstreamModel);
  } finally {
    stream?.close();
    connected?.close();
    await connected?.closed;
    await service.close();
  }
}, 20_000);

it('does not switch models after a transient provider response', async () => {
  blockNonLoopbackFetch();
  vi.mocked(resolveProviderAccountAuth).mockClear();
  const session = isolatedSessionId();
  const primaryUpstreamModel = 'fixture-transient-primary-upstream';
  const fallbackUpstreamModel = 'fixture-transient-fallback-upstream';
  const responses = new Map<string, { status: number; body: Record<string, unknown> }>([
    [primaryUpstreamModel, { status: 500, body: { error: { message: 'Fixture transient provider failure.' } } }],
    [fallbackUpstreamModel, { status: 200, body: { id: 'fixture-sdk-completion', object: 'chat.completion', created: 1,
      model: fallbackUpstreamModel, choices: [{ index: 0, message: { role: 'assistant', content: 'Fixture answer' },
        finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } } }],
  ]);
  let fallbackRef!: ModelRef;
  const service = await startSdkService(endpoint => {
    const context = sdkRoutingContext('auto', endpoint, { providerId: 'fixture-transient-primary-provider',
      modelId: 'fixture-transient-primary-model', upstreamModelId: primaryUpstreamModel });
    const primaryRef = context.routerTarget!;
    const fallbackContext = sdkRoutingContext('auto', endpoint, { providerId: 'fixture-transient-fallback-provider',
      modelId: 'fixture-transient-fallback-model', upstreamModelId: fallbackUpstreamModel });
    fallbackRef = fallbackContext.routerTarget!;
    context.catalog = { ...context.catalog, models: [context.catalog.models[0]!, fallbackContext.catalog.models[0]!] };
    context.config = { ...context.config, cheapFallback: primaryRef, routerFallbacks: [fallbackRef], pool: [primaryRef, fallbackRef] };
    return context;
  }, _endpoint => [{ ...fallbackRef, upstreamModelId: fallbackUpstreamModel,
    npm: '@ai-sdk/openai-compatible', modelFormat: 'openai' }],
  { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai' }, body => responses.get(String(body.model)));
  let noticeConnection: ConnectedNoticeStream | undefined;

  try {
    const consumer = await registerConsumer(service.proxy.port, session, service.proxy.token);
    const consumerId = String(consumer.body.consumerId);
    const notices = readNoticeSequence(service.proxy.port, session, consumerId, service.proxy.token);
    noticeConnection = await notices.connected;
    expect(noticeConnection.status).toBe(200);
    const request = sendBoundRequest(service.proxy, service.certificates.caCert, session, 'auto');
    await acknowledgeLaunchNotice(service.proxy.port, session, consumerId, service.proxy.token, notices);
    const observed = await noticeOrResponse(notices.nextNotice(), request);

    expect(observed.kind, JSON.stringify({ ...safeResponseSummary(observed),
      upstreamModels: service.upstreamBodies.map(body => body.model) })).toBe('response');
    expect(responses.get(primaryUpstreamModel)?.status).toBe(500);
    expect(observed.response?.status).not.toContain('200');
    expect(service.upstreamBodies).toHaveLength(1);
    expect(service.upstreamBodies[0]?.model).toBe(primaryUpstreamModel);
    expect(service.upstreamBodies.map(body => body.model)).not.toContain(fallbackUpstreamModel);
  } finally {
    noticeConnection?.close();
    await noticeConnection?.closed;
    await service.close();
  }
}, 20_000);
