// responses-websocket.ts, persistent outbound WebSocket transport for OpenAI's
// ChatGPT/Codex Responses backend.
// The Vercel AI SDK still sees a fetch-like SSE response per model call. Behind
// that interface, leverframe retains one sequential WebSocket chain per opaque
// Claude session/model/effort/account partition and uses previous_response_id
// only after proving the next translated conversation appends to the chain head.
// The transport is split across responses-websocket-*.ts modules by
// responsibility (connection pool, request-context lifecycle, diagnostics,
// reasoning-protocol tracking, retry/backoff, continuation matching, payload
// shaping, response-output accumulation). This file is the orchestration
// entry point: it wires those modules together into the actual socket
// lifecycle and exposes the public fetch-transport API.

import { createHash } from 'node:crypto';
import type { Agent as HttpAgent } from 'node:http';
import type { FetchFunction } from '@ai-sdk/provider-utils';
import type { RawData } from 'ws';
import { CODEX_RESPONSES_WEBSOCKETS_BETA } from '../constants.js';
import { outboundWsProxyAgent } from '../outbound-proxy.js';
import { ProviderTransportError, parseRetryAfter } from '../provider-error.js';
import type {
  ConnectionEntry,
  JsonObject,
  RequestContext,
  WebSocketConstructor,
} from './responses-websocket-types.js';
import {
  allocateConnectionDebugId,
  cleanupExpiredConnections,
  connectionCount,
  connectionCountByGeneration,
  connectionEntries,
  debugKey,
  deleteEntry,
  evictOldestIdleGeneration,
  evictStaleCredentialConnections,
  peekNextConnectionDebugId,
  registerEntry,
  releaseEntryForRequestId,
  resetConnectionPoolState,
  trackEntryForRequest,
} from './responses-websocket-connection-pool.js';
import {
  activeContextsSnapshot,
  cancelContext,
  clearActiveContexts,
  closeContext,
  errorContext,
  flushPending,
  resetContextForRetry,
  settleHandshakeSuccess,
  trackActiveContext,
} from './responses-websocket-context.js';
import {
  boundedDiagnosticIdentifier,
  diagnosticTextFingerprint,
  emitDiagnostic,
  emitResponseErrorDiagnostic,
  responseFailureDetails,
} from './responses-websocket-diagnostics.js';
import { trackReasoningProtocol } from './responses-websocket-reasoning-protocol.js';
import {
  boundedThrottleRetryAfterMs,
  handleTransportFailure,
  numericRetryAfterMs,
  responseRetryAfterMs,
  RETRYABLE_UPGRADE_STATUSES,
  socketFailureIsRetryable,
} from './responses-websocket-retry-backoff.js';
import {
  continuationMatch,
  continuationMismatchDetails,
  continuationMismatchSummary,
  conversationItemHash,
  conversationItemKind,
  inputArray,
} from './responses-websocket-continuation-matching.js';
import {
  applyResponsesLiteShape,
  authorizationFingerprint,
  bodyToString,
  changedPromptFields,
  hasResponsesLiteHeader,
  instructionChangeSummary,
  instructionsFromPayload,
  responsesWebSocketPartitionKey,
  responsesWebSocketPromptFieldHashes,
  responsesWebSocketPromptFingerprint,
  toHeaderRecord,
} from './responses-websocket-payload.js';
import {
  captureOutput,
  eventType,
  expectedAssistantItems,
  responseErrorCode,
  responseUsage,
  responseUsageDebug,
  TERMINAL_EVENT_TYPES,
} from './responses-websocket-response-output.js';
import {
  observeRejectedResponseBody,
  providerRequestId,
  safeResponseHeaders,
} from './responses-websocket-rejected-response.js';

export type {
  ResponsesWebSocketDiagnosticContext,
  ResponsesWebSocketDiagnosticEvent,
  ResponsesWebSocketFetchOptions,
} from './responses-websocket-types.js';
export { withResponsesWebSocketDiagnosticContext } from './responses-websocket-diagnostics.js';
export { responsesWebSocketPartitionKey, responsesWebSocketPromptFingerprint } from './responses-websocket-payload.js';
import type { ResponsesWebSocketFetchOptions } from './responses-websocket-types.js';
import { currentDiagnosticContext } from './responses-websocket-diagnostics.js';

