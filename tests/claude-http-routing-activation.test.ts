import { once } from 'node:events';
import * as http from 'node:http';
import { rmSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { expect, beforeEach, afterEach, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

const seams = vi.hoisted(() => ({
  launchClaude: vi.fn(async (_input: { env: NodeJS.ProcessEnv; model?: string; extraArgs?: string[] }) => 0),
  fetchFreshProviderCatalog: vi.fn(),
  resolveLocalProviderApiKey: vi.fn(),
  resolveProviderAuth: vi.fn(),
  resolveProviderAccountAuth: vi.fn(),
  readNativeAuth: vi.fn(),
  fetchNativeModels: vi.fn(),
  readiness: vi.fn(async (_input: unknown) => undefined),
}));

vi.mock('../src/launch.js', () => ({ launchClaude: seams.launchClaude }));
vi.mock('../src/provider-catalog.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/provider-catalog.js')>(),
  fetchFreshProviderCatalog: seams.fetchFreshProviderCatalog,
  resolveLocalProviderApiKey: seams.resolveLocalProviderApiKey,
}));
vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  resolveProviderAuth: seams.resolveProviderAuth,
  resolveProviderAccountAuth: seams.resolveProviderAccountAuth,
}));
vi.mock('../src/claude-code-credentials.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/claude-code-credentials.js')>(),
  readClaudeCodeAuthMaterial: seams.readNativeAuth,
}));
vi.mock('../src/registry/anthropic-models-fetch.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/registry/anthropic-models-fetch.js')>(),
  fetchAnthropicModels: seams.fetchNativeModels,
}));
vi.mock('../src/patcher.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/patcher.js')>(),
  runLaunchPatchCheck: seams.readiness,
}));

import { savePreferences } from '../src/config.js';
import { getAppHome, getConfigPath, getProvidersPath } from '../src/paths.js';
import { saveRegistry } from '../src/registry/io.js';
import type { LocalProvider } from '../src/types.js';
import type { ProviderRegistry } from '../src/registry/types.js';
import { loadRegistry } from '../src/registry/io.js';
import type { RoutingConfig } from '../src/model-routing.js';
import { runClaudeHttpProxyCommand } from '../src/claude-http-launch.js';
import { withProxyAnthropicOriginSettings } from '../src/env.js';
import type { ClaudeInstallation } from '../src/claude-installation.js';
import { buildRoutingCatalog, prepareRoutingHandoff, projectRoutingPromptPolicy } from '../src/model-routing.js';
import { createRoutingBinding, routingBindingStatePath, scanRoutingRecovery } from '../src/routing-bindings.js';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import * as proxyServer from '../src/http-proxy/server.js';
import { ROUTING_ACTIVE_ENV, ROUTING_ACTIVE_VALUE, ROUTING_NOTICE_ACTIVE_ENV } from '../src/constants.js';
import { input, observation } from './model-routing-fixtures.js';
import { acknowledgment, noticeOrResponse, readNoticeSequence, registerConsumer, requestJson, safeResponseSummary,
  sendBoundRequest } from './fixtures/model-routing-proxy.js';

const outerHome = process.env['LEVERFRAME_TEST_HOME'];
const realFetch = globalThis.fetch.bind(globalThis);
const providerId = 'fixture-cli-routing-provider';
const modelId = 'fixture-cli-routing-model';
const defaultEndpoint = 'http://127.0.0.1:19431/v1';
let endpoint = defaultEndpoint;
const fetchedAt = '2026-10-01T00:00:00.000Z';
const ref = { providerId, modelId };
const routing: RoutingConfig = {
  enabled: true,
  visibleModelId: 'auto',
  cheapFallback: ref,
  pool: [ref],
  categories: { implementation: { target: ref, effort: 'low' } },
};
const installationPath = '/tmp/fixture-cli-installation';
const installation: ClaudeInstallation = {
  logicalPath: installationPath,
  canonicalPath: installationPath,
  installationPath,
  discoverySource: 'explicit-target',
  installationKind: 'custom',
  identity: createHash('sha256').update(installationPath).digest('hex'),
  version: '2.1.314',
  executableType: 'binary',
};

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function registry(): ProviderRegistry {
  const modelCache = { fetchedAt, source: 'account' as const, models: [{
    id: modelId,
    name: modelId,
    family: 'fixture',
    brand: 'fixture',
    upstreamModelId: 'fixture-cli-upstream-model',
    modelFormat: 'openai' as const,
    npm: '@ai-sdk/openai',
    apiUrl: endpoint,
    contextWindow: 92_000,
    outputTokenLimit: 13_000,
    supportedReasoningEfforts: ['low', 'medium'],
    pricing: { input: 2, output: 8, source: 'fixture-price', observedAt: fetchedAt },
  }] };
  return { schemaVersion: 1, providers: [{
    id: providerId,
    templateId: 'fixture',
    name: 'Fixture CLI routing provider',
    enabled: true,
    authType: 'api',
    authRef: 'keyring:synthetic-cli-provider',
    api: { url: endpoint, npm: '@ai-sdk/openai' },
    addedAt: fetchedAt,
    modelsCache: modelCache,
    accounts: [{ id: 'default', authRef: 'keyring:synthetic-cli-provider', enabled: true, modelsCache: modelCache }],
  }] };
}

