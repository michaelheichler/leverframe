import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { listenTcpServer, tcpListenerUrlHost } from '../listener-ready.js';
import { isAuthorized, isLocalHostRequestAllowed } from './auth.js';
import {
  formatGatewayAnthropicModels,
  formatOpenAIModels,
  type GatewayModelOptions,
  type ModelCatalog,
} from './models.js';
import { sendJson } from '../http-utils.js';
import { resetTraceLog } from '../log-paths.js';
import { writeSecureLogLine } from '../trace-log.js';
import type { LanguageModel } from 'ai';
import {
  anthropicErrorType,
  formatUpstreamError,
  sdkUpstreamErrorDetails,
  sdkUpstreamResponseHeaders,
  upstreamHttpStatus,
} from '../upstream-error.js';
import { silenceSdkWarnings } from '../sdk-adapter.js';
import { evictResponsesWebSocketConnectionsForAccessToken } from '../oauth/responses-websocket.js';
import { ProviderRuntimeCache } from '../provider-runtime-cache.js';
import { disposeLanguageModel } from '../language-model-disposal.js';
import {
  reconcileExecutionsAtStartup,
  ExecutionRecoveryBlockedError,
  EXECUTION_ID_HEADER,
  EXECUTION_GENERATION_HEADER,
} from '../execution-tracking.js';
import { loadCheckpoint } from '../execution-checkpoint.js';
import { loadLedger } from '../tool-call-ledger.js';
import { reconcileExecution, type ReconcileOutcome } from '../execution-recovery.js';
import { cancelAllActiveRequestExecutions } from '../request-execution-context.js';
import { handleAnthropicMessages, handleOpenAIChatCompletions } from './inference-routes.js';
import { readJson, requestHeader, type PLog } from './route-helpers.js';

export interface ServerOptions {
  host: string;
  port: number;
  apiKey: string;
  serverPassword: string | null;

  enforceLocalHost?: boolean;
  catalog: ModelCatalog;
  gateway?: GatewayModelOptions;

  aliasNames?: ReadonlySet<string>;

  debugLogPath?: string;

  inferenceLogPath?: string;

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

function makeServerLog(debugLogPath: string | undefined): PLog {
  if (!debugLogPath) return () => {};
  resetTraceLog(debugLogPath);
  return (msg) => writeSecureLogLine(debugLogPath, typeof msg === 'function' ? msg() : msg);
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

      cancelAllActiveRequestExecutions();
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
      await languageModelCache.dispose();
    },
  };
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

function sanitizeIncomingHeaderValue(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}
