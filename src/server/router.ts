import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { listenTcpServer, tcpListenerUrlHost } from '../listener-ready.js';
import { randomUUID } from 'node:crypto';
import { isAuthorized, isLocalHostRequestAllowed } from './auth.js';
import {
  formatGatewayAnthropicModels,
  formatOpenAIModels,
  gatewayDisplayName,
  supportsDirectOpenAIChatCompletions,
  type GatewayModelOptions,
  type ModelCatalog,
  type ServerModelInfo,
  upstreamModelId,
} from './models.js';
import {
  translateOpenAiRequest,
  generateOpenAiResponse,
  streamOpenAiResponse,
  type OpenAiRequest,
} from '../openai-adapter.js';
import { sendJson, readBody } from '../http-utils.js';
import { relayAnthropicMessages } from '../upstream-forward.js';
import {
  anthropicPromptTooLongMessage,
  estimateAnthropicInputTokens,
} from '../anthropic-endpoints.js';
import { resolveProviderCredential } from '../env.js';
import { oauthAuthRef } from '../registry/import-build.js';
import { revalidateCustomEndpointUrl, type UrlSecurityResult } from '../registry/url-security.js';
import {
  injectClaudeCodeBillingSystemLine,
  injectClaudeIdentity,
  selectBetaFlags,
} from '../oauth/claude-identity.js';
import {
  getLatestMessagePreview,
  writeInferenceRequestLog,
  writeInferenceResponseErrorLog,
  writeInferenceResponseLifecycleLog,
  writeSecureLogLine,
  resetTraceLog,
  writeWebSocketDiagnosticLog,
  writeWebSocketDiagnosticRequestLog,
  type InferenceRequestLogEntry,
} from '../trace-log.js';
import type { LanguageModel } from 'ai';
import { createLanguageModel, isSdkMigratedNpm, maxToolsForNpm } from '../provider-factory.js';
import {
  anthropicErrorType,
  formatUpstreamError,
  isContextLengthExceededError,
  sdkUpstreamErrorDetails,
  sdkUpstreamResponseHeaders,
  upstreamHttpStatus,
} from '../upstream-error.js';
import { resolveContextWindow } from '../context-window.js';
import {
  translateRequest as sdkTranslateRequest,
  streamAnthropicResponse,
  generateAnthropicResponse,
  silenceSdkWarnings,
  anthropicEffortFromRequest,
  extractClaudeSessionId,
  type AnthropicRequest,
  type AnthropicUsageTrace,
} from '../sdk-adapter.js';
import {
  evictResponsesWebSocketConnectionsForAccessToken,
  withResponsesWebSocketDiagnosticContext,
} from '../oauth/responses-websocket.js';
import { ProviderRuntimeCache } from '../provider-runtime-cache.js';
import { disposeLanguageModel } from '../language-model-disposal.js';
import {
  beginExecutionTracking,
  reconcileExecutionsAtStartup,
  reconcileIncomingToolResults,
  ExecutionRecoveryBlockedError,
  EXECUTION_ID_HEADER,
  EXECUTION_GENERATION_HEADER,
  type ExecutionTrackingHandle,
} from '../execution-tracking.js';
import { buildProviderCapabilities } from '../provider-capabilities.js';
import { workspaceOrSessionHash } from '../checkpoint-store.js';
import { resolveExecutionSessionKey } from '../execution-session-key.js';
import { loadCheckpoint, type DigestableMessage } from '../execution-checkpoint.js';
import { loadLedger } from '../tool-call-ledger.js';
import { reconcileExecution, type ReconcileOutcome } from '../execution-recovery.js';
import { createRequestExecutionContext, cancelAllActiveRequestExecutions } from '../request-execution-context.js';
import { createSseHeartbeat, DELAY_FIRST_HEARTBEAT } from '../sse-heartbeat.js';

export interface ServerOptions {
  host: string;
  port: number;
  apiKey: string;
  serverPassword: string | null;
  /**
   * When true the gateway rejects any request whose Host header is not a
   * loopback form. Set when the listener is bound to 127.0.0.1 so a hostile
   * origin cannot use DNS rebinding to make the listener answer for a name
   * it controls. Network mode leaves this off and relies on the password.
   */
  enforceLocalHost?: boolean;
  catalog: ModelCatalog;
  gateway?: GatewayModelOptions;
  /**
   * Saved short alias names (leverframe models --alias) accepted as request model
   * ids. Used only to preserve the response `model` echo: an aliased request
   * must be echoed back with the exact id the client sent (see CLAUDE.md's
   * auto-compaction/context-window echo invariant).
   */
  aliasNames?: ReadonlySet<string>;
  /** When set, append structured debug lines to this file path. */
  debugLogPath?: string;
  /** When set, append privacy-minimal inference routing records as JSONL. */
  inferenceLogPath?: string;
  /** Opt-in request-envelope and WebSocket head-decision diagnostics. */
  webSocketDiagnosticsLogPath?: string;
}

export interface ServerHandle {
  host: string;
  port: number;
  url: string;
  server: Server;
  inferenceLogPath?: string;
  close: () => Promise<void>;
}

type JsonBody = Record<string, any>;

type PLog = (msg: string | (() => string)) => void;

function makeServerLog(debugLogPath: string | undefined): PLog {
  if (!debugLogPath) return () => {};
  resetTraceLog(debugLogPath);
  return (msg) => writeSecureLogLine(debugLogPath, typeof msg === 'function' ? msg() : msg);
}

function auditInference(options: ServerOptions, entry: InferenceRequestLogEntry): void {
  if (options.inferenceLogPath) writeInferenceRequestLog(options.inferenceLogPath, entry);
}

function inferenceProvider(model: ServerModelInfo): string {
  return model.providerId ?? String(model.sourceBackend);
}

function requestHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function executionCapabilities(model: ServerModelInfo, body: JsonBody) {
  const supported = model.supportedParameters ?? [];
  return buildProviderCapabilities({
    providerId: inferenceProvider(model),
    supportedParameters: supported,
    streaming: true,
    tools: Array.isArray(body.tools) || supported.includes('tools'),
    reasoning: model.reasoning,
    websocket: model.preferWebSockets,
    clientManagedState: true,
  });
}