function freshProvider(): LocalProvider {
  return {
    id: providerId,
    name: 'Fixture CLI routing provider',
    apiKey: 'synthetic-route-key',
    models: [{
      id: modelId,
      name: modelId,
      family: 'fixture',
      brand: 'fixture',
      upstreamModelId: 'fixture-cli-upstream-model',
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
      apiBaseUrl: endpoint,
      completionsUrl: `${endpoint}/chat/completions`,
      contextWindow: 92_000,
      outputTokenLimit: 13_000,
      supportedReasoningEfforts: ['low', 'medium'],
    }],
  };
}

function parsedArgs() {
  return { command: 'claude' as const, showHelp: false, showVersion: false, dryRun: false, trace: false, claudeArgs: [] };
}

async function invokeCli(args: string[] = ['--print', 'Synthetic task']) {
  return runClaudeHttpProxyCommand({ parsed: parsedArgs(), claudeArgs: args, agentStdout: true, installation });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(ROUTING_NOTICE_ACTIVE_ENV, 'inherited-sentinel');
  endpoint = defaultEndpoint;
  expect(outerHome).toBeTruthy();
  expect(inside(outerHome!, getAppHome())).toBe(true);
  expect(inside(outerHome!, getConfigPath())).toBe(true);
  expect(inside(outerHome!, getProvidersPath())).toBe(true);
  rmSync(getConfigPath(), { force: true });
  savePreferences({ favoriteModels: [], modelAliases: [], routing: { enabled: false, recoveryEnabled: false } });
  saveRegistry(registry());
  seams.fetchFreshProviderCatalog.mockResolvedValue({
    providers: [freshProvider()],
    unavailable: [],
    refresh: { refreshed: [{ id: providerId, name: providerId, ok: true, modelSource: 'live',
      accountResults: [{ accountId: 'default', ok: true }] }] },
  });
  seams.resolveLocalProviderApiKey.mockResolvedValue('synthetic-route-key');
  seams.resolveProviderAuth.mockResolvedValue({ apiKey: 'synthetic-registry-auth' });
  seams.resolveProviderAccountAuth.mockResolvedValue({ apiKey: 'synthetic-account-auth' });
  seams.readNativeAuth.mockImplementation(() => { throw new Error('Native auth must remain fail-fast in this provider-only case.'); });
  seams.fetchNativeModels.mockImplementation(() => { throw new Error('Native model discovery must remain fail-fast.'); });
  vi.stubGlobal('fetch', async () => { throw new Error('Network fetch is disabled in CLI activation fixtures.'); });
});

