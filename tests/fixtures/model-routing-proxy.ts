import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { dirname, relative, sep } from 'node:path';
import { expect, vi } from 'vitest';
import { buildRoutingCatalog } from '../../src/model-routing.js';
import { localModelToRoute } from '../../src/catalog.js';
import { createRoutingBinding, routingBindingStatePath } from '../../src/routing-bindings.js';
import { DEFAULT_LIFECYCLE_DEADLINES } from '../../src/request-lifecycle.js';
import { getAppHome, getProvidersPath } from '../../src/paths.js';
import { saveRegistry } from '../../src/registry/io.js';
import { ensureHttpProxyCertificates } from '../../src/http-proxy/ca.js';
import { startHttpProxy } from '../../src/http-proxy/server.js';
import { httpProxyModelId } from '../../src/http-proxy/routes.js';
import type { ProxyRoute } from '../../src/proxy.js';
import type { RoutingControlContext } from '../../src/proxy-routing-control.js';
import type { ProviderRegistry } from '../../src/registry/types.js';
import type { LocalProvider } from '../../src/types.js';
import type { ClaudeCodeCredentialReader } from '../../src/claude-code-credentials.js';
import { input, observation, provider } from '../model-routing-fixtures.js';

const target = { providerId: 'fixture-control-provider', modelId: 'fixture-control-model' };
const proxyToken = 'fixture-proxy-token';
const testHome = process.env['LEVERFRAME_TEST_HOME'];
const capturedLoopbackFetch = globalThis.fetch.bind(globalThis);

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

export function assertIsolatedRoutingSession(sessionId: string): void {
  const statePath = routingBindingStatePath(sessionId);
  expect(testHome).toBeTruthy();
  expect(isInside(testHome!, getAppHome())).toBe(true);
  expect(isInside(testHome!, dirname(statePath))).toBe(true);
}

export function blockNonLoopbackFetch(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    if (url.hostname !== '127.0.0.1') throw new Error('Routing proxy fixtures allow loopback fetches only.');
    return capturedLoopbackFetch(input, init);
  });
}

export function isolatedSessionId(): string {
  const sessionId = randomUUID();
  assertIsolatedRoutingSession(sessionId);
  return sessionId;
}

export function sdkRoutingContext(visibleModelId?: string, endpoint?: string,
  transport: { providerId?: string; modelId?: string; upstreamModelId?: string; providerNpm?: string;
    modelNpm?: string; modelFormat?: 'openai' | 'anthropic' } = {}): RoutingControlContext {
  const routeTarget = { ...target, providerId: transport.providerId ?? target.providerId };
  routeTarget.modelId = transport.modelId ?? target.modelId;
  const providerNpm = transport.providerNpm ?? '@ai-sdk/openai-compatible';
  const effectiveEndpoint = endpoint ?? 'http://127.0.0.1:43123/v1';
  const modelCache = {
    fetchedAt: '2026-10-01T00:00:00.000Z',
    source: 'account' as const,
    models: [{
      id: routeTarget.modelId,
      name: routeTarget.modelId,
      upstreamModelId: transport.upstreamModelId ?? 'fixture-upstream-model',
      modelFormat: transport.modelFormat ?? 'openai',
      ...(transport.modelNpm ? { npm: transport.modelNpm } : {}),
      contextWindow: 70_000,
      outputTokenLimit: 13_000,
      supportedReasoningEfforts: ['low'],
      pricing: { input: 2, output: 8, source: 'fixture-pricing' },
    }],
  };
  const registeredProvider = provider({
    id: routeTarget.providerId,
    templateId: 'fixture',
    api: { npm: providerNpm, url: effectiveEndpoint },
    billing: { kind: 'metered', source: 'fixture-billing', observedAt: '2026-10-01T00:00:00.000Z' },
    modelsCache: modelCache,
    accounts: [{ id: 'default', authRef: `keyring:provider:${routeTarget.providerId}`, enabled: true, modelsCache: modelCache }],
  });
  const snapshot = input([registeredProvider], {
    credentials: [{ ...observation(registeredProvider.id), accountId: 'default' }],
    discovery: [{ providerId: registeredProvider.id, accountId: 'default', status: 'live', cacheFetchedAt: '2026-10-01T00:00:00.000Z' }],
  });
  return {
    proxyToken,
    routerTarget: routeTarget,
    config: { enabled: true, visibleModelId, cheapFallback: routeTarget, pool: [routeTarget],
      categories: { implementation: { target: routeTarget, effort: 'low' } } },
    catalog: buildRoutingCatalog(snapshot),
    workload: { cacheRead: 0, cacheWrite: 0 },
  };
}


