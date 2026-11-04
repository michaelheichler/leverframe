import { ANTHROPIC_API_ORIGIN } from '../constants.js';
import { randomUUID } from 'node:crypto';
import { applyRoutingEffort } from '../routing-effort.js';
import * as http from 'node:http';
import type { ProxyHandle, ProxyRoute } from '../proxy.js';
import { readClaudeCodeAuthMaterial } from '../claude-code-credentials.js';
import { HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY } from '../env.js';
import { anthropicMessagesEndpoint } from '../anthropic-endpoints.js';
import { writeInferenceResponseErrorLog, writeInferenceResponseLifecycleLog } from '../trace-log.js';
import { rewriteUpstreamAuthHeaders } from './claude-passthrough-auth.js';
import { applyHttpPassthroughPolicy } from './context-policy.js';
import { decideHttpProxyRoute } from './routing-decision.js';
import { forwardRawAnthropicRequest, forwardToAdapter, requestHeadersWithoutProxyHeaders } from './forward.js';
import type { HttpProxyOptions } from './server.js';
import { extractClaudeSessionId } from '../sdk-adapter.js';
import { advanceRoutingFallback, assertRoutingIdentity, createRoutingBinding, ensureRoutingLaunchNotices, recordRoutingRequestCompletion, resolveRoutingBinding, routingBindingErrors, withRoutingLease, type RoutingAttemptReason, type RoutingBinding } from '../routing-bindings.js';
import { relayAnthropicMessages } from '../upstream-forward.js';
import { estimateCurrentRoutingRequest, recordFirstRoutingRequest } from '../routing-request-estimate.js';
import { assertRoutingRequest, routingRequestRequirements } from '../routing-account-eligibility.js';
import { classifyPoolFailure } from '../account-pool-dispatch.js';
import { DEFAULT_LIFECYCLE_DEADLINES } from '../request-lifecycle.js';
import { createRequestExecutionContext, type RequestExecutionContext } from '../request-execution-context.js';
import { routingGuardedFetch, withRoutingBeforeSend, type RoutingBeforeSend } from '../routing-before-send.js';
import { routingReplayCompatibility } from '../routing-replay-compatibility.js';
import { sameRef } from '../routing-policy.js';
import { routingSkipReason, writeRoutingInferenceLog } from '../routing-inference-log.js';
import { getInferenceRequestLogPath } from '../log-paths.js';

const ROUTING_NOTICE_TIMEOUT_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;

type NativeRoutingAttempt = { kind: 'terminal' } | { kind: 'missing_credential' }
  | { kind: 'rejected'; status: number; body: string; headers: Headers };

function nativeFailureReason(attempt: Exclude<NativeRoutingAttempt, { kind: 'terminal' }>): RoutingAttemptReason | undefined {
  if (attempt.kind === 'missing_credential') return 'credential_missing';
  const observation = classifyPoolFailure({ provider: 'anthropic', accountId: 'native', statusCode: attempt.status,
    body: attempt.body, headers: attempt.headers, now: Date.now() });
  if (observation?.status === 'auth_failure') return 'credential_rejected';
  if (observation?.source.endsWith(':billing')) return 'credit_exhausted';
  return observation?.status === 'rate_limited' || observation?.status === 'exhausted' ? 'quota_exhausted' : undefined;
}

interface MitmContext {
  options: HttpProxyOptions;
  routesById: Map<string, ProxyRoute>;
  adapter: ProxyHandle | null;
  adapterAgent: http.Agent;
  origin: URL;
}
type PassthroughDecision = Extract<ReturnType<typeof decideHttpProxyRoute>, { action: 'passthrough-messages' }>;

function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 50 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function usesPlaceholder(headers: http.IncomingHttpHeaders): boolean {
  const value = (name: string) => {
    const raw = headers[name];
    return Array.isArray(raw) ? raw[0] : raw;
  };
  if (value('x-api-key')?.trim() === HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY) return true;
  const authorization = value('authorization');
  return /^Bearer\s+(\S+)/i.exec(authorization?.trim() ?? '')?.[1] === HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY;
}

