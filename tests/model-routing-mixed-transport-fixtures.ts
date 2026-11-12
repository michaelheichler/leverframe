import { once } from 'node:events';
import * as http from 'node:http';
import { dirname, relative, sep } from 'node:path';
import { expect } from 'vitest';
import { buildRoutingCatalog, type ModelRef, type RoutingConfig } from '../src/model-routing.js';
import { createRoutingBinding, resolveRoutingBinding } from '../src/routing-bindings.js';
import { getAppHome, getProvidersPath } from '../src/paths.js';
import { saveRegistry } from '../src/registry/io.js';
import { httpProxyModelId } from '../src/http-proxy/routes.js';
import type { ProxyRoute } from '../src/proxy.js';
import { input, observation, provider } from './model-routing-fixtures.js';
import { acknowledgment, acknowledgeLaunchNotice, readNoticeSequence, registerConsumer,
  requestJson, safeResponseSummary, sendBoundRequest, startSdkService } from './fixtures/model-routing-proxy.js';
import type { NoticeOrResponse, NoticeStream } from './fixtures/model-routing-proxy.js';

export const agentTool = { name: 'Agent', description: 'Delegate a reviewed task.', input_schema: { type: 'object' } };

const testHome = process.env['LEVERFRAME_TEST_HOME'];

interface ProxyHandle {
  port: number;
  token: string;
}

interface MixedTransportSpec {
  endpoint: string;
  namespace: string;
  initial: 'native' | 'registry';
  apiFormat: 'openai' | 'anthropic';
  poolAccountIds?: string[];
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

export function mixedTransportContext(spec: MixedTransportSpec) {
  const { endpoint, namespace, initial, apiFormat, poolAccountIds } = spec;
  const fetchedAt = '2026-10-01T00:00:00.000Z';
  const nativeRef = { providerId: 'anthropic', modelId: `${namespace}-native-model` };
  const registryRef = { providerId: `fixture-mixed-${namespace}-registry`, modelId: `${namespace}-registry-model` };
  const nativeUpstreamModel = `${namespace}-native-upstream`;
  const registryUpstreamModel = `${namespace}-registry-upstream`;
  const nativeCache = { fetchedAt, source: 'harness' as const, models: [{
    id: nativeRef.modelId, name: nativeRef.modelId, upstreamModelId: nativeUpstreamModel,
    modelFormat: 'anthropic' as const, contextWindow: 70_000, outputTokenLimit: 12_000,
    supportedReasoningEfforts: ['low'], supportedParameters: ['tools'], supportsPromptCacheBreakpoints: true,
    pricing: { input: 2, output: 8, source: 'fixture-pricing' },
  }] };
  const registryModel = {
    id: registryRef.modelId, name: registryRef.modelId, upstreamModelId: registryUpstreamModel,
    modelFormat: apiFormat, npm: apiFormat === 'openai' ? '@ai-sdk/openai-compatible' : '@ai-sdk/anthropic',
    apiUrl: endpoint, contextWindow: 70_000, outputTokenLimit: 12_000,
    supportedReasoningEfforts: ['low'], supportedParameters: ['tools'],
    ...(apiFormat === 'anthropic' ? { supportsPromptCacheBreakpoints: true } : {}),
    pricing: { input: 2, output: 8, source: 'fixture-pricing' },
  };
  const registryCache = { fetchedAt, source: 'account' as const, models: [registryModel] };
  const nativeProvider = provider({ id: nativeRef.providerId, templateId: 'anthropic', credentialSource: 'claude-code',
    authType: 'oauth', billing: { kind: 'subscription', source: 'fixture-plan', observedAt: fetchedAt }, modelsCache: nativeCache });
  const registryProvider = provider({ id: registryRef.providerId, templateId: 'fixture', authType: 'api',
    api: { url: endpoint, npm: registryModel.npm }, modelsCache: registryCache,
    accounts: (poolAccountIds ?? ['default']).map(accountId => ({ id: accountId,
      authRef: poolAccountIds ? `keyring:provider:${registryRef.providerId}:${accountId}`
        : `keyring:provider:${registryRef.providerId}`, enabled: true, modelsCache: registryCache })) });
  const catalog = buildRoutingCatalog(input([nativeProvider, registryProvider], {
    credentials: [observation(nativeRef.providerId, 'oauth'), ...(poolAccountIds ?? ['default']).map(accountId => ({
      ...observation(registryRef.providerId, 'api_key'), accountId,
    }))],
    discovery: [{ providerId: nativeRef.providerId, status: 'live', cacheFetchedAt: fetchedAt },
      ...(poolAccountIds ?? ['default']).map(accountId => ({ providerId: registryRef.providerId, accountId,
        status: 'live' as const, cacheFetchedAt: fetchedAt }))],
  }));
  const initialRef = initial === 'native' ? nativeRef : registryRef;
  const fallbackRef = initial === 'native' ? registryRef : nativeRef;
  const config: RoutingConfig = { enabled: true, visibleModelId: 'auto', cheapFallback: initialRef,
    routerFallbacks: [fallbackRef], pool: [initialRef, fallbackRef] };
  const context = { proxyToken: 'fixture-mixed-dummy-proxy-token', routerTarget: initialRef, config, catalog,
    workload: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 } };
  if (!testHome) throw new Error('Isolated test home is required.');
  expect(isInside(testHome, getAppHome())).toBe(true);
  expect(isInside(testHome, dirname(getProvidersPath()))).toBe(true);
  saveRegistry({ schemaVersion: 1, providers: [registryProvider] });
  return { context, nativeRef, registryRef, nativeUpstreamModel, registryUpstreamModel };
}