export async function createBoundRoutingJob(context: RoutingControlContext, sessionId: string, launchId: string) {
  assertIsolatedRoutingSession(sessionId);
  return createRoutingBinding({ sessionId, launchId, role: 'specialist', category: 'implementation',
    task: 'Run the integration task', config: context.config, catalog: context.catalog, workload: context.workload });
}

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback fixture did not bind');
  return address.port;
}

async function connectMitm(proxyPort: number, ca: string, token: string): Promise<tls.TLSSocket> {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  const auth = Buffer.from(`leverframe:${token}`).toString('base64');
  socket.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
  let response = Buffer.alloc(0);
  while (!response.includes(Buffer.from('\r\n\r\n'))) {
    const [chunk] = await once(socket, 'data') as [Buffer];
    response = Buffer.concat([response, chunk]);
  }
  const boundary = response.indexOf('\r\n\r\n') + 4;
  expect(response.subarray(0, boundary).toString()).toContain('200 Connection Established');
  const remainder = response.subarray(boundary);
  if (remainder.length > 0) socket.unshift(remainder);
  const secure = tls.connect({ socket, servername: 'api.anthropic.com', ca });
  await once(secure, 'secureConnect');
  return secure;
}

async function readHttpResponse(socket: tls.TLSSocket,
  onDownstreamEvent?: (event: { kind: 'headers' } | { kind: 'data' }) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let response = '';
    let headersObserved = false;
    const finish = () => {
      socket.off('data', read);
      socket.off('end', finish);
      socket.off('close', finish);
      socket.off('error', fail);
      resolve(response);
    };
    const fail = (error: Error) => {
      socket.off('data', read);
      socket.off('end', finish);
      socket.off('error', fail);
      reject(error);
    };
    const read = (chunk: Buffer) => {
      const previousHeaderEnd = response.indexOf('\r\n\r\n');
      const previousBodyLength = previousHeaderEnd < 0 ? 0
        : Buffer.byteLength(response.slice(previousHeaderEnd + 4));
      response += chunk.toString();
      const headerEnd = response.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      if (!headersObserved) {
        headersObserved = true;
        onDownstreamEvent?.({ kind: 'headers' });
      }
      const headers = response.slice(0, headerEnd);
      const body = response.slice(headerEnd + 4);
      if (Buffer.byteLength(body) > previousBodyLength) onDownstreamEvent?.({ kind: 'data' });
      const length = /content-length:\s*(\d+)/i.exec(headers)?.[1];
      if (length !== undefined && Buffer.byteLength(body) >= Number(length)) finish();
      if (/transfer-encoding:\s*chunked/i.test(headers) && body.endsWith('0\r\n\r\n')) finish();
    };
    socket.on('data', read);
    socket.once('end', finish);
    socket.once('close', finish);
    socket.once('error', fail);
  });
}

function decodeChunked(body: string): string {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset);
    if (lineEnd < 0) break;
    const size = Number.parseInt(body.slice(offset, lineEnd), 16);
    if (size === 0) break;
    const start = lineEnd + 2;
    chunks.push(body.slice(start, start + size));
    offset = start + size + 2;
  }
  return chunks.join('');
}