function missingCredential(res: http.ServerResponse, decision: PassthroughDecision): void {
  const message = 'Claude --bare placeholder cannot call Anthropic and no Claude Code '
    + 'OAuth/API credential was found. Run `claude /login` or set ANTHROPIC_API_KEY.';
  const errorBody = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } });
  if (decision.lifecycle) writeInferenceResponseErrorLog(decision.lifecycle.logPath, {
    requestId: decision.requestId, modelId: decision.modelId, provider: 'anthropic',
    route: 'passthrough', statusCode: 400, errorContent: errorBody,
  });
  res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(errorBody)) });
  res.end(errorBody);
}

async function passthrough(req: http.IncomingMessage, res: http.ServerResponse, rawBody: Buffer, decision: PassthroughDecision, context: MitmContext): Promise<void> {
  const { options, origin } = context;
  const lifecycle = decision.lifecycle;
  const policyBody = anthropicMessagesEndpoint(req.url) === 'messages'
    ? await applyHttpPassthroughPolicy(req, res, rawBody, decision.modelId, options.debug ?? false, options.debugLogPath)
    : rawBody;
  if (req.aborted || res.destroyed || res.writableEnded) return;
  let upstreamHeaders: string[] | undefined;
  if (usesPlaceholder(req.headers)) {
    const auth = await (options.resolveClaudeCodeAuth ?? readClaudeCodeAuthMaterial)();
    if (req.aborted || res.destroyed || res.writableEnded) return;
    if (!auth) { missingCredential(res, decision); return; }
    upstreamHeaders = rewriteUpstreamAuthHeaders(requestHeadersWithoutProxyHeaders(req), auth);
  }
  await forwardRawAnthropicRequest(req, res, policyBody, origin, options.anthropicRejectUnauthorized ?? true,
    lifecycle ? (statusCode, errorContent) => writeInferenceResponseErrorLog(lifecycle.logPath, {
      requestId: decision.requestId, modelId: decision.modelId, provider: 'anthropic', route: 'passthrough', statusCode, errorContent,
    }) : undefined,
    lifecycle ? usage => writeInferenceResponseLifecycleLog(lifecycle.logPath, {
      event: 'response_usage', requestId: decision.requestId, modelId: decision.modelId,
      provider: 'anthropic', route: 'passthrough', ...usage,
    }) : undefined, lifecycle, upstreamHeaders);
}

export async function handleMitmRequest(req: http.IncomingMessage, res: http.ServerResponse, context: MitmContext): Promise<void> {
  let rawBody: Buffer;
  try { rawBody = await readRawBody(req); } catch (err) {
    res.writeHead(413, { 'Content-Type': 'text/plain' });
    res.end(err instanceof Error ? err.message : String(err));
    return;
  }
  const { options, routesById, adapter, adapterAgent, origin } = context;
  if (options.routing && await forwardBoundRequest(req, res, rawBody, context)) return;
  const decision = decideHttpProxyRoute({
    method: req.method, url: req.url, headers: req.headers, rawBody, routesById,
    hasAdapter: adapter !== null, inferenceLogPath: options.inferenceLogPath,
    webSocketDiagnosticsLogPath: options.webSocketDiagnosticsLogPath,
    responseProgressIntervalMs: options.responseProgressIntervalMs,
  });
  switch (decision.action) {
    case 'translated':
      if (!adapter) throw new Error('HTTP proxy route decision selected an adapter that is no longer running');
      await forwardToAdapter(req, res, rawBody, adapter, options.adapterRequest ?? http.request, adapterAgent, decision.lifecycle);
      return;
    case 'passthrough-messages':
      await passthrough(req, res, rawBody, decision, context);
      return;
    case 'rejected': {
      const body = JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: decision.message } });
      res.writeHead(404, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
      res.end(body);
      return;
    }
    case 'raw':
      await forwardRawAnthropicRequest(req, res, rawBody, origin, options.anthropicRejectUnauthorized ?? true);
      return;
    default: {
      const exhaustive: never = decision;
      throw new Error(`Unhandled HTTP proxy route decision: ${JSON.stringify(exhaustive)}`);
    }
  }
}