function auditSdkError(
  options: ServerOptions,
  requestedModelId: string,
  model: ServerModelInfo,
  err: unknown,
  message: string,
): number {
  const details = sdkUpstreamErrorDetails(err);
  const statusCode = details?.statusCode ?? upstreamHttpStatus(err, message);
  if (options.inferenceLogPath && statusCode >= 400) {
    writeInferenceResponseErrorLog(options.inferenceLogPath, {
      modelId: requestedModelId,
      provider: inferenceProvider(model),
      route: 'translated',
      statusCode,
      errorContent: details?.errorContent ?? message,
      isRetryable: details?.isRetryable,
      attemptCount: details?.attemptCount,
    });
  }
  return statusCode;
}

function digestableMessageFrom(message: unknown): DigestableMessage | undefined {
  if (!message || typeof message !== 'object' || typeof (message as JsonBody).role !== 'string') return undefined;
  return { role: (message as JsonBody).role, content: (message as JsonBody).content };
}

function toDigestableMessages(body: JsonBody): DigestableMessage[] {
  const messages: DigestableMessage[] = [];
  if (typeof body.system === 'string' && body.system) messages.push({ role: 'system', content: body.system });
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      const digestable = digestableMessageFrom(message);
      if (digestable) messages.push(digestable);
    }
  }
  return messages;
}

function toolResultFromBlock(block: unknown): { toolUseId: string; content: string } | undefined {
  if (!block || typeof block !== 'object') return undefined;
  const record = block as JsonBody;
  if (record.type !== 'tool_result' || typeof record.tool_use_id !== 'string') return undefined;
  const raw = record.content;
  return { toolUseId: record.tool_use_id, content: typeof raw === 'string' ? raw : JSON.stringify(raw ?? '') };
}

function extractAnthropicToolResults(body: JsonBody): Array<{ toolUseId: string; content: string }> {
  const results: Array<{ toolUseId: string; content: string }> = [];
  if (!Array.isArray(body.messages)) return results;
  for (const message of body.messages) {
    const content = (message as JsonBody | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const result = toolResultFromBlock(block);
      if (result) results.push(result);
    }
  }
  return results;
}

function extractOpenAiToolResults(body: JsonBody): Array<{ toolUseId: string; content: string }> {
  const results: Array<{ toolUseId: string; content: string }> = [];
  if (!Array.isArray(body.messages)) return results;
  for (const message of body.messages) {
    const record = message as JsonBody | undefined;
    if (record?.role === 'tool' && typeof record.tool_call_id === 'string') {
      const raw = record.content;
      results.push({ toolUseId: record.tool_call_id, content: typeof raw === 'string' ? raw : JSON.stringify(raw ?? '') });
    }
  }
  return results;
}

interface RespondExecutionRecoveryBlockedInput {
  res: ServerResponse;
  sessionKey: string;
  requestedExecutionId: string | undefined;
  error: ExecutionRecoveryBlockedError;
}

/**
 * A blocked recovery decision (`confirmation_required` or `unrecoverable`)
 * must never fall through to an automatic replay. Echo the execution id and
 * its current on-disk generation so the caller can reconcile (CLI or the
 * authenticated CAS endpoint) before trying again.
 */
function respondExecutionRecoveryBlocked(input: RespondExecutionRecoveryBlockedInput): void {
  const { res, sessionKey, requestedExecutionId, error } = input;
  if (requestedExecutionId) {
    const scopeHash = workspaceOrSessionHash(sessionKey);
    const checkpoint = loadCheckpoint(scopeHash, requestedExecutionId);
    res.setHeader(EXECUTION_ID_HEADER, requestedExecutionId);
    res.setHeader(EXECUTION_GENERATION_HEADER, String(checkpoint.generation));
  }
  sendJson(res, error.statusCode, {
    error: { type: 'execution_recovery_blocked', message: error.decision.reason },
    recoveryDecision: error.decision.kind,
    ambiguousToolCallIds: error.decision.ambiguousToolCallIds,
  });
}

function applyExecutionHeaders(res: ServerResponse, tracking: ExecutionTrackingHandle): void {
  if (res.headersSent) return;
  for (const [name, value] of Object.entries(tracking.headers)) res.setHeader(name, value);
}

function attachAnthropicObserver(tracking: ExecutionTrackingHandle, clientWantsStream: boolean): (text: string) => void {
  return clientWantsStream
    ? text => tracking.observeAnthropicSseText(text)
    : text => {
        try {
          tracking.observeNonStreamAnthropic(JSON.parse(text));
        } catch {
          // Non-JSON/error bodies carry no tool-call information to observe.
        }
      };
}

function openAiEffort(body: JsonBody): string | undefined {
  if (typeof body.reasoning_effort === 'string' && body.reasoning_effort.trim()) {
    return body.reasoning_effort.trim();
  }
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === 'object' && typeof reasoning.effort === 'string' && reasoning.effort.trim()) {
    return reasoning.effort.trim();
  }
  return undefined;
}

function logStartupReconciliationReport(report: ReturnType<typeof reconcileExecutionsAtStartup>, plog: PLog): void {
  if (report.length === 0) return;
  plog(() => `execution reconciliation: ${report.length} execution(s) need attention (ambiguous or expired) — see \`leverframe executions list\``);
  for (const entry of report) {
    plog(() => `  ${entry.scopeHash}/${entry.executionId} ambiguousToolCalls=${entry.ambiguousToolCallIds.length} expired=${entry.expired}`);
  }
}