export async function sendBoundRequest(proxy: Awaited<ReturnType<typeof startHttpProxy>>, ca: string,
  sessionId: string, modelId: string, effort = 'high', extraHeaders: Record<string, string> = {},
  bodyOverrides: Record<string, unknown> = {}, omitSessionHeader = false,
  requestTarget = '/v1/messages', onDownstreamEvent?: (event: { kind: 'headers' } | { kind: 'data' }) => void)
  : Promise<{ status: string; body: Record<string, unknown> }> {
  const secure = await connectMitm(proxy.port, ca, proxy.token);
  const body = JSON.stringify({
    model: modelId,
    max_tokens: 80,
    output_config: { effort },
    messages: [{ role: 'user', content: 'Run the integration task' }],
    ...bodyOverrides,
  });
  const response = readHttpResponse(secure, onDownstreamEvent);
  secure.write([
    `POST ${requestTarget} HTTP/1.1`,
    'Host: api.anthropic.com',
    'Authorization: Bearer fixture-client-auth',
    ...(omitSessionHeader ? [] : [`X-Claude-Code-Session-Id: ${sessionId}`]),
    ...Object.entries(extraHeaders).map(([name, value]) => `${name}: ${value}`),
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n') + body);
  const rawResponse = await response;
  const [headers, bodyText = ''] = rawResponse.split('\r\n\r\n', 2);
  const responseBody = /transfer-encoding:\s*chunked/i.test(headers ?? '') ? decodeChunked(bodyText) : bodyText;
  let parsedBody: Record<string, unknown>;
  try { parsedBody = JSON.parse(responseBody) as Record<string, unknown>; }
  catch { parsedBody = { raw: responseBody || bodyText || rawResponse }; }
  return { status: headers?.split('\r\n')[0] ?? '', body: parsedBody };
}

export function requestJson(port: number, path: string, token: string, body: Record<string, unknown>) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const serialized = JSON.stringify(body);
    const request = http.request({ hostname: '127.0.0.1', port, method: 'POST', path,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(serialized) } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> }); }
        catch { resolve({ status: response.statusCode ?? 0, body: { raw: Buffer.concat(chunks).toString() } }); }
      });
    });
    request.on('error', reject);
    request.end(serialized);
  });
}

export function registerConsumer(port: number, session: string, token: string) {
  return requestJson(port, '/v1/leverframe/routing-notice-ready', token, { sessionId: session, protocolVersion: 1 });
}

export type ConnectedNoticeStream = { status: number; close: () => void; closed: Promise<void> };
export type NoticeStream = ConnectedNoticeStream & { notice: Record<string, unknown> };

export function readNotice(port: number, session: string, consumer: string, token: string, after = 0): {
  connected: Promise<ConnectedNoticeStream>;
  notice: Promise<NoticeStream>;
} {
  const query = new URLSearchParams({ sessionId: session, after: String(after) });
  const deadline = AbortSignal.timeout(DEFAULT_LIFECYCLE_DEADLINES.totalMs);
  let resolveConnected!: (stream: ConnectedNoticeStream) => void;
  let rejectConnected!: (error: unknown) => void;
  let resolveNotice!: (stream: NoticeStream) => void;
  let rejectNotice!: (error: unknown) => void;
  const connected = new Promise<ConnectedNoticeStream>((resolve, reject) => {
    resolveConnected = resolve;
    rejectConnected = reject;
  });
  const notice = new Promise<NoticeStream>((resolve, reject) => {
    resolveNotice = resolve;
    rejectNotice = reject;
  });
  const request = http.request({ hostname: '127.0.0.1', port, method: 'GET',
      path: `/v1/leverframe/routing-events?${query}`, signal: deadline,
      headers: { Authorization: `Bearer ${token}`, 'x-leverframe-notice-consumer': consumer } }, response => {
    let content = '';
    const close = () => request.destroy();
    const closed = new Promise<void>(finish => response.once('close', finish));
    resolveConnected({ status: response.statusCode ?? 0, close, closed });
    response.on('data', chunk => {
      content += Buffer.from(chunk).toString();
      const boundary = /\r?\n\r?\n/.exec(content);
      if (!boundary) return;
      const event = content.slice(0, boundary.index);
      const payload = /^data:\s*(.+)$/m.exec(event)?.[1];
      if (!payload) return rejectNotice(new Error('The routing event was incomplete.'));
      resolveNotice({ status: response.statusCode ?? 0, notice: JSON.parse(payload) as Record<string, unknown>, close, closed });
    });
    response.on('end', () => rejectNotice(new Error('The routing event stream ended before a notice arrived.')));
    response.on('close', () => {
      if (!content.includes('\ndata: ')) rejectNotice(new Error('The routing event stream closed before a notice arrived.'));
    });
  });
  request.on('error', error => { rejectConnected(error); rejectNotice(error); });
  request.end();
  return { connected, notice };
}