async function forwardBoundRequest(req: http.IncomingMessage, res: http.ServerResponse, rawBody: Buffer, context: MitmContext): Promise<boolean> {
  if (req.method !== 'POST' || !anthropicMessagesEndpoint(req.url)) return false;
  let body: { model?: unknown; metadata?: unknown };
  try { body = JSON.parse(rawBody.toString('utf8')); } catch { return false; }
  if (!body || typeof body.model !== 'string') return false;
  const auto = context.options.routing?.config.enabled === true
    && body.model === (context.options.routing.config.visibleModelId ?? 'auto');
  if (!auto && !body.model.startsWith('leverframe:binding:')) return false;
  const header = req.headers['x-claude-code-session-id'];
  const sessionId = extractClaudeSessionId(body, Array.isArray(header) ? header[0] : header);
  try {
    if (!sessionId) throw new Error('Routing binding requires a session identity.');
    const routing = context.options.routing!;
    if (auto && !routing.routerTarget) throw Object.assign(new Error('Router preflight pin is unavailable.'), { code: routingBindingErrors.routerPinMismatch });
    const binding = auto ? await createRoutingBinding({ sessionId, launchId: 'front-router', role: 'router', task: '',
      config: routing.config, catalog: routing.catalog, workload: routing.workload, acceptNewBinding: routing.acceptNewBinding })
      : await resolveRoutingBinding({ sessionId, modelId: body.model });
    assertRoutingIdentity(binding, routing.catalog);
    if (auto) {
      const original = binding.clientTarget ?? binding.decision.target;
      if (original.providerId !== routing.routerTarget?.providerId || original.modelId !== routing.routerTarget?.modelId) {
        throw Object.assign(new Error('Saved router binding differs from the preflight pin.'), { code: routingBindingErrors.routerPinMismatch });
      }
    }
    if (anthropicMessagesEndpoint(req.url) === 'count_tokens' && binding.identity.credentialSource !== 'claude-code') {
      if (!context.adapter) throw new Error('The routing adapter is unavailable.');
      await forwardToAdapter(req, res, rawBody, context.adapter, context.options.adapterRequest ?? http.request,
        context.adapterAgent, undefined, binding.modelId);
      return true;
    }
    if (binding.identity.credentialSource !== 'claude-code' && !context.adapter?.createRoutingSession) {
      throw new Error('The routing adapter cannot handle bound requests.');
    }
    await withRoutingLease({ sessionId, modelId: binding.modelId }, current =>
      forwardNativeBinding(req, res, body as Record<string, unknown>, current, sessionId, context));

  } catch (error) {
    if (res.headersSent || res.destroyed) {
      if (!res.writableEnded) res.destroy();
      return true;
    }
    const message = error instanceof Error ? error.message : 'Routing binding is unavailable.';
    const retryable = !!error && typeof error === 'object' && 'retryable' in error && error.retryable === true;
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    res.writeHead(retryable || code === routingBindingErrors.routerPinMismatch ? 409 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message, ...(code ? { code } : {}) } }));
  }
  return true;
}