async function startLoopbackProvider() {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'fixture-recovery-response', object: 'chat.completion', created: 1,
      model: 'fixture-cli-upstream-model', choices: [{ index: 0, message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Recovery provider did not bind to loopback.');
  return { server, bodies, endpoint: `http://127.0.0.1:${address.port}/v1` };
}

async function prepareSavedBinding(sessionId: string) {
  const registeredProvider = registry().providers[0]!;
  registeredProvider.api.url = endpoint;
  registeredProvider.modelsCache!.models[0]!.apiUrl = endpoint;
  saveRegistry({ schemaVersion: 1, providers: [registeredProvider] });
  expect(loadRegistry().providers[0]?.modelsCache?.models[0]?.upstreamModelId).toBe('fixture-cli-upstream-model');
  const catalog = buildRoutingCatalog(input([registeredProvider], {
    credentials: [{ ...observation(providerId), accountId: 'default' }],
    discovery: [{ providerId, accountId: 'default', status: 'live', cacheFetchedAt: fetchedAt }],
  }));
  const statePath = routingBindingStatePath(sessionId);
  expect(inside(outerHome!, dirname(statePath))).toBe(true);
  const delegatedTask = 'Resume the previously selected implementation child';
  const prepared = prepareRoutingHandoff({ policy: projectRoutingPromptPolicy(routing), agentType: 'reviewer',
    explicitCategory: 'implementation', delegatedTask, originalTask: delegatedTask, requiredConstraints: [],
    toolInstructions: [], evidence: [], jobState: '' });
  const reviewedTask = JSON.stringify(prepared.envelope);
  const handoff = { version: 1 as const, agentType: 'reviewer', reviewedTask,
    prefix: prepared.envelope.prefix, provenance: prepared.provenance as Exclude<typeof prepared.provenance, 'unverified'> };
  return createRoutingBinding({ sessionId, launchId: 'saved-recovery-launch', role: 'specialist', agentType: 'reviewer',
    category: 'implementation', task: reviewedTask, handoff, config: routing,
    catalog, workload: { input: 100, output: 80, cacheRead: 0, cacheWrite: 0 } });
}

async function postRecoveryControl(port: number, token: string, body: Record<string, unknown>, progress: (stage: string) => void) {
  return new Promise<{ statusCode: number | undefined; body: Record<string, unknown> }>((resolve, reject) => {
    const encoded = JSON.stringify(body);
    let stage = 'request-created';
    progress(stage);
    let timer: NodeJS.Timeout;
    const request = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/v1/leverframe/routing-recovery',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(encoded), Connection: 'close' } }, response => {
      stage = `response-${response.statusCode ?? 'unknown'}`;
      progress(stage);
      const chunks: Buffer[] = [];
      response.on('data', chunk => { stage = 'response-body'; progress(stage); chunks.push(Buffer.from(chunk)); });
      response.on('end', () => {
        stage = 'response-end'; progress(stage);
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString();
        let responseBody: Record<string, unknown>;
        try { responseBody = JSON.parse(text) as Record<string, unknown>; }
        catch { responseBody = { raw: text }; }
        resolve({ statusCode: response.statusCode, body: responseBody });
      });
    });
    request.on('socket', socket => {
      stage = 'socket-created';
      progress(stage);
      socket.on('connect', () => { stage = 'connected'; progress(stage); });
    });
    request.on('error', error => { stage = `error-${error.message}`; progress(stage); clearTimeout(timer); reject(error); });
    timer = setTimeout(() => reject(new Error(`Recovery listener made no progress at ${stage} on port ${port}.`)), 2_000);
    request.end(encoded);
  });
}