export function readNoticeSequence(port: number, session: string, consumer: string, token: string, after = 0) {
  const query = new URLSearchParams({ sessionId: session, after: String(after) });
  const deadline = AbortSignal.timeout(DEFAULT_LIFECYCLE_DEADLINES.totalMs);
  const queue: Array<{ eventId: string; notice: Record<string, unknown>; status: number;
    close: () => void; closed: Promise<void> }> = [];
  const waiters: Array<{
    resolve: (event: { eventId: string; notice: Record<string, unknown>; status: number;
      close: () => void; closed: Promise<void> }) => void;
    reject: (error: unknown) => void;
  }> = [];
  let resolveConnected!: (stream: ConnectedNoticeStream) => void;
  let rejectConnected!: (error: unknown) => void;
  const connected = new Promise<ConnectedNoticeStream>((resolve, reject) => {
    resolveConnected = resolve;
    rejectConnected = reject;
  });
  const close = () => request.destroy();
  const rejectWaiters = (error: Error) => {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };
  const request = http.request({ hostname: '127.0.0.1', port, method: 'GET',
    path: `/v1/leverframe/routing-events?${query}`, signal: deadline,
    headers: { Authorization: `Bearer ${token}`, 'x-leverframe-notice-consumer': consumer } }, response => {
    let content = '';
    const closed = new Promise<void>(finish => response.once('close', finish));
    resolveConnected({ status: response.statusCode ?? 0, close, closed });
    response.on('data', chunk => {
      content += Buffer.from(chunk).toString();
      let boundary = /\r?\n\r?\n/.exec(content);
      while (boundary) {
        const event = content.slice(0, boundary.index);
        content = content.slice(boundary.index + boundary[0].length);
        const eventId = /^id:\s*(.+)$/m.exec(event)?.[1];
        const payload = /^data:\s*(.+)$/m.exec(event)?.[1];
        if (!eventId || !payload) {
          rejectWaiters(new Error('The routing event was incomplete.'));
          return;
        }
        const notice = { eventId, notice: JSON.parse(payload) as Record<string, unknown>, status: response.statusCode ?? 0,
          close, closed };
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(notice);
        else queue.push(notice);
        boundary = /\r?\n\r?\n/.exec(content);
      }
    });
    response.on('end', () => rejectWaiters(new Error('The routing event stream ended before the next notice.')));
    response.on('close', () => rejectWaiters(new Error('The routing event stream closed before the next notice.')));
  });
  request.on('error', error => {
    rejectConnected(error);
    rejectWaiters(error);
  });
  request.end();
  return {
    connected,
    nextNotice() {
      const event = queue.shift();
      if (event) return Promise.resolve(event);
      return new Promise<{ eventId: string; notice: Record<string, unknown>; status: number;
        close: () => void; closed: Promise<void> }>((resolve, reject) => { waiters.push({ resolve, reject }); });
    },
    close,
  };
}

export type NoticeOrResponse = { kind: string; stream?: NoticeStream;
  response?: Awaited<ReturnType<typeof sendBoundRequest>>; error?: unknown };