async function forwardNativeBinding(req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown>,
  binding: RoutingBinding, sessionId: string, context: MitmContext): Promise<void> {
  const endpoint = anthropicMessagesEndpoint(req.url);
  if (!endpoint || !req.url?.startsWith('/') || req.url.startsWith('//')) {
    throw Object.assign(new Error('Native routing origin changed.'), { code: routingBindingErrors.identityMismatch });
  }
  const routing = context.options.routing!;
  let original = structuredClone(body);
  const channel = routing.noticeChannel;
  const consumer = channel?.signal(sessionId);
  if (endpoint === 'messages' && (!consumer || !channel)) throw new Error('Routing notice consumer is unavailable. Reconnect the interactive session.');
  const controller = new AbortController();
  const cancel = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', cancel);
  req.once('aborted', cancel);
  if (req.aborted || res.destroyed || res.writableEnded) controller.abort();
  const totalMs = Math.min(DEFAULT_LIFECYCLE_DEADLINES.totalMs, MAX_TIMER_MS);
  const deadline = Date.now() + totalMs;
  const timer = setTimeout(() => controller.abort(), totalMs);
  const signal = controller.signal;
  const requestId = randomUUID();
  let attemptIndex = 0;
  let attemptStarted = Date.now();
  let activeBinding = binding;
  const beforeSend = createBoundSendGuard({ sessionId, getBinding: () => activeBinding, signal, deadline, consumer, channel, res });
  let adapterSession: ReturnType<NonNullable<ProxyHandle['createRoutingSession']>> | undefined;
  const getAdapterSession = () => {
    if (!context.adapter?.createRoutingSession) throw new Error('The routing adapter cannot handle bound requests.');
    return adapterSession ??= context.adapter.createRoutingSession({ req, res, sessionId,
      clientModelId: String(body.model), requestId, controller, deadline, beforeSend });
  };
  try {
    if (endpoint === 'messages') await awaitInitialRoutingNotices({ binding, sessionId, channel, consumer, deadline, signal });
    let current = binding;
    while (true) {
      if (signal.aborted || Date.now() >= deadline) throw new Error('The routing request was cancelled or timed out.');
      activeBinding = current;
      const index = ++attemptIndex;
      attemptStarted = Date.now();
      const result = await executeLoggedRoutingAttempt({ req, res, original, current, sessionId, context,
        endpoint, signal, deadline, requestId, getAdapterSession, beforeSend, attemptIndex: index });
      const { attempt, loggedBinding } = result;
      attemptStarted = result.attemptStarted;
      if (attempt.kind === 'terminal') {
        logRoutingTermination(res, routingLogPath(context), requestId, index, loggedBinding, attempt.lifecycleState, attemptStarted);
        if (endpoint === 'messages' && attempt.lifecycleState === 'completed') {
          await completeRoutingRequest({ res, signal, deadline, current, sessionId, context, requestId, index, loggedBinding });
        }
        return;
      }
      const { failure, source } = attempt;
      writeRoutingInferenceLog(routingLogPath(context), 'attempt_rejected', requestId, index, loggedBinding,
        { failure, durationMs: Date.now() - attemptStarted });
      original = attempt.request;
      if (!source || endpoint !== 'messages') throw new Error('The routing request cannot safely use another transport.');
      if (signal.aborted || res.headersSent || res.destroyed || res.writableEnded) throw new Error('The routing request cannot be replayed safely.');
      try {
        current = await advanceNativeBinding({ current, request: original, failure, source, sessionId, context,
          getAdapterSession, deadline, signal, consumer, requestId, attemptIndex: index });
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'routing_fallback_exhausted') {
          await logExhaustedRouting({ sessionId, current, context, requestId, index, loggedBinding, failure });
        }
        throw error;
      }
    }
  } catch (error) {
    logRoutingTermination(res, routingLogPath(context), requestId, Math.max(1, attemptIndex), activeBinding,
      signal.aborted ? 'cancelled' : 'failed', attemptStarted);
    throw error;
  } finally {
    clearTimeout(timer);
    res.removeListener('close', cancel);
    req.removeListener('aborted', cancel);
  }
}

async function logExhaustedRouting(input: { sessionId: string; current: RoutingBinding; context: MitmContext; requestId: string;
  index: number; loggedBinding: RoutingBinding; failure: import('../routing-fallback-contract.js').RoutingAttemptFailure }): Promise<void> {
  const { sessionId, current, context, requestId, index, loggedBinding, failure } = input;
  writeRoutingInferenceLog(routingLogPath(context), 'exhausted', requestId, index, loggedBinding, { failure });
  const saved = await resolveRoutingBinding({ sessionId, modelId: current.modelId }).catch(() => undefined);
  if (!saved) return;
  logSkippedRoutingEvents(context, requestId, index, loggedBinding, saved);
}