function reconcileExecutionsAtStartupSafely(plog: PLog): void {
  try {
    logStartupReconciliationReport(reconcileExecutionsAtStartup(), plog);
  } catch (error) {
    // Reconciliation is diagnostic, not load-bearing for serving new requests;
    // a storage error here must not prevent the server from starting, but it
    // must be visible rather than silently swallowed.
    plog(() => `execution reconciliation at startup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  silenceSdkWarnings();
  const languageModelCache = new ProviderRuntimeCache<LanguageModel>({
    disposeHandle: disposeLanguageModel,
    onCredentialRotated: previous => {
      evictResponsesWebSocketConnectionsForAccessToken(previous.credential);
    },
  });
  const plog = makeServerLog(options.debugLogPath);
  reconcileExecutionsAtStartupSafely(plog);

  const server = createServer((req, res) => {
    void routeRequest(req, res, options, languageModelCache, plog);
  });

  const address = await listenTcpServer(server, options.port, options.host);

  return {
    host: options.host,
    port: address.port,
    url: `http://${tcpListenerUrlHost(address.address)}:${address.port}`,
    server,
    inferenceLogPath: options.inferenceLogPath,
    close: async () => {
      // Local-shutdown edge: settle every in-flight request to a `cancelled`
      // terminal outcome instead of abandoning it mid-stream when the
      // listener goes down.
      cancelAllActiveRequestExecutions();
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
      await languageModelCache.dispose();
    },
  };
}

async function revalidateEndpointUrl(url: string): Promise<UrlSecurityResult> {
  const isHttp = url.trim().toLowerCase().startsWith('http://');
  return revalidateCustomEndpointUrl(url, { allowInsecureLocal: isHttp });
}

async function routeRequest(req: IncomingMessage, res: ServerResponse, options: ServerOptions, modelCache: ProviderRuntimeCache<LanguageModel>, plog: PLog): Promise<void> {
  try {
    if (options.enforceLocalHost && !isLocalHostRequestAllowed(req)) {
      sendJson(res, 403, { error: { message: 'Forbidden Host' } });
      return;
    }

    const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
    plog(`${req.method} ${pathname}`);

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (!isAuthorized(toRequest(req), options.serverPassword)) {
      sendJson(res, 401, { error: { message: 'Unauthorized' } });
      return;
    }

    if (req.method === 'GET' && pathname === '/models') {
      sendJson(res, 200, { models: options.catalog.list().map(({ apiKey: _apiKey, headers: _headers, ...rest }) => rest) });
      return;
    }

    if (req.method === 'GET' && pathname === '/anthropic/v1/models') {
      sendJson(res, 200, formatGatewayAnthropicModels(options.catalog.list(), options.gateway));
      return;
    }

    if (req.method === 'GET' && pathname === '/openai/v1/models') {
      sendJson(res, 200, formatOpenAIModels(options.catalog.list()));
      return;
    }

    if (req.method === 'POST' && pathname === '/anthropic/v1/messages') {
      await handleAnthropicMessages(req, res, options, modelCache, plog);
      return;
    }

    if (req.method === 'POST' && pathname === '/openai/v1/chat/completions') {
      await handleOpenAIChatCompletions(req, res, options, modelCache, plog);
      return;
    }

    if (await tryHandleExecutionsRoute(req, res, pathname)) return;

    sendJson(res, 404, { error: { message: 'Not found' } });
  } catch (err) {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    const details = sdkUpstreamErrorDetails(err);
    const message = formatUpstreamError(err);
    const status = err instanceof ExecutionRecoveryBlockedError
      ? err.statusCode
      : details?.statusCode ?? upstreamHttpStatus(err, message);
    for (const [name, value] of Object.entries(sdkUpstreamResponseHeaders(details))) {
      res.setHeader(name, value);
    }
    sendJson(res, status, {
      error: { type: anthropicErrorType(status), message },
    });
  }
}

const EXECUTIONS_PATH_PATTERN = /^\/executions\/([a-f0-9]{32})\/([A-Za-z0-9_-]{1,128})(\/reconcile)?$/;

/**
 * Authenticated generation-CAS surface for execution recovery (stabilization
 * plan §8.3): GET returns the current checkpoint/ledger and generation, POST
 * .../reconcile performs the CAS reconciliation write used by the CLI and
 * any other authenticated caller. Returns false for any other path so the
 * caller falls through to its normal 404.
 */
async function tryHandleExecutionsRoute(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const match = pathname.match(EXECUTIONS_PATH_PATTERN);
  if (!match) return false;
  const [, scopeHash, executionId, reconcileSuffix] = match as [string, string, string, string | undefined];

  if (req.method === 'GET' && !reconcileSuffix) {
    handleExecutionGet(res, scopeHash, executionId);
    return true;
  }
  if (req.method === 'POST' && reconcileSuffix) {
    await handleExecutionReconcile({ req, res, scopeHash, executionId });
    return true;
  }
  return false;
}

function handleExecutionGet(res: ServerResponse, scopeHash: string, executionId: string): void {
  const checkpoint = loadCheckpoint(scopeHash, executionId);
  const ledger = loadLedger(scopeHash, executionId);
  res.setHeader(EXECUTION_ID_HEADER, executionId);
  res.setHeader(EXECUTION_GENERATION_HEADER, String(Math.max(checkpoint.generation, ledger.generation)));
  if (checkpoint.state === 'missing' && ledger.state === 'missing') {
    sendJson(res, 404, { error: { message: `No execution found: ${scopeHash}/${executionId}` } });
    return;
  }
  if (checkpoint.state !== 'ok' || ledger.state !== 'ok') {
    sendJson(res, 409, {
      error: { message: 'Execution persistence is incomplete or unreadable; refusing recovery.' },
      checkpointState: checkpoint.state,
      ledgerState: ledger.state,
    });
    return;
  }
  sendJson(res, 200, {
    scopeHash,
    executionId,
    checkpointState: checkpoint.state,
    checkpointGeneration: checkpoint.generation,
    checkpoint: checkpoint.value ?? null,
    ledgerState: ledger.state,
    ledgerGeneration: ledger.generation,
    ledger: ledger.value ?? null,
  });
}

interface ReconcileRequestBody {
  toolCallId?: unknown;
  outcome?: unknown;
  expectedGeneration?: unknown;
}

function parseReconcileOutcome(value: unknown): ReconcileOutcome | undefined {
  return value === 'executed' || value === 'not-executed' ? value : undefined;
}

interface HandleExecutionReconcileInput {
  req: IncomingMessage;
  res: ServerResponse;
  scopeHash: string;
  executionId: string;
}

async function handleExecutionReconcile(input: HandleExecutionReconcileInput): Promise<void> {
  const { req, res, scopeHash, executionId } = input;
  const body = await readJson(req) as ReconcileRequestBody | null;
  const outcome = parseReconcileOutcome(body?.outcome);
  if (!body || typeof body.toolCallId !== 'string' || !outcome) {
    sendJson(res, 400, { error: { message: 'Request body must include toolCallId and outcome ("executed" | "not-executed")' } });
    return;
  }
  const ifMatch = requestHeader(req, 'if-match')?.replace(/^W\//, '').replace(/^"|"$/g, '');
  const candidateGeneration = body.expectedGeneration ?? (ifMatch === undefined ? undefined : Number(ifMatch));
  if (typeof candidateGeneration !== 'number' || !Number.isInteger(candidateGeneration) || candidateGeneration < 1) {
    sendJson(res, 428, { error: { message: 'A positive integer expectedGeneration (or If-Match header) is required for reconciliation CAS.' } });
    return;
  }
  res.setHeader(EXECUTION_ID_HEADER, executionId);
  res.setHeader(EXECUTION_GENERATION_HEADER, String(candidateGeneration));
  const result = reconcileExecution({
    scopeHash,
    executionId,
    toolCallId: body.toolCallId,
    outcome,
    expectedGeneration: candidateGeneration,
  });
  if (!result.ok) {
    const status = result.state === 'not-found' ? 404 : 409;
    sendJson(res, status, { error: { message: result.error ?? 'Reconciliation failed' }, state: result.state });
    return;
  }
  res.setHeader(EXECUTION_GENERATION_HEADER, String(result.generation));
  sendJson(res, 200, { ok: true, entry: result.entry, generation: result.generation });
}

async function handleAnthropicMessages(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
  modelCache: ProviderRuntimeCache<LanguageModel>,
  plog: PLog,
): Promise<void> {
  const body = await readJson(req);
  if (!body) {
    sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
    return;
  }

  const model = lookupModel(res, options.catalog, body.model);
  if (!model) {
    plog(`model not found: ${body.model}`);
    return;
  }
  const requestId = randomUUID();
  const claudeSessionIdHeader = Array.isArray(req.headers['x-claude-code-session-id'])
    ? req.headers['x-claude-code-session-id'][0]
    : req.headers['x-claude-code-session-id'];
  const claudeSessionId = extractClaudeSessionId(body as AnthropicRequest, claudeSessionIdHeader);
  const executionSessionKey = resolveExecutionSessionKey({
    claudeSessionId,
    provider: inferenceProvider(model),
    model: model.id,
  });

  // Downstream-disconnect signal for this request, shared by both the
  // Anthropic-passthrough and SDK-translated branches below. Local shutdown
  // is owned separately, via `cancelAllActiveRequestExecutions()` in
  // `ServerHandle.close()`.
  const clientAbort = new AbortController();
  const abortClientRequest = () => {
    if (!clientAbort.signal.aborted) clientAbort.abort(new DOMException('Client disconnected', 'AbortError'));
  };
  const abortClosedResponse = () => {
    if (!res.writableEnded) abortClientRequest();
  };
  req.once('aborted', abortClientRequest);
  res.once('close', abortClosedResponse);

  // Owns accepted/validated/dispatched/first-output/terminal transitions,
  // the four deadline classes, and downstream-disconnect/local-shutdown
  // cancellation for this request end-to-end (stabilization plan §7.2).
  const requestExecution = createRequestExecutionContext({
    requestId,
    provider: inferenceProvider(model),
    model: model.id,
    correlationId: requestId,
    signal: clientAbort.signal,
  });
  res.once('finish', () => requestExecution.dispose());
  res.once('close', () => requestExecution.dispose());
  requestExecution.startResolving();
  reconcileIncomingToolResults({ sessionKey: executionSessionKey, toolResults: extractAnthropicToolResults(body) });
  let tracking: ExecutionTrackingHandle;
  try {
    tracking = beginExecutionTracking({
      sessionKey: executionSessionKey,
      executionId: requestHeader(req, EXECUTION_ID_HEADER),
      requestId,
      provider: inferenceProvider(model),
      model: body.model,
      route: model.modelFormat === 'anthropic' ? 'passthrough' : 'translated',
      messages: toDigestableMessages(body),
      capabilities: executionCapabilities(model, body),
    });
  } catch (error) {
    if (error instanceof ExecutionRecoveryBlockedError) {
      respondExecutionRecoveryBlocked({ res, sessionKey: executionSessionKey, requestedExecutionId: requestHeader(req, EXECUTION_ID_HEADER), error });
      return;
    }
    throw error;
  }
  if (options.webSocketDiagnosticsLogPath) {
    writeWebSocketDiagnosticRequestLog(options.webSocketDiagnosticsLogPath, {
      requestId,
      claudeSessionId,
      provider: inferenceProvider(model),
      route: model.modelFormat === 'anthropic' ? 'passthrough' : 'translated',
      headers: req.headers,
      body,
    });
  }

  plog(() => `anthropic-messages model=${body.model} format=${model.modelFormat} npm=${model.npm ?? 'none'} stream=${body.stream}`);

  if (model.modelFormat === 'anthropic') {
    if (model.baseUrl && !/^https?:\/\//i.test(model.baseUrl)) {
      sendJson(res, 400, { error: { message: `Invalid provider baseUrl: must be http:// or https://` } });
      return;
    }
    if (!model.baseUrl) {
      sendJson(res, 400, { error: { message: `Model ${model.id} has no Anthropic baseUrl configured` } });
      return;
    }
    const revalidation = await revalidateEndpointUrl(model.baseUrl);
    if (!revalidation.ok) {
      sendJson(res, 400, {
        error: {
          message: `Custom endpoint URL failed security revalidation: ${revalidation.error ?? 'unspecified'}${revalidation.hint ? ` ${revalidation.hint}` : ''}`,
        },
      });
      return;
    }
    const messagesUrl = `${model.baseUrl}/v1/messages`;
    const credentialRouteKey = providerRuntimeRouteKey(model, '@native-anthropic', model.baseUrl);
    const credential = modelCache.snapshot(credentialRouteKey, model.apiKey ?? options.apiKey);
    const apiKey = credential.credential;
    const betaHeaderRaw = req.headers['anthropic-beta'];
    const inboundBeta = Array.isArray(betaHeaderRaw) ? betaHeaderRaw.join(',') : betaHeaderRaw;
    const clientWantsStream = Boolean(body.stream);
    const forwardBody: Record<string, unknown> = { ...body, model: upstreamModelId(model) };
    const isOAuth = model.authType === 'oauth';

    auditInference(options, {
      requestId,
      modelId: body.model,
      effort: anthropicEffortFromRequest(body as AnthropicRequest) ?? model.defaultEffort,
      claudeSessionId,
      provider: inferenceProvider(model),
      route: 'passthrough',
      requestPreview: getLatestMessagePreview(body.messages, body.system),
    });

    let effectiveBeta = inboundBeta;
    let claudeCodeSessionId: string | undefined;
    if (isOAuth) {
      const seed = model.providerId ?? upstreamModelId(model);
      const identity = injectClaudeIdentity(forwardBody, model.providerData, seed);
      if (model.providerId === 'claude-code') injectClaudeCodeBillingSystemLine(forwardBody);
      claudeCodeSessionId = identity.sessionId;
      effectiveBeta = selectBetaFlags(forwardBody, upstreamModelId(model), inboundBeta);
    }

    const refreshToken = isOAuth && model.providerId
      ? (rejectedToken: string) => resolveProviderCredential(
          model.providerId!,
          oauthAuthRef(model.providerId!),
          undefined,
          { rejectedAccessToken: rejectedToken },
        )
      : undefined;

    plog(() => `anthropic-passthrough → ${messagesUrl} oauth=${isOAuth} stream=${clientWantsStream}`);
    applyExecutionHeaders(res, tracking);
    await relayAnthropicMessages(res, messagesUrl, forwardBody, apiKey, clientWantsStream, {
      inboundBeta: effectiveBeta,
      authType: isOAuth ? 'oauth' : 'api',
      log: message => plog(message),
      claudeCodeSessionId,
      extraHeaders: model.headers,
      refreshToken,
      lifecycle: requestExecution,
      onObservedText: attachAnthropicObserver(tracking, clientWantsStream),
      onTokenRefreshed: async refreshed => {
        await modelCache.adopt(credentialRouteKey, apiKey, refreshed);
      },
      onUpstreamError: options.inferenceLogPath
        ? (statusCode, errorContent) => writeInferenceResponseErrorLog(options.inferenceLogPath!, {
            requestId,
            modelId: body.model,
            provider: inferenceProvider(model),
            route: 'passthrough',
            statusCode,
            errorContent,
          })
        : undefined,
    });
    return;
  }

  if (model.modelFormat === 'openai') {
    if (!isSdkMigratedNpm(model.npm)) {
      sendJson(res, 400, { error: { message: `No SDK provider for model: ${model.id}` } });
      return;
    }
    if (model.apiBaseUrl && !/^https?:\/\//i.test(model.apiBaseUrl)) {
      sendJson(res, 400, { error: { message: `Invalid provider apiBaseUrl: must be http:// or https://` } });
      return;
    }
    if (model.apiBaseUrl) {
      const sdkRevalidation = await revalidateEndpointUrl(model.apiBaseUrl);
      if (!sdkRevalidation.ok) {
        sendJson(res, 400, {
          error: {
            message: `Custom endpoint URL failed security revalidation: ${sdkRevalidation.error ?? 'unspecified'}${sdkRevalidation.hint ? ` ${sdkRevalidation.hint}` : ''}`,
          },
        });
        return;
      }
    }
    const apiKey = model.apiKey ?? options.apiKey;
    auditInference(options, {
      requestId,
      modelId: body.model,
      effort: anthropicEffortFromRequest(body as AnthropicRequest) ?? model.defaultEffort,
      claudeSessionId,
      provider: inferenceProvider(model),
      route: 'translated',
      requestPreview: getLatestMessagePreview(body.messages, body.system),
    });
    const npmMaxTools = maxToolsForNpm(model.npm);
    const toolCount = Array.isArray((body as Record<string, unknown>).tools) ? ((body as Record<string, unknown>).tools as unknown[]).length : 0;
    if (npmMaxTools !== undefined && toolCount > npmMaxTools) {
      plog(`tools truncated: ${toolCount} → ${npmMaxTools} (provider limit)`);
    }
    const openAiOAuth = model.npm === '@ai-sdk/openai' && model.authType === 'oauth';
    const params = sdkTranslateRequest(body as unknown as AnthropicRequest, model.npm!, {
      defaultEffort: anthropicEffortFromRequest(body as AnthropicRequest) ? undefined : model.defaultEffort,
      openAiOAuth,
      claudeSessionId,
      reasoningMetadata: {
        providerId: model.providerId,
        apiBaseUrl: model.apiBaseUrl,
        supportedParameters: model.supportedParameters,
        reasoning: model.reasoning,
        interleavedReasoningField: model.interleavedReasoningField,
        upstreamModelId: upstreamModelId(model),
      },
      maxTools: npmMaxTools,
    });
    const languageModel = await getOrInitLanguageModel(
      modelCache,
      model,
      model.npm!,
      model.apiBaseUrl,
      apiKey,
      options.webSocketDiagnosticsLogPath,
    );
    const clientWantsStream = Boolean(body.stream);
    const responseModelId = getResponseModelId(body.model, model, options);
    const inferenceLogPath = options.inferenceLogPath;
    const onUsage = inferenceLogPath
      ? (usage: AnthropicUsageTrace) => writeInferenceResponseLifecycleLog(inferenceLogPath, {
          event: 'response_usage',
          requestId,
          modelId: usage.model,
          provider: inferenceProvider(model),
          route: 'translated',
          usageStage: 'message_delta',
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheCreationInputTokens: usage.cache_creation_input_tokens,
          cacheReadInputTokens: usage.cache_read_input_tokens,
          promptCacheKeyHash: usage.promptCacheKeyHash,
        })
      : undefined;

    plog(() => `sdk npm=${model.npm} upstream=${upstreamModelId(model)} responseModel=${responseModelId} stream=${clientWantsStream}`);

    // Reuses the function-level `clientAbort`/`requestExecution` created
    // above — the passthrough and SDK branches share one lifecycle per
    // request rather than each owning a separate cancellation signal.
    try {
      if (clientWantsStream) {
        const writeStreamChunk = (chunk: string) => {
          if (!res.headersSent) {
            applyExecutionHeaders(res, tracking);
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });
          }
          tracking.observeAnthropicSseText(chunk);
          res.write(chunk);
          heartbeat.reset();
        };
        const heartbeat = createSseHeartbeat(() => {
          if (!res.headersSent) {
            applyExecutionHeaders(res, tracking);
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });
          }
          res.write('event: ping\ndata: {"type":"ping"}\n\n');
        }, () => !res.writableEnded && !res.destroyed, DELAY_FIRST_HEARTBEAT);
        const clearHeartbeat = () => heartbeat.clear();
        clientAbort.signal.addEventListener('abort', clearHeartbeat, { once: true });
        heartbeat.arm();
        try {
          await withResponsesWebSocketDiagnosticContext(
            { requestId, claudeSessionId },
            () => streamAnthropicResponse(languageModel, params, responseModelId, writeStreamChunk, undefined, {
              onUsage,
              initialInputTokens: estimateAnthropicInputTokens(body),
              abortSignal: clientAbort.signal,
              clientAbortSignal: clientAbort.signal,
              lifecycle: requestExecution,
              contextWindow: resolveContextWindow(upstreamModelId(model), model.contextWindow, model.contextWindowUnconfirmed),
            }),
          );
          requestExecution.markStreamActivity();
          requestExecution.complete();
          if (!res.headersSent) writeStreamChunk('');
          res.end();
        } finally {
          heartbeat.clear();
          clientAbort.signal.removeEventListener('abort', clearHeartbeat);
        }
      } else {
        // ChatGPT/Codex OAuth only answers as SSE, so stream internally.
        const anthropicResponse = await withResponsesWebSocketDiagnosticContext(
          { requestId, claudeSessionId },
          () => generateAnthropicResponse(languageModel, params, responseModelId, {
            forceStream: openAiOAuth,
            abortSignal: clientAbort.signal,
            onUsage,
            lifecycle: requestExecution,
            contextWindow: resolveContextWindow(upstreamModelId(model), model.contextWindow, model.contextWindowUnconfirmed),
          }),
        );
        requestExecution.markStreamActivity();
        requestExecution.markOutputEmitted();
        requestExecution.complete();
        tracking.observeNonStreamAnthropic(anthropicResponse);
        applyExecutionHeaders(res, tracking);
        sendJson(res, 200, anthropicResponse);
      }
    } catch (err) {
      if (clientAbort.signal.aborted) return;
      requestExecution.fail(err);
      tracking.fail(undefined);
      const message = formatUpstreamError(err);
      const details = sdkUpstreamErrorDetails(err);
      const status = auditSdkError(options, body.model, model, err, message);
      const contextLengthExceeded = status === 400
        && isContextLengthExceededError(err, message);
      const clientMessage = contextLengthExceeded
        ? anthropicPromptTooLongMessage(
            body,
            resolveContextWindow(upstreamModelId(model), model.contextWindow, model.contextWindowUnconfirmed),
          )
        : message;
      plog(() => `sdk error npm=${model.npm} upstream=${upstreamModelId(model)}: ${message}${details?.errorContent ? `, body: ${details.errorContent}` : ''}`);
      if (!res.headersSent) {
        for (const [name, value] of Object.entries(sdkUpstreamResponseHeaders(details))) {
          res.setHeader(name, value);
        }
        if (contextLengthExceeded) {
          sendJson(res, 400, {
            type: 'error',
            error: { type: 'invalid_request_error', message: clientMessage },
            request_id: requestId,
          });
        } else {
          sendJson(res, status === 500 ? 502 : status, { error: { message: clientMessage } });
        }
      } else {
        const errorType = anthropicErrorType(status);
        res.write(`event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: {
            type: errorType,
            message: clientMessage,
            status_code: status,
            ...(details?.retryAfterMs !== undefined ? { retry_after: Math.ceil(details.retryAfterMs / 1_000) } : {}),
          },
          ...(contextLengthExceeded ? { request_id: requestId } : {}),
        })}\n\n`);
        res.end();
      }
    } finally {
      req.removeListener('aborted', abortClientRequest);
      res.removeListener('close', abortClosedResponse);
    }
    return;
  }

  sendJson(res, 400, { error: { message: `Unsupported model format: ${model.modelFormat}` } });
}