export function noticeOrResponse(notice: Promise<NoticeStream>,
  request: Promise<Awaited<ReturnType<typeof sendBoundRequest>>>): Promise<NoticeOrResponse> {
  return Promise.race([
    notice.then(stream => ({ kind: 'notice', stream }), error => ({ kind: 'notice-error', error })),
    request.then(response => ({ kind: 'response', response }), error => ({ kind: 'request-error', error })),
  ]);
}

export function safeResponseSummary(outcome: NoticeOrResponse) {
  const error = outcome.response?.body['error'];
  return { kind: outcome.kind, status: outcome.response?.status,
    code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
    message: error && typeof error === 'object' && 'message' in error ? error.message : undefined };
}

export function acknowledgment(notice: Record<string, unknown>, consumerId: string) {
  return { sessionId: notice.sessionId, consumerId, sequence: notice.sequence,
    modelId: notice.modelId, revision: notice.revision };
}

export async function acknowledgeLaunchNotice(port: number, sessionId: string, consumerId: string, token: string,
  notices: ReturnType<typeof readNoticeSequence>): Promise<void> {
  const event = await notices.nextNotice();
  expect(event.notice).toMatchObject({ kind: 'launch', sessionId, acknowledged: false });
  const acknowledgmentResponse = await requestJson(port, '/v1/leverframe/routing-notice-ack', token,
    acknowledgment(event.notice, consumerId));
  expect(acknowledgmentResponse).toMatchObject({ status: 200, body: { acknowledged: true } });
}

type SdkRouteOverride = { upstreamUrl?: string; baseURL?: string; npm?: string; modelFormat?: 'openai' | 'anthropic';
  defaultReasoningEffort?: string; supportedReasoningEfforts?: string[]; requestDeadlines?: ProxyRoute['requestDeadlines'];
  poolAccountIds?: string[] };

function sdkRoute(baseURL: string, routeTarget = target, upstreamModelId = 'fixture-upstream-model',
  override: SdkRouteOverride = {}): ProxyRoute {
  const npm = override.npm ?? '@ai-sdk/openai-compatible';
  const localProvider: LocalProvider = {
    id: routeTarget.providerId,
    name: 'Fixture SDK provider',
    apiKey: 'fixture-provider-key',
    authType: 'api',
    models: [{
      id: routeTarget.modelId,
      name: 'Fixture SDK model',
      family: 'fixture',
      brand: 'fixture',
      upstreamModelId,
      modelFormat: override.modelFormat ?? 'openai',
      npm,
      apiBaseUrl: override.baseURL ?? baseURL,
      completionsUrl: override.upstreamUrl ?? `${baseURL}/chat/completions`,
      contextWindow: 70_000,
      outputTokenLimit: 13_000,
      ...(override.poolAccountIds ? {} : { accountId: 'default' }),
      supportedReasoningEfforts: override.supportedReasoningEfforts ?? ['low'],
      reasoning: true,
      supportsReasoningToggle: true,
    }],
  };
  const materialized = localModelToRoute(localProvider, localProvider.models[0]!);
  if (!materialized) throw new Error('The synthetic SDK route is not materializable.');
  return {
    ...materialized,
    aliasId: httpProxyModelId(routeTarget.providerId, routeTarget.modelId),
    displayName: 'Fixture SDK model',
    ...(override.defaultReasoningEffort ? { defaultReasoningEffort: override.defaultReasoningEffort } : {}),
    ...(override.requestDeadlines ? { requestDeadlines: override.requestDeadlines } : {}),
  };
}