function logSkippedRoutingEvents(context: MitmContext, requestId: string, index: number,
  previous: RoutingBinding, saved: RoutingBinding): void {
  for (const event of saved.decision.events.slice(previous.decision.events.length)) {
    if (event.target && routingSkipReason(event.reason)) {
      writeRoutingInferenceLog(routingLogPath(context), 'fallback_skipped', requestId, index, saved,
        { skipped: { target: event.target, reason: event.reason } });
    }
  }
}

async function completeRoutingRequest(input: { res: http.ServerResponse; signal: AbortSignal; deadline: number; current: RoutingBinding;
  sessionId: string; context: MitmContext; requestId: string; index: number; loggedBinding: RoutingBinding }): Promise<void> {
  const { res, signal, deadline, current, sessionId, context, requestId, index, loggedBinding } = input;
  if (res.statusCode >= 400 || !current.lease || !await responseFinished(res, signal, deadline)) return;
  try {
    await recordRoutingRequestCompletion({ sessionId, modelId: current.modelId, revision: current.revision, leaseId: current.lease });
  } catch {
    writeRoutingInferenceLog(routingLogPath(context), 'notice_write_failed', requestId, index, loggedBinding);
  }
}

function responseFinished(res: http.ServerResponse, signal: AbortSignal, deadline: number): Promise<boolean> {
  if (signal.aborted || Date.now() >= deadline) return Promise.resolve(false);
  if (res.writableFinished) return Promise.resolve(true);
  if (res.destroyed || res.closed) return Promise.resolve(false);
  return new Promise(resolve => {
    const done = (finished: boolean) => {
      clearTimeout(timer);
      res.removeListener('finish', onFinish);
      res.removeListener('close', onClose);
      signal.removeEventListener('abort', onAbort);
      resolve(finished && !signal.aborted && Date.now() < deadline);
    };
    const onFinish = () => done(true), onClose = () => done(false), onAbort = () => done(false);
    const timer = setTimeout(onAbort, Math.max(1, deadline - Date.now()));
    res.once('finish', onFinish);
    res.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) done(false);
    else if (res.writableFinished) done(true);
    else if (res.destroyed || res.closed) done(false);
  });
}

async function awaitInitialRoutingNotices(input: { binding: RoutingBinding; sessionId: string; deadline: number; signal: AbortSignal;
  consumer?: AbortSignal; channel: NonNullable<HttpProxyOptions['routing']>['noticeChannel'] }): Promise<void> {
  const { binding, sessionId, deadline, signal, channel, consumer } = input;
  if (!binding.lease || !channel || !consumer) throw new Error('Routing lease or notice consumer is unavailable.');
  const notices = await ensureRoutingLaunchNotices({ sessionId, modelId: binding.modelId, leaseId: binding.lease, revision: binding.revision });
  for (const notice of notices) if (!notice.acknowledged) {
    await channel.wait({ sessionId, sequence: notice.sequence, modelId: notice.modelId, revision: notice.revision,
      leaseId: binding.lease, deadline: Math.min(deadline, Date.now() + ROUTING_NOTICE_TIMEOUT_MS), signal });
    if (consumer.aborted || channel.signal(sessionId) !== consumer) throw new Error('The routing notice consumer disconnected.');
  }
}

function routingLogPath(context: MitmContext): string {
  return context.options.inferenceLogPath ?? getInferenceRequestLogPath();
}

function logRoutingTermination(res: http.ServerResponse, path: string, requestId: string, attempt: number,
  binding: RoutingBinding, state: import('../request-lifecycle.js').LifecycleState | undefined, started: number): void {
  const log = (finished: boolean) => {
    res.removeListener('finish', onFinish);
    res.removeListener('close', onClose);
    const event = state === 'cancelled' ? 'request_cancelled'
      : state === 'failed' || res.statusCode >= 400 ? 'request_failed'
        : !finished ? 'request_outcome_unknown'
        : state === 'completed' ? 'request_completed' : 'request_outcome_unknown';
    writeRoutingInferenceLog(path, event, requestId, attempt, binding, { durationMs: Date.now() - started });
  };
  const onFinish = () => log(true);
  const onClose = () => log(false);
  if (state === 'failed' || state === 'cancelled') log(false);
  else if (res.writableFinished) log(true);
  else if (res.destroyed || res.closed) log(false);
  else { res.once('finish', onFinish); res.once('close', onClose); }
}