async function handleOpenAIChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
  modelCache: ProviderRuntimeCache<LanguageModel>,
  plog: PLog,
): Promise<void> {
  const body = await readJson(req);
  if (!body) {
    sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
    return;
  }

  const model = lookupModel(res, options.catalog, body.model);
  if (!model) return;

  const openAiSessionKey = resolveExecutionSessionKey({
    claudeSessionId: typeof body.user === 'string' ? body.user : requestHeader(req, 'x-claude-code-session-id'),
    provider: inferenceProvider(model),
    model: model.id,
  });
  reconcileIncomingToolResults({ sessionKey: openAiSessionKey, toolResults: extractOpenAiToolResults(body) });
  const openAiRequestId = randomUUID();
  let openAiTracking: ExecutionTrackingHandle;
  try {
    openAiTracking = beginExecutionTracking({
      sessionKey: openAiSessionKey,
      executionId: requestHeader(req, EXECUTION_ID_HEADER),
      requestId: openAiRequestId,
      provider: inferenceProvider(model),
      model: body.model,
      route: supportsDirectOpenAIChatCompletions(model) ? 'passthrough' : 'translated',
      messages: toDigestableMessages(body),
      capabilities: executionCapabilities(model, body),
    });
  } catch (error) {
    if (error instanceof ExecutionRecoveryBlockedError) {
      respondExecutionRecoveryBlocked({ res, sessionKey: openAiSessionKey, requestedExecutionId: requestHeader(req, EXECUTION_ID_HEADER), error });
      return;
    }
    throw error;
  }

  // Downstream-disconnect signal shared by both branches below. Local
  // shutdown is owned by `cancelAllActiveRequestExecutions()` in
  // `ServerHandle.close()`.
  const openAiClientAbort = new AbortController();
  const abortOpenAiClientRequest = () => {
    if (!openAiClientAbort.signal.aborted) {
      openAiClientAbort.abort(new DOMException('Client disconnected', 'AbortError'));
    }
  };
  const abortOpenAiClosedResponse = () => {
    if (!res.writableEnded) abortOpenAiClientRequest();
  };
  req.once('aborted', abortOpenAiClientRequest);
  res.once('close', abortOpenAiClosedResponse);

  const openAiExecution = createRequestExecutionContext({
    requestId: openAiRequestId,
    provider: inferenceProvider(model),
    model: model.id,
    correlationId: openAiRequestId,
    signal: openAiClientAbort.signal,
  });
  res.once('finish', () => openAiExecution.dispose());
  res.once('close', () => openAiExecution.dispose());
  openAiExecution.startResolving();

  if (supportsDirectOpenAIChatCompletions(model)) {
    if (model.completionsUrl && !/^https?:\/\//i.test(model.completionsUrl)) {
      sendJson(res, 400, { error: { message: `Invalid provider completionsUrl: must be http:// or https://` } });
      return;
    }
    if (!model.completionsUrl) {
      sendJson(res, 400, { error: { message: `Model ${model.id} has no completionsUrl configured` } });
      return;
    }
    const completionsRevalidation = await revalidateEndpointUrl(model.apiBaseUrl ?? model.completionsUrl);
    if (!completionsRevalidation.ok) {
      sendJson(res, 400, {
        error: {
          message: `Custom endpoint URL failed security revalidation: ${completionsRevalidation.error ?? 'unspecified'}${completionsRevalidation.hint ? ` ${completionsRevalidation.hint}` : ''}`,
        },
      });
      return;
    }
    const completionsUrl = model.completionsUrl;
    const apiKey = model.apiKey ?? options.apiKey;
    const forwardBody = body.model === upstreamModelId(model) ? body : { ...body, model: upstreamModelId(model) };
    auditInference(options, {
      modelId: body.model,
      effort: openAiEffort(body),
      provider: inferenceProvider(model),
      route: 'passthrough',
      requestPreview: getLatestMessagePreview(body.messages, body.system),
    });
    applyExecutionHeaders(res, openAiTracking);
    const directStream = Boolean(body.stream);
    await relayAnthropicMessages(res, completionsUrl, forwardBody, apiKey, directStream, {
      onObservedText: text => {
        if (directStream) {
          openAiTracking.observeOpenAiSseText(text);
          return;
        }
        try {
          openAiTracking.observeNonStreamOpenAi(JSON.parse(text));
        } catch {
          // Error bodies carry no tool-call information to observe.
        }
      },
      onUpstreamError: options.inferenceLogPath
        ? (statusCode, errorContent) => writeInferenceResponseErrorLog(options.inferenceLogPath!, {
            modelId: body.model,
            provider: inferenceProvider(model),
            route: 'passthrough',
            statusCode,
            errorContent,
          })
        : undefined,
      lifecycle: openAiExecution,
    });
    return;
  }

  const npm = model.npm || (model.modelFormat === 'anthropic' ? '@ai-sdk/anthropic' : undefined);
  if (!npm) {
    sendJson(res, 400, { error: { message: `No SDK provider for model: ${model.id}` } });
    return;
  }

  const apiKey = model.apiKey ?? options.apiKey;
  auditInference(options, {
    modelId: body.model,
    effort: openAiEffort(body),
    provider: inferenceProvider(model),
    route: 'translated',
    requestPreview: getLatestMessagePreview(body.messages, body.system),
  });
  const baseURL = model.modelFormat === 'anthropic' ? model.baseUrl : model.apiBaseUrl;
  if (baseURL) {
    if (!/^https?:\/\//i.test(baseURL)) {
      sendJson(res, 400, { error: { message: `Invalid provider baseURL: must be http:// or https://` } });
      return;
    }
    const sdkRevalidation = await revalidateEndpointUrl(baseURL);
    if (!sdkRevalidation.ok) {
      sendJson(res, 400, {
        error: {
          message: `Custom endpoint URL failed security revalidation: ${sdkRevalidation.error ?? 'unspecified'}${sdkRevalidation.hint ? ` ${sdkRevalidation.hint}` : ''}`,
        },
      });
      return;
    }
  }
  const languageModel = await getOrInitLanguageModel(modelCache, model, npm, baseURL, apiKey);
  const openAiOAuth = npm === '@ai-sdk/openai' && model.authType === 'oauth';
  const params = translateOpenAiRequest(body as unknown as OpenAiRequest, { openAiOAuth });
  const clientWantsStream = Boolean(body.stream);
  const responseModelId = getResponseModelId(body.model, model, options);

  plog(() => `sdk-openai npm=${npm} upstream=${upstreamModelId(model)} responseModel=${responseModelId} stream=${clientWantsStream}`);

  // Reuses the shared `openAiClientAbort`/`openAiExecution` created above —
  // one cancellation signal and lifecycle per request across both branches.
  try {
    if (clientWantsStream) {
      const writeStreamChunk = (chunk: string) => {
        if (!res.headersSent) {
          applyExecutionHeaders(res, openAiTracking);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
        }
        openAiTracking.observeOpenAiSseText(chunk);
        res.write(chunk);
        heartbeat.reset();
      };
      const heartbeat = createSseHeartbeat(() => {
        if (!res.headersSent) {
          applyExecutionHeaders(res, openAiTracking);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
        }
        res.write('event: ping\ndata: {"type":"ping"}\n\n');
      }, () => !res.writableEnded && !res.destroyed, true);
      const clearHeartbeat = () => heartbeat.clear();
      openAiClientAbort.signal.addEventListener('abort', clearHeartbeat, { once: true });
      heartbeat.arm();
      try {
        await streamOpenAiResponse(languageModel, params, responseModelId, writeStreamChunk, {
          abortSignal: openAiClientAbort.signal,
          lifecycle: openAiExecution,
        });
        openAiExecution.markStreamActivity();
        openAiExecution.complete();
        if (!res.headersSent) writeStreamChunk('');
        res.end();
      } finally {
        heartbeat.clear();
        openAiClientAbort.signal.removeEventListener('abort', clearHeartbeat);
      }
    } else {
      // ChatGPT/Codex OAuth only answers as SSE, so stream internally.
      const response = await generateOpenAiResponse(languageModel, params, responseModelId, {
        forceStream: openAiOAuth,
        abortSignal: openAiClientAbort.signal,
        lifecycle: openAiExecution,
        onWarning: plog,
      });
      openAiExecution.markStreamActivity();
      openAiExecution.markOutputEmitted();
      openAiExecution.complete();
      openAiTracking.observeNonStreamOpenAi(response);
      applyExecutionHeaders(res, openAiTracking);
      sendJson(res, 200, response);
    }
  } catch (err) {
    if (openAiClientAbort.signal.aborted) return;
    openAiExecution.fail(err);
    openAiTracking.fail(undefined);
    const message = formatUpstreamError(err);
    const details = sdkUpstreamErrorDetails(err);
    const status = auditSdkError(options, body.model, model, err, message);
    plog(() => `sdk error npm=${model.npm} upstream=${upstreamModelId(model)}: ${message}${details?.errorContent ? `, body: ${details.errorContent}` : ''}`);
    if (!res.headersSent) {
      sendJson(res, status === 500 ? 502 : status, { error: { message } });
    } else {
      res.write(`data: ${JSON.stringify({
        error: {
          message,
          type: 'upstream_error',
          code: status,
          ...(details?.retryAfterMs !== undefined ? { retry_after: Math.ceil(details.retryAfterMs / 1_000) } : {}),
        },
      })}\n\n`);
      res.end();
    }
  } finally {
    req.removeListener('aborted', abortOpenAiClientRequest);
    res.removeListener('close', abortOpenAiClosedResponse);
  }
}