const FAILURE_EVENT_TYPES = new Set(['error', 'response.failed', 'response.incomplete']);

export const RESPONSES_WS_HARD_TTL_MS = 55 * 60_000;
export const RESPONSES_WS_IDLE_TTL_MS = 30 * 60_000;
export const RESPONSES_WS_NURSERY_IDLE_TTL_MS = 5 * 60_000;
export const RESPONSES_WS_MAX_CONNECTIONS = 32;
export const RESPONSES_WS_MAX_NURSERY_CONNECTIONS = 8;

/** Test-only cleanup, also useful for preventing leaked fake sockets. */
export function resetResponsesWebSocketConnectionsForTests(): void {
  for (const ctx of activeContextsSnapshot()) {
    cancelContext(ctx, new DOMException('Transport reset', 'AbortError'));
  }
  for (const entry of connectionEntries()) {
    try { entry.socket.close(); } catch { /* ignore */ }
  }
  clearActiveContexts();
  resetConnectionPoolState();
}

/** Close every pooled socket that was authenticated with a superseded token. */
export function evictResponsesWebSocketConnectionsForAccessToken(accessToken: string): number {
  const fingerprint = authorizationFingerprint({ authorization: `Bearer ${accessToken}` });
  if (!fingerprint) return 0;
  let evicted = 0;
  for (const entry of connectionEntries()) {
    if (entry.credentialFingerprint !== fingerprint) continue;
    const ctx = entry.current;
    if (ctx && !ctx.closed) {
      cancelContext(ctx, new DOMException('Credential rotated', 'AbortError'));
    } else {
      deleteEntry(entry);
    }
    evicted += 1;
  }
  return evicted;
}

/**
 * Evict the connection that served a specific proxy request, called when a
 * downstream SDK translation error (e.g. a reasoning-part-not-found throw) shows
 * the stream was corrupted in a way the WS layer's own anomaly detector did not
 * flag. No-ops if the entry has since been reused by a later request or was
 * already evicted, so it never tears down a connection serving other traffic.
 */
export function evictResponsesWebSocketConnectionForRequest(requestId: string): boolean {
  const entry = releaseEntryForRequestId(requestId);
  if (!entry) return false;
  const ctx = entry.current;
  if (ctx && !ctx.closed) {
    cancelContext(ctx, new DOMException('Reasoning-part protocol error detected', 'AbortError'));
  } else {
    deleteEntry(entry);
  }
  return true;
}

const DEFAULT_THROTTLE_RETRY_AFTER_MS = 5_000;

function isModelDataEvent(type: string | undefined): boolean {
  return Boolean(type && (
    type.includes('.delta')
    || type === 'response.output_item.added'
    || type === 'response.output_item.done'
  ));
}

function outgoingPayload(payload: JsonObject): string {
  return JSON.stringify({ type: 'response.create', ...payload });
}