export type MixedTransportFixture = ReturnType<typeof mixedTransportContext>;

export function registryAnthropicRoute(endpoint: string, ref: ModelRef, upstreamModelId: string): ProxyRoute {
  return {
    aliasId: httpProxyModelId(ref.providerId, ref.modelId), realModelId: upstreamModelId,
    displayName: 'Fixture registry Anthropic model', upstreamUrl: endpoint, baseURL: endpoint,
    apiKey: 'fixture-mixed-dummy-api-key', modelFormat: 'anthropic', npm: '@ai-sdk/anthropic',
    providerId: ref.providerId, accountId: 'default', authType: 'api', contextWindow: 70_000,
    outputTokenLimit: 12_000, supportedParameters: ['tools'], supportsPromptCacheBreakpoints: true,
  };
}

export async function startMixedTransportUpstream(responseForRequest?: (body: Record<string, unknown>) => {
  status: number; body: Record<string, unknown> } | undefined) {
  const requests: Array<Record<string, unknown>> = [];
  let responseToFinish: http.ServerResponse | undefined;
  let bodyToFinish: Record<string, unknown> | undefined;
  let announceRequest = (): void => {};
  const requestArrived = new Promise<void>(resolve => { announceRequest = resolve; });
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodyToFinish = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    requests.push(bodyToFinish);
    const configuredResponse = responseForRequest?.(bodyToFinish);
    if (configuredResponse) {
      res.writeHead(configuredResponse.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(configuredResponse.body));
      announceRequest();
      return;
    }
    responseToFinish = res;
    announceRequest();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mixed transport fixture did not bind to loopback.');
  return {
    endpoint: `http://127.0.0.1:${address.port}`, requests, requestArrived,
    finishResponse: () => {
      if (!responseToFinish || !bodyToFinish) throw new Error('The registry fallback request has not arrived.');
      responseToFinish.writeHead(200, { 'content-type': 'application/json' });
      responseToFinish.end(JSON.stringify({ id: 'fixture-mixed-registry-response', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'Fixture registry answer' }], model: bodyToFinish.model,
        stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } }));
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