function persistSdkRegistry(context: RoutingControlContext, routes: ProxyRoute[], pooledProviderId?: string,
  poolAccountIds?: string[]): void {
  const home = process.env['LEVERFRAME_TEST_HOME'];
  const registryPath = getProvidersPath();
  expect(home).toBeTruthy();
  expect(isInside(home!, getAppHome())).toBe(true);
  expect(isInside(home!, registryPath)).toBe(true);
  const used = new Set<string>();
  const providers: ProviderRegistry['providers'] = [];
  for (const route of routes) {
    if (!route.providerId) continue;
    const key = `${route.providerId}:${route.aliasId}`;
    if (used.has(key)) continue;
    used.add(key);
    const model = context.catalog.models.find(item => item.ref.providerId === route.providerId
      && item.ref.modelId === route.aliasId.slice(route.aliasId.indexOf(':', 'leverframe:'.length) + 1));
    if (!model) continue;
    const fetchedAt = model.discovery.fetchedAt;
    const apiUrl = route.baseURL ?? route.upstreamUrl;
    const cachedModel = {
      id: model.ref.modelId,
      name: model.ref.modelId,
      upstreamModelId: model.upstreamModelId ?? route.realModelId,
      modelFormat: route.modelFormat,
      npm: route.npm,
      apiUrl,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxOutputTokens === undefined ? {} : { outputTokenLimit: model.maxOutputTokens }),
      ...(model.supportedReasoningEfforts === undefined ? {} : { supportedReasoningEfforts: model.supportedReasoningEfforts }),
      reasoning: model.confirmedCapabilities.includes('reasoning'),
      vision: model.confirmedCapabilities.includes('images'),
      supportedParameters: model.confirmedCapabilities.includes('tools') ? ['tools'] : [],
    };
    const existing = providers.find(item => item.id === route.providerId);
    if (existing) {
      existing.modelsCache?.models.push(cachedModel);
      existing.accounts?.[0]?.modelsCache?.models.push(cachedModel);
    } else {
      const modelsCache = { fetchedAt, source: 'account' as const, models: [cachedModel] };
      const accountIds = route.providerId === pooledProviderId && poolAccountIds ? poolAccountIds : ['default'];
      providers.push(provider({ id: route.providerId, templateId: 'fixture', authType: 'api',
        api: { url: apiUrl, npm: route.npm }, modelsCache,
        accounts: accountIds.map(accountId => ({ id: accountId,
          authRef: route.providerId === pooledProviderId ? `keyring:provider:${route.providerId}:${accountId}`
            : `keyring:provider:${route.providerId}`, enabled: true, modelsCache })) }));
    }
  }
  saveRegistry({ schemaVersion: 1, providers });
}