async function executeLoggedRoutingAttempt(input: { req: http.IncomingMessage; res: http.ServerResponse; original: Record<string, unknown>;
  current: RoutingBinding; sessionId: string; context: MitmContext; endpoint: NonNullable<ReturnType<typeof anthropicMessagesEndpoint>>;
  signal: AbortSignal; deadline: number; requestId: string; attemptIndex: number; beforeSend: RoutingBeforeSend;
  getAdapterSession: () => ReturnType<NonNullable<ProxyHandle['createRoutingSession']>> }) {
  const { current, original, context, endpoint, sessionId, requestId, attemptIndex, beforeSend } = input;
  const catalog = context.options.routing!.catalog;
  assertRoutingIdentity(current, catalog);
  const request = structuredClone(original);
  applyRoutingEffort(request, current.decision.effort);
  const availableCatalog = { ...catalog, models: catalog.models.map(model => ({ ...model,
    credential: { ...model.credential, available: true }, capacity: undefined })) };
  if (endpoint === 'messages') assertRoutingRequest(current, availableCatalog, request);
  await recordFirstRoutingRequest(current, request, catalog);
  const loggedBinding = await resolveRoutingBinding({ sessionId, modelId: current.modelId });
  if (loggedBinding.lease !== current.lease || loggedBinding.revision !== current.revision
    || !sameRef(loggedBinding.decision.target, current.decision.target)) throw new Error('The routing request lease changed.');
  const requestEstimate = estimateCurrentRoutingRequest(loggedBinding, request);
  if (attemptIndex === 1) writeRoutingInferenceLog(routingLogPath(context), 'decision', requestId, attemptIndex, loggedBinding, { requestEstimate });
  writeRoutingInferenceLog(routingLogPath(context), 'attempt', requestId, attemptIndex, loggedBinding, { requestEstimate });
  const attemptStarted = Date.now();
  const onUsage = (usage: import('./response-usage.js').ResponseUsage) =>
    writeRoutingInferenceLog(routingLogPath(context), 'usage', requestId, attemptIndex, loggedBinding,
      { usage, requestEstimate, durationMs: Date.now() - attemptStarted });
  const attempt = await withRoutingBeforeSend(beforeSend, () => runBoundAttempt({ ...input, request, onUsage }));
  return { attempt, loggedBinding, attemptStarted };
}

function createBoundSendGuard(input: { sessionId: string; getBinding: () => RoutingBinding; signal: AbortSignal;
  deadline: number; consumer?: AbortSignal; res: http.ServerResponse;
  channel: NonNullable<HttpProxyOptions['routing']>['noticeChannel'] }): RoutingBeforeSend {
  return {
    async verify() {
      const current = input.getBinding();
      const saved = await resolveRoutingBinding({ sessionId: input.sessionId, modelId: current.modelId });
      if (!current.lease || saved.lease !== current.lease || saved.revision !== current.revision
        || (saved.pendingNotice && !saved.pendingNotice.acknowledged)) throw new Error('The routing request lease changed.');
    },
    check() {
      if (input.signal.aborted || input.res.headersSent || input.res.destroyed || input.res.writableEnded
        || Date.now() >= input.deadline || (input.consumer
        && (input.consumer.aborted || input.channel?.signal(input.sessionId) !== input.consumer))) {
        throw new Error('The routing request was cancelled or its notice consumer disconnected.');
      }
    },
  };
}

type BoundAttemptOutcome = { kind: 'terminal'; lifecycleState?: import('../request-lifecycle.js').LifecycleState } | { kind: 'rejected';
  failure: import('../routing-fallback-contract.js').RoutingAttemptFailure;
  source: 'native-anthropic' | 'openai-compatible' | undefined; request: Record<string, unknown> };