function withLocalDeadline<T>(promise: Promise<T>, boundary: string, progress: () => string = () => ''): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Loopback ${boundary} did not respond at ${progress()}.`)), 4_000);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

async function sendRecoveryBoundRequest(input: {
  port: number;
  sessionId: string;
  token: string;
  caCert: string;
  binding: Awaited<ReturnType<typeof prepareSavedBinding>>;
  consumerId: string;
  notices: ReturnType<typeof readNoticeSequence>;
  providerBodies: Array<Record<string, unknown>>;
  credentialLookupsAtStart: number;
  progress: () => string;
}) {
  try {
    const request = sendBoundRequest({ port: input.port, token: input.token } as Parameters<typeof sendBoundRequest>[0],
      input.caCert, input.sessionId, input.binding.id, 'low');
    const outcome = await withLocalDeadline(noticeOrResponse(input.notices.nextNotice(), request),
      'bound launch notice', input.progress);
    expect(outcome.kind, JSON.stringify(safeResponseSummary(outcome))).toBe('notice');
    expect(outcome.stream!.notice).toMatchObject({ kind: 'launch', sessionId: input.sessionId,
      modelId: input.binding.id, revision: input.binding.revision, reason: input.binding.decision.reason,
      target: input.binding.decision.target, acknowledged: false });
    expect(input.providerBodies).toHaveLength(0);
    expect(seams.resolveProviderAccountAuth.mock.calls.length).toBe(input.credentialLookupsAtStart);
    const acknowledgmentResponse = await requestJson(input.port, '/v1/leverframe/routing-notice-ack', input.token,
      acknowledgment(outcome.stream!.notice, input.consumerId));
    expect(acknowledgmentResponse).toMatchObject({ status: 200, body: { acknowledged: true } });
    return await withLocalDeadline(request, 'bound inference', input.progress);
  } finally {
    input.notices.close();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('activates the frozen router through CLI startup and passes it to readiness and the child', async () => {
  savePreferences({ favoriteModels: [], modelAliases: [], routing });
  let loopbackConnection = false;
  seams.launchClaude.mockImplementation(async input => {
    const proxyUrl = new URL(input.env['HTTPS_PROXY']!);
    const socket = http.request({ host: proxyUrl.hostname, port: Number(proxyUrl.port), method: 'GET', path: '/' });
    socket.end();
    await once(socket, 'response');
    loopbackConnection = true;
    return 0;
  });

  const exitCode = await invokeCli();

  expect(exitCode, JSON.stringify({ providerAuth: seams.resolveProviderAuth.mock.calls,
    nativeAuth: seams.readNativeAuth.mock.calls, modelDiscovery: seams.fetchNativeModels.mock.calls })).toBe(0);
  expect(loopbackConnection).toBe(true);
  expect(seams.readiness).toHaveBeenCalledWith(expect.objectContaining({
    routingAvailable: true,
    routingConfig: expect.objectContaining({ enabled: true, visibleModelId: 'auto' }),
    routingPreflight: expect.objectContaining({
      target: ref,
      policyModelId: `leverframe:${providerId}:${modelId}`,
      metadata: expect.objectContaining({ contextWindow: 92_000, maxOutputTokens: 13_000 }),
    }),
  }));
  expect(seams.launchClaude).toHaveBeenCalledWith(expect.objectContaining({
    model: 'auto',
    extraArgs: withProxyAnthropicOriginSettings(['--print', 'Synthetic task']),
  }));
  expect(seams.launchClaude.mock.calls[0]?.[0].env[ROUTING_NOTICE_ACTIVE_ENV]).toBe(ROUTING_ACTIVE_VALUE);
  expect(seams.resolveProviderAccountAuth).toHaveBeenCalledTimes(1);
  expect(seams.resolveProviderAccountAuth).toHaveBeenCalledWith(providerId,
    expect.objectContaining({ id: 'default', enabled: true }));
  expect(seams.readNativeAuth).not.toHaveBeenCalled();
  expect(seams.fetchNativeModels).not.toHaveBeenCalled();
});

it('keeps CLI startup unrouted and skips routing credential discovery when preferences are off', async () => {
  savePreferences({ favoriteModels: [], modelAliases: [], routing: { enabled: false, recoveryEnabled: false } });
  const args = ['--print', 'Synthetic task'];

  const exitCode = await invokeCli(args);
  const readiness = seams.readiness.mock.calls[0]?.[0] as Record<string, unknown> | undefined;

  expect(exitCode).toBe(0);
  expect(readiness?.['routingAvailable']).not.toBe(true);
  expect(readiness?.['routingRecoveryOnly']).not.toBe(true);
  expect(readiness?.['routingPreflight']).toBeUndefined();
  expect(seams.launchClaude).toHaveBeenCalledWith(expect.objectContaining({
    model: undefined,
    extraArgs: withProxyAnthropicOriginSettings(args),
  }));
  expect(seams.launchClaude.mock.calls[0]?.[0].env).not.toHaveProperty(ROUTING_NOTICE_ACTIVE_ENV);
  expect(seams.resolveProviderAuth).not.toHaveBeenCalled();
  expect(seams.readNativeAuth).not.toHaveBeenCalled();
  expect(seams.fetchNativeModels).not.toHaveBeenCalled();
});

it('recovers a saved hidden child after routing is disabled without activating the auto picker', async () => {
  const sessionId = 'e1111111-1111-4111-8111-111111111111';
  const upstream = await startLoopbackProvider();
  endpoint = upstream.endpoint;
  saveRegistry(registry());
  seams.fetchFreshProviderCatalog.mockResolvedValue({
    providers: [freshProvider()], unavailable: [],
    refresh: { refreshed: [{ id: providerId, name: 'Fixture CLI routing provider', ok: true, modelSource: 'live',
      accountResults: [{ accountId: 'default', ok: true }] }] },
  });
  const binding = await prepareSavedBinding(sessionId);
  expect(scanRoutingRecovery()).toMatchObject({ needed: true, targets: [ref] });
  savePreferences({ favoriteModels: [], modelAliases: [], routing: { enabled: false, recoveryEnabled: true } });
  vi.stubGlobal('fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = request instanceof URL ? request : new URL(typeof request === 'string' ? request : request.url);
    if (requestUrl.origin !== new URL(endpoint).origin) throw new Error('Only the local recovery provider may receive fetch calls.');
    return realFetch(request, init);
  });
  let recoveryResponse: Awaited<ReturnType<typeof postRecoveryControl>> | undefined;
  let hiddenResponse: Awaited<ReturnType<typeof sendBoundRequest>> | undefined;
  let notices: ReturnType<typeof readNoticeSequence> | undefined;
  let recoveryProgress = 'not started';
  const startProxy = vi.spyOn(proxyServer, 'startHttpProxy');
  const args = ['--print', 'Synthetic recovery task'];
  seams.launchClaude.mockImplementation(async input => {
    const proxyUrl = new URL(input.env['HTTPS_PROXY']!);
    const token = input.env['LEVERFRAME_CONTEXT_SELECTION_TOKEN']!;
    const consumer = await registerConsumer(Number(proxyUrl.port), sessionId, token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(Number(proxyUrl.port), sessionId, consumerId, token);
    expect((await notices.connected).status).toBe(200);
    recoveryResponse = await withLocalDeadline(postRecoveryControl(Number(proxyUrl.port), token, {
      sessionId, launchId: 'saved-recovery-launch', agentType: 'reviewer', sidecarValid: true, marker: binding.id,
    }, stage => { recoveryProgress = stage; }), 'recovery control', () => recoveryProgress);
    const credentialLookupsAtStart = seams.resolveProviderAccountAuth.mock.calls.length;
    hiddenResponse = await sendRecoveryBoundRequest({ port: Number(proxyUrl.port), sessionId, token,
      caCert: ensureHttpProxyCertificates().caCert, binding, consumerId, notices: notices!,
      providerBodies: upstream.bodies, credentialLookupsAtStart, progress: () => recoveryProgress });
    return 0;
  });

  try {
    const exitCode = await invokeCli(args);
    const readiness = seams.readiness.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const launch = seams.launchClaude.mock.calls[0]?.[0];
    const routingContext = startProxy.mock.calls[0]?.[0].routing as {
      config?: { enabled?: boolean; pool?: Array<{ providerId: string; modelId: string }> };
      catalog?: { models?: Array<{ ref: { providerId: string; modelId: string } }> };
      recoveryOnly?: true;
    } | undefined;

    expect(exitCode).toBe(0);
    expect(readiness?.['routingRecoveryOnly']).toBe(true);
    expect(readiness?.['routingAvailable']).not.toBe(true);
    expect(readiness?.['routingPreflight']).toBeUndefined();
    expect(launch).toMatchObject({ model: undefined, extraArgs: withProxyAnthropicOriginSettings(args) });
    expect(launch?.env[ROUTING_NOTICE_ACTIVE_ENV]).toBe(ROUTING_ACTIVE_VALUE);
    expect(launch?.env).not.toHaveProperty(ROUTING_ACTIVE_ENV);
    expect(recoveryResponse?.statusCode, JSON.stringify({ body: recoveryResponse?.body,
      accountAuth: seams.resolveProviderAccountAuth.mock.calls, routingContext })).toBe(200);
    expect(recoveryResponse?.body).toMatchObject({ kind: 'bound', modelId: binding.id });
    expect(hiddenResponse?.status, JSON.stringify({ response: hiddenResponse,
      upstreamBodies: upstream.bodies, accountAuth: seams.resolveProviderAccountAuth.mock.calls })).toContain('200');
    expect(upstream.bodies[0]?.model).toBe('fixture-cli-upstream-model');
    expect(seams.readNativeAuth).not.toHaveBeenCalled();
    expect(seams.fetchNativeModels).not.toHaveBeenCalled();
    expect(seams.resolveProviderAuth).not.toHaveBeenCalled();
  } finally {
    startProxy.mockRestore();
    notices?.close();
    await new Promise<void>(resolve => { upstream.server.closeAllConnections(); upstream.server.close(() => resolve()); });
  }
}, 20_000);