type SdkNativeOutcome = 'rejected' | 'unknown' | 'pending';
type SdkRejection = { status: 402 | 429; outcome: 'quota' | 'credit' };

export interface SdkNativeFallbackOptions {
  outcome?: SdkNativeOutcome;
  namespace?: string;
  nativeAuthReader?: () => Promise<{ kind: 'oauth'; token: string } | null>;
  requestDeadlines?: ProxyRoute['requestDeadlines'];
  poolAccountIds?: string[];
  rejection?: SdkRejection;
}

function nativeSseChunks(namespace: string) {
  const first = [
    'event: message_start',
    `data: ${JSON.stringify({ type: 'message_start', message: { id: 'fixture-mixed-native-message', type: 'message', role: 'assistant',
      model: `${namespace}-native-upstream`, content: [], usage: { input_tokens: 5, output_tokens: 0 } } })}`,
    '', 'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '', 'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Fixture mixed native answer"}}',
    '', '',
  ].join('\n');
  const final = [
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" continues"}}',
    '', 'event: content_block_stop', 'data: {"type":"content_block_stop","index":0}',
    '', 'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}',
    '', 'event: message_stop', 'data: {"type":"message_stop"}', '', '',
  ].join('\n');
  return { first, final };
}

function rejectionResponse(rejection?: SdkRejection) {
  if (!rejection) return { status: 401, body: { error: { type: 'authentication_error', message: 'Fixture registry credential rejected.' } } };
  return { status: rejection.status, body: { error: { type: rejection.outcome === 'quota' ? 'rate_limit_error' : 'billing_error',
    message: 'Fixture registry account pool rejected the request.' } } };
}

function registryFailureResponder(outcome: SdkNativeOutcome, rejection: SdkRejection | undefined,
  registryModel: () => string | undefined) {
  return (body: Record<string, unknown>) => {
    if (body.model !== registryModel()) return undefined;
    if (outcome === 'unknown') return { disconnect: true } as const;
    if (outcome === 'pending') return undefined;
    return rejectionResponse(rejection);
  };
}

function nativeStreamResponder(input: {
  outcome: SdkNativeOutcome;
  registryModel: () => string | undefined;
  nativeModel: () => string | undefined;
  pendingClosed: () => void;
  markPrimaryPending: () => void;
  onFinish: (finish: () => void) => void;
  resolveStarted: () => void;
  chunks: { first: string; final: string };
}) {
  return (body: Record<string, unknown>, response: http.ServerResponse): boolean => {
    if (input.outcome === 'pending' && body.model === input.registryModel()) {
      response.once('close', input.pendingClosed);
      input.markPrimaryPending();
      return true;
    }
    if (body.model !== input.nativeModel() || body.stream !== true) return false;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    input.onFinish(() => response.end(input.chunks.final));
    response.write(input.chunks.first, input.resolveStarted);
    return true;
  };
}

function nativeFetchShim(endpoint: string, calls: { nativeFetchCalls: number }): typeof fetch {
  return async (input, init) => {
    calls.nativeFetchCalls++;
    const requested = input instanceof Request ? new URL(input.url) : new URL(String(input));
    if (requested.origin !== 'https://api.anthropic.com') throw new Error('Native test transport must use the Anthropic origin.');
    const local = new URL(`${requested.pathname}${requested.search}`, new URL(endpoint).origin);
    if (local.hostname !== '127.0.0.1') throw new Error('Native test transport must stay on loopback.');
    return fetch(local, init);
  };
}

function nativeAuthResolver(calls: { nativeAuthCalls: number },
  reader?: () => Promise<{ kind: 'oauth'; token: string } | null>) {
  return async () => {
    calls.nativeAuthCalls++;
    return reader ? reader() : { kind: 'oauth' as const, token: 'fixture-native-dummy-token' };
  };
}