async function runBoundAttempt(input: { req: http.IncomingMessage; res: http.ServerResponse; request: Record<string, unknown>;
  original: Record<string, unknown>; current: RoutingBinding; sessionId: string; context: MitmContext;
  endpoint: NonNullable<ReturnType<typeof anthropicMessagesEndpoint>>; signal: AbortSignal; deadline: number; requestId: string;
  getAdapterSession: () => ReturnType<NonNullable<ProxyHandle['createRoutingSession']>>;
  onUsage: (usage: import('./response-usage.js').ResponseUsage) => void }): Promise<BoundAttemptOutcome> {
  const { req, res, request, original, current, sessionId, context, endpoint, signal, deadline, requestId, getAdapterSession, onUsage } = input;
  if (current.identity.credentialSource !== 'claude-code') {
    const session = getAdapterSession();
    const source = session.transportFor(current.decision.target, original);
    const attempt = await session.attempt(current, request, onUsage);
    return attempt.kind === 'terminal' ? attempt : { ...attempt, source };
  }
  if (context.origin.href !== new URL(ANTHROPIC_API_ORIGIN).href) throw new Error('Native routing origin changed.');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('The routing request was cancelled or timed out.');
  const execution = createRequestExecutionContext({ requestId, provider: 'anthropic', model: current.modelId,
    signal, deadlines: { totalMs: remaining } });
  execution.startResolving();
  let attempt: NativeRoutingAttempt;
  let lifecycleState: import('../request-lifecycle.js').LifecycleState | undefined;
  try {
    attempt = await attemptNativeBinding(req, res, request, current, sessionId, context, signal, execution, onUsage);
    lifecycleState = execution.getSnapshot().state;
  }
  finally { execution.dispose(); }
  if (attempt.kind === 'terminal') return { ...attempt, lifecycleState };
  const reason = nativeFailureReason(attempt);
  if (!reason || endpoint !== 'messages') {
    if (attempt.kind === 'missing_credential') throw new Error('Native Claude credentials are unavailable.');
    res.writeHead(attempt.status, { 'Content-Type': attempt.headers.get('content-type') ?? 'application/json' });
    res.end(attempt.body);
    return { kind: 'terminal' };
  }
  return { kind: 'rejected', source: 'native-anthropic', request: original,
    failure: { reason, acceptance: attempt.kind === 'missing_credential' ? 'not_sent' : 'rejected',
      response: 'clear', output: 'none', tool: 'none' } };
}