export async function startSdkService(contextSource: RoutingControlContext & { routerTarget?: { providerId: string; modelId: string } }
  | ((endpoint: string) => RoutingControlContext & { routerTarget?: { providerId: string; modelId: string } }),
  additionalModels: Array<{ providerId: string; modelId: string; upstreamModelId: string } & SdkRouteOverride>
    | ((endpoint: string) => Array<{ providerId: string; modelId: string; upstreamModelId: string } & SdkRouteOverride>) = [],
  routeOptions: SdkRouteOverride = {},
  responseForRequest?: (body: Record<string, unknown>) => { status: number; body: Record<string, unknown> }
    | { disconnect: true } | undefined,
  streamForRequest?: (body: Record<string, unknown>, response: http.ServerResponse) => boolean,
  nativeDependencies?: { fetchForEndpoint?: (endpoint: string) => typeof fetch;
    resolveClaudeCodeAuth?: ClaudeCodeCredentialReader }) {
  const certificates = ensureHttpProxyCertificates();
  const upstreamBodies: Record<string, unknown>[] = [];
  const upstreamHeaders: Array<Record<string, string | string[] | undefined>> = [];
  const providerServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    await once(req, 'end');
    const requestBody = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    upstreamBodies.push(requestBody);
    upstreamHeaders.push({ ...req.headers });
    const configuredResponse = responseForRequest?.(requestBody);
    if (configuredResponse && 'disconnect' in configuredResponse) {
      res.destroy();
      return;
    }
    if (configuredResponse) {
      res.writeHead(configuredResponse.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(configuredResponse.body));
      return;
    }
    if (streamForRequest?.(requestBody, res)) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(routeOptions.npm === '@ai-sdk/google' ? {
      candidates: [{ content: { parts: [{ text: 'Fixture answer' }], role: 'model' }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
    } : {
      id: 'fixture-completion',
      object: 'chat.completion',
      created: 1,
      model: 'fixture-upstream-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Fixture answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }));
  });
  const port = await listen(providerServer);
  const endpoint = `http://127.0.0.1:${port}/v1`;
  const context = typeof contextSource === 'function' ? contextSource(endpoint) : contextSource;
  const extraRoutes = typeof additionalModels === 'function' ? additionalModels(endpoint) : additionalModels;
  const { proxyToken: _proxyToken, ...routing } = context;
  const registryPrimary = context.routerTarget && context.catalog.models.some(model =>
    model.ref.providerId === context.routerTarget!.providerId && model.ref.modelId === context.routerTarget!.modelId
    && model.credential.source === 'registry' && model.discovery.confirmed && !!model.upstreamModelId?.trim()
    && /^[a-f0-9]{64}$/.test(model.transportFingerprint ?? '')) ? context.routerTarget : target;
  const primaryCatalogModel = context.catalog.models.find(model => model.ref.providerId === registryPrimary.providerId
    && model.ref.modelId === registryPrimary.modelId);
  const routes = [sdkRoute(endpoint, registryPrimary, primaryCatalogModel?.upstreamModelId ?? 'fixture-upstream-model', routeOptions), ...extraRoutes.map(model =>
    sdkRoute(endpoint, model, model.upstreamModelId, model))];
  persistSdkRegistry(context, routes, routeOptions.poolAccountIds ? registryPrimary.providerId : undefined, routeOptions.poolAccountIds);
  const proxy = await startHttpProxy({ routes, routing, proxyAuthToken: proxyToken,
    ...(nativeDependencies?.fetchForEndpoint ? { nativeRoutingFetch: nativeDependencies.fetchForEndpoint(endpoint) } : {}),
    ...(nativeDependencies?.resolveClaudeCodeAuth ? { resolveClaudeCodeAuth: nativeDependencies.resolveClaudeCodeAuth } : {}) });
  return {
    context,
    proxy,
    certificates,
    upstreamBodies,
    upstreamHeaders,
    close: async () => {
      await proxy.close();
      providerServer.closeAllConnections();
      await new Promise<void>(resolve => providerServer.close(() => resolve()));
    },
  };
}

export async function startNativeService(context: RoutingControlContext, options: {
  anthropicOrigin?: string; injectNativeRoutingFetch?: boolean;
  routes?: ProxyRoute[];
  responseForRequest?: (body: Record<string, unknown>) => { status: number; body: Record<string, unknown> } | undefined;
  streamForRequest?: (body: Record<string, unknown>, response: http.ServerResponse) => boolean;
} = {}) {
  const certificates = ensureHttpProxyCertificates();
  const observation = {
    body: undefined as Record<string, unknown> | undefined,
    requests: [] as Array<{ body: Record<string, unknown>; authorization?: string; session?: string;
      beta?: string; version?: string; customHeader?: string; internalHeaders?: string[] }>,
    requestUrl: undefined as string | undefined,
    authorization: undefined as string | undefined,
    session: undefined as string | undefined,
    beta: undefined as string | undefined,
    version: undefined as string | undefined,
    customHeader: undefined as string | undefined,
    credentialReads: 0,
    nativeFetchCalls: 0,
  };
  const origin = http.createServer(async (req, res) => {
    observation.requestUrl = req.url;
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    await once(req, 'end');
    observation.body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    observation.authorization = req.headers.authorization;
    observation.session = req.headers['x-claude-code-session-id'] as string | undefined;
    observation.beta = req.headers['anthropic-beta'] as string | undefined;
    observation.version = req.headers['anthropic-version'] as string | undefined;
    observation.customHeader = req.headers['x-fixture-client'] as string | undefined;
    observation.requests.push({ body: observation.body, authorization: observation.authorization,
      session: observation.session, beta: observation.beta, version: observation.version,
      customHeader: observation.customHeader,
      internalHeaders: Object.keys(req.headers).filter(name => name.toLowerCase().startsWith('x-leverframe-')) });
    if (options.streamForRequest?.(observation.body, res)) return;
    const configuredResponse = options.responseForRequest?.(observation.body);
    if (configuredResponse) {
      res.writeHead(configuredResponse.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(configuredResponse.body));
      return;
    }
    if (observation.body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"fixture-native-response","type":"message","role":"assistant","model":"claude-fixture-upstream-model","content":[],"usage":{"input_tokens":5,"output_tokens":0}}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
        '',
      ].join('\n'));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'fixture-native-response',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Fixture native answer' }],
      model: 'claude-fixture-upstream-model',
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    }));
  });
  const port = await listen(origin);
  const localOrigin = `http://127.0.0.1:${port}`;
  const nativeRoutingFetch: typeof fetch = async (input, init) => {
    observation.nativeFetchCalls++;
    const requested = input instanceof Request ? new URL(input.url) : new URL(String(input));
    if (requested.origin !== 'https://api.anthropic.com') throw new Error('Native transport must use the canonical Anthropic origin.');
    const loopback = new URL(`${requested.pathname}${requested.search}`, localOrigin);
    if (loopback.hostname !== '127.0.0.1') throw new Error('Native test transport must stay on loopback.');
    return capturedLoopbackFetch(loopback, init);
  };
  const { proxyToken: _proxyToken, ...routing } = context;
  const proxyOptions = {
    routes: options.routes ?? [], routing, proxyAuthToken: proxyToken,
    anthropicOrigin: options.anthropicOrigin ?? 'https://api.anthropic.com',
    ...(options.injectNativeRoutingFetch ? { nativeRoutingFetch } : {}),
    resolveClaudeCodeAuth: async () => {
      observation.credentialReads++;
      return { kind: 'oauth', token: 'fixture-native-token' };
    },
  } as Parameters<typeof startHttpProxy>[0];
  const proxy = await startHttpProxy(proxyOptions);
  return {
    proxy,
    certificates,
    observation,
    close: async () => {
      await proxy.close();
      origin.closeAllConnections();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    },
  };
}