function primaryPendingControl() {
  let markPending = (): void => {};
  const pending = new Promise<void>(resolve => { markPending = resolve; });
  let markClosed = (): void => {};
  const closed = new Promise<void>(resolve => { markClosed = resolve; });
  return { pending, closed, markPending: () => markPending(), markClosed: () => markClosed() };
}

function nativeResponseControl() {
  let resolveStarted = (): void => {};
  const started = new Promise<void>(resolve => { resolveStarted = resolve; });
  let finish: (() => void) | undefined;
  return { started, resolveStarted: () => resolveStarted(), setFinish: (next: () => void) => { finish = next; },
    finish: () => finish?.() };
}

export async function startSdkNativeFallbackService(options: SdkNativeFallbackOptions = {}) {
  const { outcome = 'rejected', namespace = 'fixture-sdk-native', nativeAuthReader, requestDeadlines, poolAccountIds, rejection } = options;
  const built: { fixture?: MixedTransportFixture } = {};
  const calls = { nativeFetchCalls: 0, nativeAuthCalls: 0 };
  const primary = primaryPendingControl();
  const response = nativeResponseControl();
  const chunks = nativeSseChunks(namespace);
  const service = await startSdkService(endpoint => {
    built.fixture = mixedTransportContext({ endpoint, namespace, initial: 'registry', apiFormat: 'openai', poolAccountIds });
    return built.fixture.context;
  }, [], { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', ...(requestDeadlines ? { requestDeadlines } : {}),
    ...(poolAccountIds ? { poolAccountIds } : {}) },
  registryFailureResponder(outcome, rejection, () => built.fixture?.registryUpstreamModel),
  nativeStreamResponder({ outcome, registryModel: () => built.fixture?.registryUpstreamModel,
    nativeModel: () => built.fixture?.nativeUpstreamModel, pendingClosed: primary.markClosed,
    markPrimaryPending: primary.markPending, onFinish: response.setFinish, resolveStarted: response.resolveStarted,
    chunks }),
  { fetchForEndpoint: endpoint => nativeFetchShim(endpoint, calls), resolveClaudeCodeAuth: nativeAuthResolver(calls, nativeAuthReader) });
  const { fixture } = built;
  if (!fixture) throw new Error('The mixed transport fixture was never built.');
  return { service, fixture, observation: calls, responseStarted: response.started, primaryPending: primary.pending,
    primaryPendingClosed: primary.closed, finishResponse: response.finish };
}

export async function openNoticeConsumer(proxy: ProxyHandle, sessionId: string) {
  const consumer = await registerConsumer(proxy.port, sessionId, proxy.token);
  const consumerId = String(consumer.body.consumerId);
  const notices = readNoticeSequence(proxy.port, sessionId, consumerId, proxy.token);
  const connected = await notices.connected;
  expect(connected.status).toBe(200);
  return { consumerId, notices, connected };
}

export async function startNoticeGatedMixedRequest(proxy: ProxyHandle, sessionId: string,
  createRequest: () => ReturnType<typeof sendBoundRequest>) {
  const consumer = await openNoticeConsumer(proxy, sessionId);
  const request = createRequest();
  await acknowledgeLaunchNotice(proxy.port, sessionId, consumer.consumerId, proxy.token, consumer.notices);
  return { ...consumer, request };
}

export async function startInitialRoutingBinding(sessionId: string, fixture: MixedTransportFixture,
  expectedTarget: ModelRef) {
  const initial = await createRoutingBinding({ sessionId, launchId: 'front-router', role: 'router', task: '',
    config: fixture.context.config, catalog: fixture.context.catalog, workload: fixture.context.workload });
  expect(initial.decision.target).toEqual(expectedTarget);
  return initial;
}

export function acknowledgeRoutingNotice(proxy: ProxyHandle, notice: NoticeStream, consumerId: string) {
  return requestJson(proxy.port, '/v1/leverframe/routing-notice-ack', proxy.token, acknowledgment(notice.notice, consumerId));
}