async function advanceNativeBinding(input: { current: RoutingBinding; request: Record<string, unknown>;
  failure: import('../routing-fallback-contract.js').RoutingAttemptFailure; source: 'native-anthropic' | 'openai-compatible';
  sessionId: string; context: MitmContext; getAdapterSession: () => ReturnType<NonNullable<ProxyHandle['createRoutingSession']>>;
  deadline: number; signal: AbortSignal; consumer?: AbortSignal; requestId: string; attemptIndex: number }): Promise<RoutingBinding> {
  const { current, request, failure, source, sessionId, context, getAdapterSession, deadline, signal, consumer, requestId, attemptIndex } = input;
  const compatibility = routingReplayCompatibility(request, { source, target: source });
  if (!compatibility.ok) throw Object.assign(new Error('The request contains state that cannot safely be replayed.'), { code: compatibility.reason });
  const routing = context.options.routing!;
  const channel = routing.noticeChannel;
  if (!channel || !consumer || consumer.aborted || channel.signal(sessionId) !== consumer || !current.lease || !current.clientTarget) {
    throw new Error('Routing fallback authorization or notice consumer is unavailable.');
  }
  const requirements = routingRequestRequirements(current, request);
  if (!Number.isSafeInteger(requirements.contextTokens) || !Number.isSafeInteger(request.max_tokens)) {
    throw new Error('Routing request bounds are unavailable.');
  }
  const next = await advanceRoutingFallback({ sessionId, modelId: current.modelId, leaseId: current.lease, revision: current.revision,
    failure, catalog: routing.catalog, requirements, maxOutputTokens: request.max_tokens as number,
    workload: { input: Buffer.byteLength(JSON.stringify(request), 'utf8'), output: request.max_tokens as number }, deadline, signal,
    candidateAllowed: target => {
      const targetTransport = target.pin?.identity.credentialSource === 'claude-code' ? 'native-anthropic'
        : context.adapter?.createRoutingSession ? getAdapterSession().transportFor(target, request) : undefined;
      return !!targetTransport && routingReplayCompatibility(request, { source, target: targetTransport }).ok;
    } });
  const notice = next.pendingNotice;
  if (!notice) throw new Error('Routing fallback notice is unavailable.');
  logSkippedRoutingEvents(context, requestId, attemptIndex, current, next);
  writeRoutingInferenceLog(routingLogPath(context), 'fallback_proposed', requestId, attemptIndex, next, { failure, previous: current.decision.target });
  await channel.wait({ sessionId, sequence: notice.sequence, modelId: next.modelId, revision: next.revision,
    leaseId: next.lease!, deadline: Math.min(deadline, Date.now() + ROUTING_NOTICE_TIMEOUT_MS), signal });
  if (consumer.aborted || channel.signal(sessionId) !== consumer) throw new Error('The routing notice consumer disconnected.');
  writeRoutingInferenceLog(routingLogPath(context), 'fallback_acknowledged', requestId, attemptIndex, next, { failure, previous: current.decision.target });
  return next;
}

async function attemptNativeBinding(req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown>,
  binding: RoutingBinding, sessionId: string, context: MitmContext, signal: AbortSignal,
  lifecycle: RequestExecutionContext, onUsage: (usage: import('./response-usage.js').ResponseUsage) => void): Promise<NativeRoutingAttempt> {
  const model = context.options.routing?.catalog.models.find(item => sameRef(item.ref, binding.decision.target)
    && item.upstreamModelId === binding.identity.upstreamModelId && item.credential.source === 'claude-code'
    && item.discovery.confirmed && item.discovery.state === 'current');
  if (!model?.upstreamModelId) throw new Error('Native routing model identity is unavailable.');
  const auth = await (context.options.resolveClaudeCodeAuth ?? readClaudeCodeAuthMaterial)();
  if (signal.aborted) throw new Error('The routing request was cancelled.');
  if (!auth) return { kind: 'missing_credential' };
  const rawHeaders = rewriteUpstreamAuthHeaders(requestHeadersWithoutProxyHeaders(req), auth);
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!;
    if (/^(?:host|content-length|transfer-encoding|connection|x-leverframe-.*)$/i.test(name)) continue;
    headers.append(name, rawHeaders[index + 1] ?? '');
  }
  const endpoint = anthropicMessagesEndpoint(req.url);
  const path = endpoint === 'count_tokens' ? '/v1/messages/count_tokens' : '/v1/messages';
  const query = new URL(req.url!, ANTHROPIC_API_ORIGIN).search;
  const beta = req.headers['anthropic-beta'];
  const version = req.headers['anthropic-version'];
  const rejection = await relayAnthropicMessages(res, new URL(path + query, ANTHROPIC_API_ORIGIN).toString(),
    { ...body, model: model.upstreamModelId }, auth.token, Boolean(body.stream), {
      authType: auth.kind === 'oauth' ? 'oauth' : 'api', inboundBeta: Array.isArray(beta) ? beta.join(',') : beta,
      inboundVersion: Array.isArray(version) ? version[0] : version, claudeCodeSessionId: sessionId,
      nativePassthroughHeaders: headers, fetch: routingGuardedFetch(context.options.nativeRoutingFetch ?? fetch), deferRejection: true,
      responseModelId: typeof body.model === 'string' ? body.model : binding.modelId, signal, lifecycle, onUsage });
  return rejection ? { kind: 'rejected', ...rejection } : { kind: 'terminal' };
}