function lookupModel(res: ServerResponse, catalog: ModelCatalog, modelId: unknown): ServerModelInfo | null {
  if (typeof modelId !== 'string') {
    sendJson(res, 400, { error: { message: 'Request body must include a model string' } });
    return null;
  }

  const model = catalog.get(modelId);
  if (!model) {
    sendJson(res, 400, { error: { message: `Unknown model: ${modelId}` } });
    return null;
  }

  return model;
}

function providerRuntimeRouteKey(
  model: ServerModelInfo,
  npm: string,
  baseURL: string | undefined,
): string {
  return [
    model.providerId ?? model.sourceBackend,
    model.oauthAccountId ?? '',
    model.id,
    upstreamModelId(model),
    npm,
    baseURL ?? '',
  ].join('\x1f');
}

async function getOrInitLanguageModel(
  modelCache: ProviderRuntimeCache<LanguageModel>,
  model: ServerModelInfo,
  npm: string,
  baseURL: string | undefined,
  apiKey: string,
  webSocketDiagnosticsLogPath?: string,
): Promise<LanguageModel> {
  const routeKey = providerRuntimeRouteKey(model, npm, baseURL);
  let credential = modelCache.snapshot(routeKey, apiKey);
  // The catalog's live credential can move out from under the cache (e.g. an
  // externally rotated registry key) without ever going through the
  // rejected-token refresh path. Detect that drift here and adopt the new
  // value through the same single-flighted rotation the refresh path uses,
  // so stale handles are evicted before a new one is built (§7.4).
  if (model.authType !== 'oauth' && credential.credential !== apiKey) {
    credential = await modelCache.adopt(routeKey, credential.credential, apiKey);
  }
  return modelCache.getHandle(routeKey, credential, handleCredential => createLanguageModel({
    npm,
    modelId: upstreamModelId(model),
    apiKey: handleCredential.credential,
    baseURL,
    providerId: model.providerId ?? model.sourceBackend,
    authType: model.authType,
    oauthAccountId: model.oauthAccountId,
    headers: model.headers,
    useResponsesLite: model.useResponsesLite,
    preferWebSockets: model.preferWebSockets,
    onWebSocketDiagnostic: webSocketDiagnosticsLogPath
      ? event => writeWebSocketDiagnosticLog(webSocketDiagnosticsLogPath, event)
      : undefined,
  }));
}

function getResponseModelId(bodyModel: unknown, model: ServerModelInfo, options: ServerOptions): string {
  // Echo invariant: alias request ids must echo back verbatim (see CLAUDE.md).
  if (typeof bodyModel === 'string' && options.aliasNames?.has(bodyModel)) return bodyModel;
  return options.gateway?.maskGatewayIds
    ? gatewayDisplayName(model, options.gateway)
    : (typeof bodyModel === 'string' ? bodyModel : model.id);
}

async function readJson(req: IncomingMessage): Promise<JsonBody | null> {
  try {
    const raw = await readBody(req);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, sanitizeIncomingHeaderValue(item));
    } else if (value !== undefined) {
      headers.set(name, sanitizeIncomingHeaderValue(value));
    }
  }

  return new Request('http://localhost/', { headers });
}

/** HTTP header values cannot contain CR or LF. */
function sanitizeIncomingHeaderValue(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}