export function downstreamStreamProbe() {
  const events: Array<{ kind: 'headers' } | { kind: 'data' }> = [];
  let releaseData = (): void => {};
  const firstData = new Promise<void>(resolve => { releaseData = resolve; });
  const callbacks: Record<'headers' | 'data', () => void> = { headers: () => undefined, data: () => releaseData() };
  return { events, record: (item: { kind: 'headers' } | { kind: 'data' }) => {
    events.push(item);
    callbacks[item.kind]();
  }, waitForData: async () => {
    await firstData;
    expect(events).toContainEqual({ kind: 'data' });
  } };
}

export function expectInitialMixedFallbackPending(input: {
  outcome: NoticeOrResponse;
  notice: NoticeStream | undefined;
  sessionId: string;
  previous: ModelRef;
  target: ModelRef;
  primaryModel: string;
  upstreamBodies: Array<Record<string, unknown>>;
  nativeFetchCalls: number;
  downstreamEvents: Array<{ kind: 'headers' } | { kind: 'data' }>;
  system: Array<{ text: string }>;
}): void {
  expect(input.outcome.kind).toBe('notice');
  expect(input.notice?.notice).toMatchObject({ sessionId: input.sessionId, previous: input.previous,
    target: input.target, reason: 'credential_rejected', cacheReuse: 'unknown', acknowledged: false });
  expect(input.upstreamBodies).toHaveLength(1);
  expect(input.upstreamBodies[0]?.model).toBe(input.primaryModel);
  expect(input.nativeFetchCalls).toBe(0);
  expect(input.downstreamEvents).toEqual([]);
  expect(JSON.stringify(input.upstreamBodies[0])).toContain(input.system[0]!.text);
  expect(JSON.stringify(input.upstreamBodies[0])).toContain(input.system[1]!.text);
  expect(JSON.stringify(input.upstreamBodies[0]?.tools)).toContain(agentTool.name);
}

export function expectPendingLease(pending: Awaited<ReturnType<typeof resolveRoutingBinding>>, notice: NoticeStream): void {
  expect(pending.lease).toBeTruthy();
  expect(pending.revision).toBe(notice.notice.revision);
}

export function expectLeaseHeldByInFlight(inFlight: Awaited<ReturnType<typeof resolveRoutingBinding>>, input: {
  lease: unknown;
  revision: unknown;
  target: ModelRef;
}): void {
  expect(inFlight.lease).toBe(input.lease);
  expect(inFlight.revision).toBe(input.revision);
  expect(inFlight.decision.target).toEqual(input.target);
}

export function expectNoticeAcknowledged(acknowledgment: { status: number; body: Record<string, unknown> }): void {
  expect(acknowledgment).toMatchObject({ status: 200, body: { acknowledged: true } });
}

export function expectNativeFallbackFulfilled(input: {
  acknowledgment: { status: number; body: Record<string, unknown> };
  observation: { nativeFetchCalls: number };
  upstreamBodies: Array<Record<string, unknown>>;
  nativeUpstreamModel: string;
  response: { status: string; body: Record<string, unknown> };
}): void {
  expectNoticeAcknowledged(input.acknowledgment);
  expect(input.observation.nativeFetchCalls).toBe(1);
  expect(input.upstreamBodies).toHaveLength(2);
  expect(input.upstreamBodies[1]?.model).toBe(input.nativeUpstreamModel);
  expect(input.response.status).toContain('200');
  expect(input.response.body.raw).toContain('"model":"auto"');
}

export function expectPoolFallbackPending(input: {
  observed: NoticeOrResponse;
  notice: NoticeStream | undefined;
  previous: ModelRef;
  target: ModelRef;
  reason: string;
}): void {
  expect(input.observed.kind, JSON.stringify(safeResponseSummary(input.observed))).toBe('notice');
  expect(input.notice?.notice).toMatchObject({ previous: input.previous, target: input.target,
    reason: input.reason, acknowledged: false });
}