function sendContext(entry: ConnectionEntry, ctx: RequestContext): void {
  const outgoing = outgoingPayload(ctx.sendPayload);
  entry.debug(
    `connection=${entry.debugId} key=${debugKey(entry.key)} sending ${outgoing.length}B payload`
    + (ctx.continued ? ' (continuation)' : ''),
  );
  try {
    entry.socket.send(outgoing, error => {
      if (!error) return;
      const transportError = new ProviderTransportError({
        provider: ctx.provider,
        model: ctx.model,
        phase: 'stream',
        retryable: socketFailureIsRetryable(error),
        outputEmitted: ctx.emittedModelData,
        cause: error,
        safeMessage: 'Provider WebSocket request could not be sent.',
      });
      handleTransportFailure(entry, ctx, transportError, {
        source: 'socket_send',
        failureMode: 'callback',
        socketErrorName: boundedDiagnosticIdentifier(error.name),
        socketErrorCode: boundedDiagnosticIdentifier((error as NodeJS.ErrnoException).code),
      });
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error('WebSocket send failed');
    const transportError = new ProviderTransportError({
      provider: ctx.provider,
      model: ctx.model,
      phase: 'stream',
      retryable: socketFailureIsRetryable(error),
      outputEmitted: ctx.emittedModelData,
      cause,
      safeMessage: 'Provider WebSocket request could not be sent.',
    });
    handleTransportFailure(entry, ctx, transportError, {
      source: 'socket_send',
      failureMode: 'synchronous',
      socketErrorName: boundedDiagnosticIdentifier(error.name),
      socketErrorCode: boundedDiagnosticIdentifier((error as NodeJS.ErrnoException).code),
    });
  }
}

function dispatchContext(entry: ConnectionEntry, ctx: RequestContext): void {
  const now = entry.options.now();
  entry.inFlight = true;
  entry.inFlightStartedAt = now;
  entry.current = ctx;
  ctx.entry = entry;
  if (ctx.requestId) trackEntryForRequest(ctx.requestId, entry);
  if (entry.open) {
    settleHandshakeSuccess(ctx);
    sendContext(entry, ctx);
  }
}

function finishInFlightPeriod(entry: ConnectionEntry, now: number): void {
  if (entry.inFlightStartedAt !== undefined) {
    entry.ttlPausedMs += Math.max(0, now - entry.inFlightStartedAt);
    entry.inFlightStartedAt = undefined;
  }
}

function handleSocketMessage(entry: ConnectionEntry, data: RawData): void {
  const ctx = entry.current;
  if (!ctx || ctx.closed) return;
  const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : data.toString('utf8');
  ctx.frameCount += 1;
  if (ctx.transportRetryPending) {
    ctx.transportRetryPending = false;
    emitResponseErrorDiagnostic(entry, ctx, {
      event: 'ws_transport_retry',
      outcome: 'recovered',
      attemptNumber: ctx.transportRetryCount + 1,
    } as unknown as Record<string, unknown>);
  }
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    ctx.pendingEvents.push(text.replace(/\r?\n/g, ' '));
    flushPending(ctx);
    return;
  }

  const type = eventType(event);
  trackReasoningProtocol(entry, ctx, event, type);
  captureOutput(ctx, event);
  if (type === 'response.completed') {
    const usage = responseUsage(event);
    if (usage) {
      entry.debug(responseUsageDebug(usage));
      ctx.emitDiagnostic?.({
        event: 'ws_response_usage',
        connectionId: entry.debugId,
        generation: entry.generation,
        continued: ctx.continued,
        retried: ctx.retried,
        ...usage,
      });
    }
  }
  if (isModelDataEvent(type)) ctx.emittedModelData = true;

  const errorCode = responseErrorCode(event);
  const previousMissing = errorCode === 'previous_response_not_found';
  const willRetry = previousMissing && ctx.continued && !ctx.retried && !ctx.emittedModelData;
  if (errorCode === 'websocket_connection_limit_reached' && !ctx.emittedModelData) {
    const retryAfterMs = boundedThrottleRetryAfterMs(responseRetryAfterMs(event));
    const retryAfterSeconds = retryAfterMs / 1_000;
    const error = new ProviderTransportError({
      provider: ctx.provider,
      model: ctx.model,
      phase: 'stream',
      category: 'rate_limit',
      httpStatus: 429,
      retryAfterMs,
      retryable: true,
      outputEmitted: false,
      safeMessage: 'OpenAI reported the Responses WebSocket connection limit was reached; '
        + `retry after ${retryAfterSeconds}s.`,
    });
    handleTransportFailure(entry, ctx, error, {
      source: 'error_frame',
      errorCode,
      mappedStatusCode: 429,
      retryAfterMs,
    }, 1);
    return;
  }
  if (FAILURE_EVENT_TYPES.has(type ?? '')) {
    emitResponseErrorDiagnostic(entry, ctx, {
      source: 'response_event',
      upstreamEventType: type,
      willRetry,
      ...responseFailureDetails(event),
    });
  }
  if (willRetry) {
    ctx.retried = true;
    entry.debug('previous response unavailable; retrying once with full context');
    deleteEntry(entry);
    resetContextForRetry(ctx);
    const replacement = ctx.createReplacement();
    dispatchContext(replacement, ctx);
    return;
  }

  ctx.pendingEvents.push(event);
  if (isModelDataEvent(type)) flushPending(ctx);

  if (TERMINAL_EVENT_TYPES.has(type ?? '') || type === 'error') {
    flushPending(ctx);
    const failed = FAILURE_EVENT_TYPES.has(type ?? '') || ctx.emittedProtocolAnomalies.size > 0;
    if (!failed && ctx.responseId && entry.persistent) {
      const now = entry.options.now();
      finishInFlightPeriod(entry, now);
      entry.responseId = ctx.responseId;
      entry.requestInput = inputArray(ctx.originalPayload);
      entry.expectedAssistant = expectedAssistantItems(ctx);
      entry.promptFieldHashes = ctx.promptFieldHashes;
      entry.instructionsSnapshot = ctx.instructionsSnapshot;
      entry.lastUsedAt = now;
      entry.inFlight = false;
      entry.current = undefined;
      entry.debug(`chain head updated; socket retained (${ctx.frameCount} frame(s))`);
    } else {
      deleteEntry(entry);
    }
    if (!entry.persistent) {
      try { entry.socket.close(); } catch { /* ignore */ }
    }
    closeContext(ctx);
  }
}

function createConnection(
  WebSocket: WebSocketConstructor,
  wsUrl: string,
  headers: Record<string, string>,
  persistent: boolean,
  key: string | undefined,
  credentialScopeKey: string | undefined,
  credentialFingerprint: string,
  options: ConnectionEntry['options'],
  debug: ConnectionEntry['debug'],
  /** Optional HTTP(S)_PROXY CONNECT-tunnel agent (see src/outbound-proxy.ts). */
  agent?: HttpAgent,
): ConnectionEntry {
  const now = options.now();
  const socket = new WebSocket(wsUrl, {
    headers,
    handshakeTimeout: options.handshakeTimeoutMs,
    ...(agent ? { agent } : {}),
  });
  const entry: ConnectionEntry = {
    debugId: allocateConnectionDebugId(),
    key: persistent ? key : undefined,
    credentialScopeKey: persistent ? credentialScopeKey : undefined,
    credentialFingerprint: persistent ? credentialFingerprint : undefined,
    socket,
    persistent,
    generation: persistent ? 'nursery' : 'isolated',
    open: false,
    createdAt: now,
    ttlPausedMs: 0,
    lastUsedAt: now,
    inFlight: false,
    upgradeResponsePending: false,
    options,
    debug,
  };
  if (persistent && key) registerEntry(entry);
  debug(
    `connection=${entry.debugId} key=${debugKey(entry.key)} created persistent=${persistent}`,
  );

  socket.on('open', () => {
    entry.open = true;
    debug(`connection=${entry.debugId} opened`);
    (socket as unknown as { _socket?: { unref?: () => void } })._socket?.unref?.();
    const ctx = entry.current;
    if (ctx && !ctx.closed) {
      settleHandshakeSuccess(ctx);
      sendContext(entry, ctx);
    }
  });
  socket.on('unexpected-response', (_request, response) => {
    const statusCode = response.statusCode ?? 502;
    const responseHeaders = safeResponseHeaders(response.headers);
    const parsedRetryAfterMs = statusCode === 403
      ? numericRetryAfterMs(responseHeaders['retry-after'])
      : parseRetryAfter(responseHeaders['retry-after'], entry.options.now());
    const retryAfterMs = statusCode === 403
      ? boundedThrottleRetryAfterMs(parsedRetryAfterMs)
      : parsedRetryAfterMs;
    const mappedStatusCode = statusCode === 403 ? 429 : statusCode;
    const requestId = providerRequestId(response.headers);
    debug(`unexpected-response status=${statusCode}`);
    const ctx = entry.current;
    if (!ctx || ctx.closed) {
      response.resume();
      deleteEntry(entry);
      return;
    }

    // Body observation runs before the tick-deferred failure below. suppress socket-level errors meanwhile so the failure is handled once.
    entry.upgradeResponsePending = true;
    const retryableUpgradeStatus = RETRYABLE_UPGRADE_STATUSES.has(statusCode) || statusCode === 403;
    const error = new ProviderTransportError({
      provider: ctx.provider,
      model: ctx.model,
      phase: 'websocket_upgrade',
      // 403 defaults to the terminal 'permission' category, which would force retryable back to false. reclassify so the edge throttle stays retryable.
      category: statusCode === 403 ? 'rate_limit' : undefined,
      httpStatus: mappedStatusCode,
      providerRequestId: requestId,
      retryAfterMs,
      retryable: retryableUpgradeStatus,
      outputEmitted: false,
      safeMessage: statusCode === 403
        ? 'OpenAI edge throttled the Responses WebSocket upgrade (HTTP 403); '
          + `retry after ${(retryAfterMs ?? DEFAULT_THROTTLE_RETRY_AFTER_MS) / 1_000}s.`
        : `Provider WebSocket upgrade was rejected with HTTP ${statusCode}.`,
      responseHeaders,
    });
    observeRejectedResponseBody(response, summary => emitResponseErrorDiagnostic(entry, ctx, {
      event: 'ws_upgrade_response_body',
      httpStatusCode: statusCode,
      ...summary,
    } as unknown as Record<string, unknown>));
    setImmediate(() => handleTransportFailure(entry, ctx, error, {
      source: 'unexpected_response',
      httpStatusCode: statusCode,
      mappedStatusCode,
      providerRequestId: requestId,
      retryAfterMs,
    }));
  });
  socket.on('message', (data: RawData) => handleSocketMessage(entry, data));
  socket.on('error', (cause: Error) => {
    if (entry.upgradeResponsePending) return;
    const ctx = entry.current;
    if (ctx) {
      const phase = entry.open ? 'stream' : 'connect';
      const error = new ProviderTransportError({
        provider: ctx.provider,
        model: ctx.model,
        phase,
        retryable: socketFailureIsRetryable(cause),
        outputEmitted: ctx.emittedModelData,
        cause,
        safeMessage: phase === 'connect'
          ? 'Provider WebSocket connection failed.'
          : 'Provider WebSocket stream failed.',
      });
      handleTransportFailure(entry, ctx, error, {
        source: 'socket_error',
        socketErrorName: boundedDiagnosticIdentifier(cause.name),
        socketErrorCode: boundedDiagnosticIdentifier((cause as NodeJS.ErrnoException).code),
      });
    } else deleteEntry(entry);
  });
  socket.on('close', (code: number, reason: Buffer) => {
    entry.open = false;
    if (entry.upgradeResponsePending) return;
    const ctx = entry.current;
    debug(`connection=${entry.debugId} closed code=${code} in_flight=${Boolean(ctx && !ctx.closed)}`);
    if (ctx && !ctx.closed) {
      const reasonText = reason?.length ? reason.toString('utf8') : '';
      const error = new ProviderTransportError({
        provider: ctx.provider,
        model: ctx.model,
        phase: ctx.frameCount === 0 ? 'connect' : 'stream',
        retryable: RETRYABLE_UPGRADE_STATUSES.has(code) || false,
        outputEmitted: ctx.emittedModelData,
        cause: new Error(`WebSocket closed with code ${code}`),
        safeMessage: 'Provider WebSocket closed before completion.',
      });
      handleTransportFailure(entry, ctx, error, {
        source: 'socket_close',
        closeCode: code,
        ...diagnosticTextFingerprint('closeReason', reasonText),
      });
    } else {
      deleteEntry(entry, false);
    }
  });
  return entry;
}

/**
 * Build a fetch transport backed by persistent, session-aware Responses sockets.
 * Each returned Response still represents exactly one AI SDK request.
 */
export function createResponsesWebSocketFetch(
  wsUrl: string,
  log?: (message: string) => void,
  options: ResponsesWebSocketFetchOptions = {},
): FetchFunction {
  const debug = (message: string) => { try { log?.(`ws: ${message}`); } catch { /* ignore */ } };
  const resolvedOptions = {
    hardTtlMs: options.hardTtlMs ?? RESPONSES_WS_HARD_TTL_MS,
    idleTtlMs: options.idleTtlMs ?? RESPONSES_WS_IDLE_TTL_MS,
    nurseryIdleTtlMs: options.nurseryIdleTtlMs
      ?? Math.min(RESPONSES_WS_NURSERY_IDLE_TTL_MS, options.idleTtlMs ?? RESPONSES_WS_IDLE_TTL_MS),
    maxConnections: options.maxConnections ?? RESPONSES_WS_MAX_CONNECTIONS,
    maxNurseryConnections: options.maxNurseryConnections ?? RESPONSES_WS_MAX_NURSERY_CONNECTIONS,
    maxTransportRetries: options.maxTransportRetries ?? 1,
    handshakeTimeoutMs: Math.max(1, options.handshakeTimeoutMs ?? 30_000),
    retryBaseDelayMs: Math.max(0, options.retryBaseDelayMs ?? 100),
    retryMaxDelayMs: Math.max(0, options.retryMaxDelayMs ?? 60_000),
    random: options.random ?? Math.random,
    awaitOpen: !(process.env['VITEST'] && options.eagerResponseForTests === true),
    now: options.now ?? Date.now,
  };

  return async (_input, init): Promise<Response> => {
    const { WebSocket } = await import('ws');
    // ws ignores HTTP(S)_PROXY env vars. tunnel through the configured outbound proxy when one applies to this wss URL.
    const proxyAgent = await outboundWsProxyAgent(wsUrl);
    const headers = toHeaderRecord(init?.headers);
    headers['OpenAI-Beta'] = CODEX_RESPONSES_WEBSOCKETS_BETA;

    let payload: JsonObject;
    try {
      payload = JSON.parse(bodyToString(init?.body)) as JsonObject;
    } catch {
      payload = {};
    }
    if (hasResponsesLiteHeader(headers)) payload = applyResponsesLiteShape(payload);

    const credentialFingerprint = authorizationFingerprint(headers);
    const credentialScopeKey = responsesWebSocketPartitionKey(wsUrl, payload, options);
    const partitionKey = responsesWebSocketPartitionKey(
      wsUrl,
      payload,
      options,
      credentialFingerprint,
    );
    const promptFingerprint = responsesWebSocketPromptFingerprint(payload);
    const promptFieldHashes = responsesWebSocketPromptFieldHashes(payload);
    const instructionsSnapshot = instructionsFromPayload(payload);
    const diagnosticCorrelation = currentDiagnosticContext();
    const now = resolvedOptions.now();
    const evictions = [
      ...evictStaleCredentialConnections(credentialScopeKey, credentialFingerprint),
      ...cleanupExpiredConnections(now),
    ];

    const candidates = partitionKey ? connectionEntries(partitionKey) : [];
    const idleCandidates = candidates.filter(entry => !entry.inFlight);
    const matches = idleCandidates
      .map(entry => ({ entry, match: continuationMatch(entry, payload) }))
      .filter((candidate): candidate is { entry: ConnectionEntry; match: NonNullable<typeof candidate.match> } => candidate.match !== undefined)
      // Prefer the longest matching history, which produces the smallest delta.
      .sort((left, right) => left.match.delta.length - right.match.delta.length
        || (left.match.mode === right.match.mode ? 0 : left.match.mode === 'exact' ? -1 : 1));
    let selected: ConnectionEntry | undefined = matches[0]?.entry;
    const selectedMatch = matches[0]?.match;
    const selectedDelta = selectedMatch?.delta;
    const diagnosticEntry = selected
      ?? [...idleCandidates].sort((left, right) => right.lastUsedAt - left.lastUsedAt)[0]
      ?? candidates[0];
    debug(
      `lookup key=${debugKey(partitionKey)} prompt=${debugKey(promptFingerprint)} hit=${candidates.length > 0} heads=${candidates.length} active_connections=${connectionCount()}`,
    );
    const promptChanges = changedPromptFields(diagnosticEntry?.promptFieldHashes, promptFieldHashes);
    if (promptChanges.length) debug(`prompt fields changed: ${promptChanges.join(',')}`);
    if (promptChanges.includes('instructions')) {
      const summary = instructionChangeSummary(diagnosticEntry?.instructionsSnapshot, instructionsSnapshot);
      if (summary) debug(summary);
    }
    let sendPayload = payload;
    let continued = false;
    let persistent = Boolean(partitionKey);
    let promotedConnectionId: number | undefined;
    let decision: 'continuation' | 'parallel_isolated' | 'history_mismatch_new_head' | 'new_partition_head' | 'unpartitioned_socket';

    if (selected && selectedDelta) {
      sendPayload = { ...payload, input: selectedDelta, previous_response_id: selected.responseId };
      continued = true;
      if (selected.generation === 'nursery') {
        evictions.push(...evictOldestIdleGeneration(
          'established',
          resolvedOptions.maxConnections,
          'established_lru_cap',
        ));
        selected.generation = 'established';
        promotedConnectionId = selected.debugId;
      }
      decision = 'continuation';
      debug(
        `continuing chain with ${selectedDelta.length} incremental input item(s)`
        + (selectedMatch.mode === 'omitted_reasoning' ? ' after accepting omitted reasoning' : ''),
      );
    } else if (candidates.some(entry => entry.inFlight)) {
      // Claude auxiliary requests can share a session id. never multiplex or queue a request whose lineage cannot yet include the active response.
      selected = undefined;
      persistent = false;
      decision = 'parallel_isolated';
      debug('parallel request using an isolated socket');
    } else if (diagnosticEntry) {
      // A rewind, branch, or hidden auxiliary inference gets its own full-context head. existing heads remain eligible for later exact-prefix matches.
      debug(
        `history mismatch starting an additional chain; retained ${candidates.length} existing head(s) `
        + `(${continuationMismatchSummary(diagnosticEntry, payload)})`,
      );
      decision = 'history_mismatch_new_head';
    } else if (partitionKey) {
      decision = 'new_partition_head';
    } else {
      decision = 'unpartitioned_socket';
    }

    if (!selected && persistent) {
      evictions.push(...evictOldestIdleGeneration(
        'nursery',
        resolvedOptions.maxNurseryConnections,
        'nursery_lru_cap',
      ));
    }

    const requestInput = inputArray(payload);
    emitDiagnostic(options, {
      event: 'ws_head_decision',
      decision,
      partitionKey,
      keyTuple: {
        wsUrl,
        providerId: options.providerId ?? 'openai',
        accountIdHash: options.accountId
          ? createHash('sha256').update(options.accountId).digest('hex').slice(0, 16)
          : '',
        model: typeof payload.model === 'string' ? payload.model : undefined,
        effort: typeof (payload.reasoning as JsonObject | undefined)?.effort === 'string'
          ? String((payload.reasoning as JsonObject).effort).trim().toLowerCase()
          : '',
        promptCacheKeyHash: typeof payload.prompt_cache_key === 'string'
          ? createHash('sha256').update(payload.prompt_cache_key).digest('hex').slice(0, 16)
          : undefined,
      },
      promptFingerprint,
      promptFieldHashes,
      promptChanges,
      input: {
        count: requestInput.length,
        kinds: requestInput.map(conversationItemKind),
        hashes: requestInput.map(conversationItemHash),
      },
      candidateCount: candidates.length,
      idleCandidateCount: idleCandidates.length,
      matchingCandidateCount: matches.length,
      activeConnectionCount: connectionCount(),
      nurseryConnectionCount: connectionCountByGeneration('nursery'),
      establishedConnectionCount: connectionCountByGeneration('established'),
      maxConnections: resolvedOptions.maxConnections,
      maxNurseryConnections: resolvedOptions.maxNurseryConnections,
      selectedConnectionId: selected?.debugId,
      selectedGeneration: selected?.generation,
      continuationMatchMode: selectedMatch?.mode,
      promotedConnectionId,
      createdConnectionId: selected ? undefined : peekNextConnectionDebugId(),
      createdGeneration: selected ? undefined : persistent ? 'nursery' : 'isolated',
      incrementalInputItems: selectedDelta?.length,
      heads: candidates.map(entry => ({
        connectionId: entry.debugId,
        generation: entry.generation,
        inFlight: entry.inFlight,
        ageMs: Math.max(0, now - entry.createdAt - entry.ttlPausedMs),
        physicalAgeMs: Math.max(0, now - entry.createdAt),
        ttlPausedMs: entry.ttlPausedMs,
        idleMs: Math.max(0, now - entry.lastUsedAt),
        promptChanges: changedPromptFields(entry.promptFieldHashes, promptFieldHashes),
        mismatch: continuationMismatchDetails(entry, payload),
      })),
      evictions,
    }, diagnosticCorrelation);

    let resolveHandshake: (() => void) | undefined;
    let rejectHandshake: ((reason: unknown) => void) | undefined;
    const handshake = resolvedOptions.awaitOpen
      ? new Promise<void>((resolve, reject) => {
          resolveHandshake = resolve;
          rejectHandshake = reject;
        })
      : undefined;
    let activeContext: RequestContext | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const signal = init?.signal;
        const ctx: RequestContext = {
          controller,
          encoder: new TextEncoder(),
          originalPayload: payload,
          sendPayload,
          promptFieldHashes,
          instructionsSnapshot,
          continued,
          retried: false,
          closed: false,
          frameCount: 0,
          pendingEvents: [],
          emittedModelData: false,
          transportRetryCount: 0,
          transportRetryPending: false,
          signal: signal ?? undefined,
          provider: options.providerId ?? 'openai',
          model: typeof payload.model === 'string' ? payload.model : undefined,
          handshakeSettled: !resolvedOptions.awaitOpen,
          resolveHandshake,
          rejectHandshake,
          outputByIndex: new Map(),
          outputIndexByItemId: new Map(),
          reasoningPartsByItemId: new Map(),
          recentUpstreamEventTypes: [],
          emittedProtocolAnomalies: new Set(),
          requestId: diagnosticCorrelation?.requestId,
          emitDiagnostic: options.onDiagnostic
            ? event => emitDiagnostic(options, event, diagnosticCorrelation)
            : undefined,
          createReplacement: () => createConnection(
            WebSocket as unknown as WebSocketConstructor,
            wsUrl,
            headers,
            persistent,
            partitionKey,
            credentialScopeKey,
            credentialFingerprint,
            resolvedOptions,
            debug,
            proxyAgent,
          ),
          redispatch: replacement => dispatchContext(replacement, ctx),
        };
        activeContext = ctx;
        trackActiveContext(ctx);

        const abort = () => {
          const reason = signal?.reason ?? new DOMException('Request aborted', 'AbortError');
          cancelContext(ctx, reason);
        };
        if (signal) {
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener('abort', abort, { once: true });
          ctx.abortCleanup = () => signal.removeEventListener('abort', abort);
        }

        let entry: ConnectionEntry;
        try {
          entry = selected ?? createConnection(
            WebSocket as unknown as WebSocketConstructor,
            wsUrl,
            headers,
            persistent,
            partitionKey,
            credentialScopeKey,
            credentialFingerprint,
            resolvedOptions,
            debug,
            proxyAgent,
          );
        } catch (cause) {
          const error = new ProviderTransportError({
            provider: ctx.provider,
            model: ctx.model,
            phase: 'connect',
            retryable: false,
            outputEmitted: false,
            cause,
            safeMessage: 'Provider WebSocket connection could not be created.',
          });
          errorContext(ctx, error);
          return;
        }
        dispatchContext(entry, ctx);
      },
      cancel(reason) {
        const ctx = activeContext;
        if (!ctx || ctx.closed) return;
        cancelContext(ctx, reason ?? new DOMException('Response cancelled', 'AbortError'));
      },
    });

    if (handshake) await handshake;
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  };
}