export function nativeRoutingContext(visibleModelId?: string): RoutingControlContext {
  const nativeRef = { providerId: 'anthropic', modelId: 'claude-fixture-subscription-model' };
  const nativeProvider = provider({
    id: nativeRef.providerId,
    templateId: 'anthropic',
    credentialSource: 'claude-code',
    billing: { kind: 'subscription', source: 'fixture-plan', observedAt: '2026-10-01T00:00:00.000Z' },
    modelsCache: {
      fetchedAt: '2026-10-01T00:00:00.000Z',
      source: 'harness',
      models: [{ id: nativeRef.modelId, name: nativeRef.modelId, upstreamModelId: 'claude-fixture-upstream-model',
        modelFormat: 'anthropic', contextWindow: 70_000, supportedReasoningEfforts: ['low'],
        pricing: { input: 2, output: 8, source: 'fixture-pricing' } }],
    },
  });
  const snapshot = input([nativeProvider], {
    credentials: [observation(nativeProvider.id, 'oauth')],
    discovery: [{ providerId: nativeProvider.id, status: 'live', cacheFetchedAt: '2026-10-01T00:00:00.000Z' }],
  });
  return {
    proxyToken,
    routerTarget: nativeRef,
    config: { enabled: true, visibleModelId, cheapFallback: nativeRef, pool: [nativeRef],
      categories: { implementation: { target: nativeRef, effort: 'low' } } },
    catalog: buildRoutingCatalog(snapshot),
    workload: { cacheRead: 0, cacheWrite: 0 },
  };
}