export function expectNativePoolFallbackFulfilled(input: {
  acknowledgment: { status: number; body: Record<string, unknown> };
  upstreamRequests: Array<Record<string, unknown>>;
  observation: { nativeFetchCalls: number; requests: Array<{ body: Record<string, unknown> }> };
  nativeUpstreamModel: string;
  response: { status: string; body: Record<string, unknown> };
}): void {
  expectNoticeAcknowledged(input.acknowledgment);
  expect(input.upstreamRequests).toHaveLength(1);
  expect(input.observation.nativeFetchCalls).toBe(1);
  expect(input.observation.requests).toHaveLength(1);
  expect(input.observation.requests[0]?.body.model).toBe(input.nativeUpstreamModel);
  expect(input.response.status).toContain('200');
  expect(input.response.body.model).toBe('auto');
}

export function expectRegistryFallbackServed(input: {
  acknowledgment: { status: number; body: Record<string, unknown> };
  serviceRequests: Array<{ body: Record<string, unknown> }>;
  upstreamRequests: Array<Record<string, unknown>>;
  registryUpstreamModel: string;
  system: Array<{ text: string }>;
  downstreamEvents: Array<{ kind: 'headers' } | { kind: 'data' }>;
  response: { status: string; body: Record<string, unknown> };
}): void {
  expectNoticeAcknowledged(input.acknowledgment);
  expect(input.serviceRequests).toHaveLength(1);
  expect(input.upstreamRequests).toHaveLength(1);
  expect(input.upstreamRequests[0]?.model).toBe(input.registryUpstreamModel);
  expect(input.upstreamRequests[0]?.system).toEqual(input.system);
  expect(input.upstreamRequests[0]?.tools).toEqual([agentTool]);
  expect(input.downstreamEvents).toContainEqual({ kind: 'headers' });
  expect(input.downstreamEvents).toContainEqual({ kind: 'data' });
  expect(input.response.status).toContain('200');
  expect(input.response.body.model).toBe('auto');
}

export function expectNativeAuthAbandoned(input: {
  acknowledgment: { status: number; body: Record<string, unknown> };
  disconnectedAck: { status: number };
  response: { status: string; body: Record<string, unknown> };
  observation: { nativeAuthCalls: number; nativeFetchCalls: number };
  upstreamBodies: Array<Record<string, unknown>>;
}): void {
  expectNoticeAcknowledged(input.acknowledgment);
  expect(input.disconnectedAck.status).toBe(409);
  expect(input.response.status, JSON.stringify({ ...safeResponseSummary({ kind: 'response', response: input.response }),
    responseKeys: Object.keys(input.response.body), nativeFetchCalls: input.observation.nativeFetchCalls,
    upstreamModels: input.upstreamBodies.map(body => body.model) })).not.toContain('200');
  expect(input.response.body).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
  expect(input.observation.nativeAuthCalls).toBe(1);
  expect(input.observation.nativeFetchCalls).toBe(0);
  expect(input.upstreamBodies).toHaveLength(1);
}

export function deferredNativeAuth() {
  let begin = (): void => {};
  let release = (): void => {};
  const started = new Promise<void>(resolve => { begin = resolve; });
  const result = new Promise<{ kind: 'oauth'; token: string }>(resolve => {
    release = () => resolve({ kind: 'oauth', token: 'fixture-native-dummy-token' });
  });
  return { reader: () => { begin(); return result; }, started, release: () => release() };
}

export function noticeStreamFrom(observed: NoticeOrResponse): NoticeStream {
  expect(observed.stream).toBeDefined();
  return observed.stream as NoticeStream;
}

export function cachedSystem(prefix: string) {
  return [
    { type: 'text', text: `First ${prefix} cached system block`, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `Second ${prefix} cached system block`, cache_control: { type: 'ephemeral' } },
  ];
}
