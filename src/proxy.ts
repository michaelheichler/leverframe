import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readBody, extractApiKey, sendJson } from './http-utils.js';
import { formatAnthropicModelEntry, formatAnthropicModelList } from './server/models.js';
import { claudeCodeClientModelId, stripOneMContextSuffix } from './context-model-id.js';
import {
  writeInferenceResponseErrorLog,
  writeWebSocketDiagnosticLog,
} from './trace-log.js';
import { relayAnthropicMessages, UpstreamUnreachableError } from './upstream-forward.js';
import {
  CLAUDE_CODE_CLI_VERSION,
  injectClaudeCodeBillingSystemLine,
  injectClaudeIdentity,
  selectBetaFlags,
} from './oauth/claude-identity.js';
import { createLanguageModel, isSdkMigratedNpm, maxToolsForNpm } from './provider-factory.js';
import { randomUUID } from 'node:crypto';
import {
  translateRequest as sdkTranslateRequest,
  streamAnthropicResponse,
  generateAnthropicResponse,
  extractClaudeSessionId,
  sdkTranslationErrorSignature,
  silenceSdkWarnings,
  type AnthropicRequest,
} from './sdk-adapter.js';
import {
  anthropicErrorType,
  formatUpstreamError,
  isContextLengthExceededError,
  sdkUpstreamErrorDetails,
  sdkUpstreamResponseHeaders,
  upstreamHttpStatus,
} from './upstream-error.js';
import {
  anthropicMessagesEndpoint,
  anthropicPromptTooLongMessage,
  estimateAnthropicInputTokens,
} from './anthropic-endpoints.js';
import type { LanguageModel } from 'ai';
import {
  evictResponsesWebSocketConnectionForRequest,
  evictResponsesWebSocketConnectionsForAccessToken,
  withResponsesWebSocketDiagnosticContext,
} from './oauth/responses-websocket.js';
import { ProviderRuntimeCache } from './provider-runtime-cache.js';
import { disposeLanguageModel } from './language-model-disposal.js';
import { resolveContextWindow } from './context-window.js';
import { listenTcpServer } from './listener-ready.js';
import {
  beginExecutionTracking,
  reconcileExecutionsAtStartup,
  reconcileIncomingToolResults,
  ExecutionRecoveryBlockedError,
  EXECUTION_ID_HEADER,
  type ExecutionTrackingHandle,
} from './execution-tracking.js';
import { resolveExecutionSessionKey } from './execution-session-key.js';
import { buildProviderCapabilities } from './provider-capabilities.js';
import { createRequestExecutionContext, cancelAllActiveRequestExecutions } from './request-execution-context.js';
import { autoReplayMaxRetries } from './request-lifecycle.js';
import { createSseHeartbeat, DELAY_FIRST_HEARTBEAT } from './sse-heartbeat.js';
import { isTransientSdkStreamFailure } from './proxy-retry.js';
import {
  lookupRoute,
  parseAnthropicRequest,
  proxyExecutionMessages,
  proxyRuntimeRouteKey,
  proxyToolResults,
  revalidateUpstreamUrl,
  type ProxyModelAlias,
  type ProxyRoute,
} from './proxy-request.js';
import {
  anthropicError,
  applyProxyExecutionHeaders,
  createTranslationLifecycle,
  makeProxyLog,
} from './proxy-response.js';

export { isTransientSdkStreamFailure } from './proxy-retry.js';
export { aliasModelId, type ProxyModelAlias, type ProxyRoute } from './proxy-request.js';

const INTERNAL_ADAPTER_KEEPALIVE_TIMEOUT_MS = 60_000;

// ── HTTP server ─────────────────────────────────────────────────────

export interface ProxyHandle {
  port: number;
  token: string;
  close: () => void | Promise<void>;
}

/** Multi-model proxy: routes each request by body.model to the correct upstream. */
export async function startProxyCatalog(
  routes: ProxyRoute[],
  defaultAliasId: string,
  debug = false,
  inferenceLogPath?: string,
  debugLogPath?: string,
  webSocketDiagnosticsLogPath?: string,
  modelAliases?: ProxyModelAlias[],
): Promise<ProxyHandle> {
  const proxyToken = randomUUID();
  silenceSdkWarnings();
  const providerRuntimeCache = new ProviderRuntimeCache<LanguageModel>({
    disposeHandle: disposeLanguageModel,
    onCredentialRotated: previous => {
      evictResponsesWebSocketConnectionsForAccessToken(previous.credential);
    },
  });

  if (routes.length === 0) {
    return Promise.reject(new Error('Proxy catalog requires at least one route'));
  }

  const byAlias = new Map(routes.map(r => [r.aliasId, r]));
  for (const alias of modelAliases ?? []) {
    const route = byAlias.get(alias.routeId);
    if (route && !byAlias.has(alias.name)) byAlias.set(alias.name, route);
  }
  // Agent-tool child sessions (e.g. Claude Code's Agent tool) send the bare upstream
  // model id in the request body instead of the canonical alias id. Register realModelId
  // as a lowest-precedence fallback (lookupRoute expands via routeLookupIds at query time,
  // but byAlias itself is only ever keyed by literal aliasId/alias.name) so those requests
  // still resolve instead of falling through to Anthropic passthrough. Never override an
  // alias/canonical key already set.
  for (const route of routes) {
    if (!byAlias.has(route.realModelId)) byAlias.set(route.realModelId, route);
  }
  const defaultRoute = byAlias.get(defaultAliasId) ?? routes[0]!;

  const plog = makeProxyLog(debug, debugLogPath);
  const startupRecovery = reconcileExecutionsAtStartup();
  if (startupRecovery.length > 0) {
    plog(() => `execution reconciliation: ${startupRecovery.length} execution(s) require confirmation or expiry handling`);
  }

  const onRejection = (reason: unknown) => {
    plog(() => `Unhandled Rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
  };
  const onException = (error: Error) => {
    plog(() => `Uncaught Exception: ${error.stack || error.message}`);
  };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);

  const modelsPayload = JSON.stringify(
    formatAnthropicModelList(
      routes.map(r => ({
        id: r.aliasId,
        name: r.displayName,
        contextWindow: r.contextWindow,
        contextWindowUnconfirmed: r.contextWindowUnconfirmed,
      })),
    ),
  );

  const server = createServer(async (req, res) => {
    try {
      plog(() => `${req.method} ${req.url}`);

    // HEAD / — health check ping from Claude Code
    if (req.method === 'HEAD') {
      res.writeHead(200);
      res.end();
      return;
    }

    // GET /v1/models — Claude Code validates the model on startup and populates /model picker
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      const modelPathMatch = req.url.match(/^\/v1\/models\/([^?]+)/);
      if (modelPathMatch) {
        const id = decodeURIComponent(modelPathMatch[1]);
        const route = lookupRoute(byAlias, id);
        if (route) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(formatAnthropicModelEntry({
            id: route.aliasId,
            name: route.displayName,
            contextWindow: route.contextWindow,
            contextWindowUnconfirmed: route.contextWindowUnconfirmed,
          })));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'not_found_error', message: `Model '${id}' not found` } }));
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(modelsPayload);
      }
      return;
    }

    const messagesEndpoint = anthropicMessagesEndpoint(req.url);

    // Anthropic message creation and token counting are distinct endpoints.
    if (req.method === 'POST' && messagesEndpoint) {
      const inboundKey = extractApiKey(req);
      if (inboundKey !== proxyToken) {
        anthropicError(res, 401, 'Invalid proxy token');
        return;
      }

      const clientAbort = new AbortController();
      const abortForClientDisconnect = () => {
        if (!clientAbort.signal.aborted) clientAbort.abort(new Error('Client disconnected'));
      };
      req.once('aborted', abortForClientDisconnect);
      res.once('close', () => {
        if (!res.writableFinished) abortForClientDisconnect();
      });

      const raw = await readBody(req);
      const parsedRequest = parseAnthropicRequest(raw);
      if (!parsedRequest.ok) {
        anthropicError(res, parsedRequest.status, parsedRequest.message);
        return;
      }
      const anthropicBody = parsedRequest.body;

      const originalModel = anthropicBody.model;
      const clientWantsStream = Boolean(anthropicBody.stream);
      const relayRequestIdRaw = req.headers['x-relay-request-id'];
      const relayRequestId = Array.isArray(relayRequestIdRaw) ? relayRequestIdRaw[0] : relayRequestIdRaw;

      // A missing `model` field falls back to the default route (Claude Code's
      // token-counting and health-probe requests omit it). A *present* but
      // unrecognized model id must never silently reroute to a different
      // provider's route — that would send the request, and its credentials,
      // to a provider the caller did not select (stabilization plan §9.2,
      // upstream 383f464: configured routes must not bypass to another
      // provider). Reject it explicitly instead.
      const resolvedRoute = typeof originalModel === 'string' ? lookupRoute(byAlias, originalModel) : undefined;
      if (typeof originalModel === 'string' && !resolvedRoute) {
        anthropicError(res, 404, `Unknown model: ${originalModel}`);
        return;
      }
      const route = resolvedRoute ?? defaultRoute;
      const credentialRouteKey = proxyRuntimeRouteKey(route);
      let credential = providerRuntimeCache.snapshot(credentialRouteKey, route.apiKey);
      if (route.authType !== 'oauth' && credential.credential !== route.apiKey) {
        credential = await providerRuntimeCache.adopt(
          credentialRouteKey,
          credential.credential,
          route.apiKey,
        );
      }
      const apiKey = credential.credential;
      const upstreamUrl = route.upstreamUrl;
      const providerId = route.providerId ?? route.aliasId.split(':')[1] ?? 'unknown';
      // The client-facing model id: the validated `model` field when present,
      // else the alias the default route was matched under (Claude Code's
      // token-counting/health-probe requests omit `model` entirely).
      const clientModelId = originalModel ?? route.aliasId;

      plog(() =>
        `POST /v1/messages - alias=${originalModel} route=${route.realModelId} format=${route.modelFormat} key=${apiKey ? `len:${apiKey.length}` : 'MISSING'}`,
      );

      const usesSdkAdapter = isSdkMigratedNpm(route.npm);

      // Owns accepted/validated/dispatched/first-output/terminal transitions,
      // the four deadline classes, and downstream-disconnect cancellation for
      // this request; `clientAbort` (wired above) doubles as its local-shutdown
      // signal. Every branch below drives it through its narrow observer
      // surface and disposes it exactly once on the way out.
      const requestExecution = createRequestExecutionContext({
        requestId: relayRequestId ?? randomUUID(),
        provider: providerId,
        model: typeof originalModel === 'string' ? originalModel : route.aliasId,
        correlationId: relayRequestId,
        signal: clientAbort.signal,
        deadlines: route.requestDeadlines,
      });
      // Every response path below ends in exactly one of res 'finish' (sent)
      // or 'close' (torn down before finishing); either one is this
      // request's single terminal-disposal point regardless of which early
      // return produced it.
      res.once('finish', () => requestExecution.dispose());
      res.once('close', () => requestExecution.dispose());

      if (messagesEndpoint === 'count_tokens') {
        if (route.modelFormat !== 'anthropic') {
          const inputTokens = estimateAnthropicInputTokens(anthropicBody);
          plog(() => `token-count: local estimate model=${originalModel} input_tokens=${inputTokens}`);
          res.setHeader('x-relay-token-count-source', 'local-estimate');
          // Local estimate never touches the upstream/SDK, so no phase call
          // has moved the lifecycle past `resolving` yet; `complete()` is
          // only a legal transition from `streaming`/`headers`, so advance
          // through those phases here rather than relaxing that invariant.
          requestExecution.markStreamActivity();
          requestExecution.markOutputEmitted();
          requestExecution.complete();
          sendJson(res, 200, { input_tokens: inputTokens });
          return;
        }

        if (!apiKey) {
          anthropicError(res, 401, 'Missing API key');
          return;
        }

        if (!await revalidateUpstreamUrl(upstreamUrl)) {
          anthropicError(res, 400, 'Custom endpoint URL failed security revalidation.');
          return;
        }

        const betaHeaderRaw = req.headers['anthropic-beta'];
        const inboundBeta = Array.isArray(betaHeaderRaw) ? betaHeaderRaw.join(',') : betaHeaderRaw;
        const forwardBody = { ...anthropicBody, model: route.realModelId };
        const targetUrl = `${upstreamUrl}/v1/messages/count_tokens`;
        const isOAuth = route.authType === 'oauth';
        try {
          await relayAnthropicMessages(res, targetUrl, forwardBody, apiKey, false, {
            inboundBeta,
            authType: isOAuth ? 'oauth' : 'api',
            log: message => plog(message),
            extraHeaders: route.headers,
            refreshToken: route.refreshToken,
            onTokenRefreshed: async refreshed => {
              await providerRuntimeCache.adopt(credentialRouteKey, apiKey, refreshed);
            },
            signal: clientAbort.signal,
            lifecycle: requestExecution,
          });
        } catch (err) {
          if (clientAbort.signal.aborted) return;
          requestExecution.fail(err);
          const message = err instanceof UpstreamUnreachableError ? err.message : String(err);
          plog(() => `anthropic token-count error: ${message}`);
          anthropicError(res, 502, message);
        }
        return;
      }

      const sessionHeaderValue = req.headers['x-claude-code-session-id'];
      const sessionHeader = Array.isArray(sessionHeaderValue) ? sessionHeaderValue[0] : sessionHeaderValue;
      const claudeSessionId = extractClaudeSessionId(anthropicBody, sessionHeader);
      const executionSessionKey = resolveExecutionSessionKey({
        claudeSessionId,
        provider: providerId,
        model: route.realModelId,
      });
      reconcileIncomingToolResults({ sessionKey: executionSessionKey, toolResults: proxyToolResults(anthropicBody) });
      const executionHeader = req.headers[EXECUTION_ID_HEADER];
      const requestedExecutionId = Array.isArray(executionHeader) ? executionHeader[0] : executionHeader;
      const trackedRequestId = relayRequestId ?? randomUUID();
      // Provider capabilities are consulted once, at this operation boundary,
      // and drive both execution tracking and the request-lifecycle deadline
      // classes below (RequestLifecycle only arms the idle deadline once a
      // response actually starts streaming, so a non-streaming-capable route
      // never pays an idle-timeout cost it cannot trigger).
      const providerCapabilities = buildProviderCapabilities({
        providerId,
        supportedParameters: route.supportedParameters,
        streaming: true,
        tools: Array.isArray(anthropicBody.tools),
        reasoning: route.reasoning,
        websocket: route.preferWebSockets,
        clientManagedState: true,
      });
      let tracking: ExecutionTrackingHandle;
      try {
        tracking = beginExecutionTracking({
          sessionKey: executionSessionKey,
          executionId: requestedExecutionId,
          requestId: trackedRequestId,
          provider: providerId,
          model: typeof originalModel === 'string' ? originalModel : route.aliasId,
          route: route.modelFormat === 'anthropic' ? 'passthrough' : 'translated',
          messages: proxyExecutionMessages(anthropicBody),
          capabilities: providerCapabilities,
        });
      } catch (error) {
        if (error instanceof ExecutionRecoveryBlockedError) {
          anthropicError(res, error.statusCode, error.message);
          return;
        }
        throw error;
      }

      if (!apiKey && !usesSdkAdapter) {
        anthropicError(res, 401, 'Missing API key');
        return;
      }

      requestExecution.startResolving();

      // ── Anthropic passthrough ───────────────────────────────────────
      // Forward raw Anthropic body (with real model id) directly to the upstream.
      // No translation needed — the upstream speaks Anthropic natively.
      if (route.modelFormat === 'anthropic') {
        if (!await revalidateUpstreamUrl(upstreamUrl)) {
          anthropicError(res, 400, 'Custom endpoint URL failed security revalidation.');
          return;
        }
        const betaHeaderRaw = req.headers['anthropic-beta'];
        const inboundBeta = Array.isArray(betaHeaderRaw) ? betaHeaderRaw.join(',') : betaHeaderRaw;
        const forwardBody = { ...anthropicBody, model: route.realModelId };
        const targetUrl = `${upstreamUrl}/v1/messages`;
        const isOAuth = route.authType === 'oauth';

        let effectiveBeta = inboundBeta;
        let claudeCodeSessionId: string | undefined;
        if (isOAuth) {
          // Identity injection and beta selection for Claude Code OAuth.
          const seed = route.providerId ?? route.realModelId;
          const identity = injectClaudeIdentity(forwardBody, route.providerData, seed);
          if (route.providerId === 'claude-code') injectClaudeCodeBillingSystemLine(forwardBody);
          claudeCodeSessionId = identity.sessionId;
          effectiveBeta = selectBetaFlags(forwardBody, route.realModelId, inboundBeta);
          plog(() => `anthropic-oauth: model=${route.realModelId}, beta=${effectiveBeta}`);
          plog(() => `anthropic-oauth headers: user-agent=claude-cli/${CLAUDE_CODE_CLI_VERSION} x-app=cli session-header=${claudeCodeSessionId ? 'set' : 'missing'}`);
        } else {
          plog(() => `anthropic-passthrough: model=${route.realModelId}, stream=${clientWantsStream}`);
        }

        try {
          applyProxyExecutionHeaders(res, tracking);
          await relayAnthropicMessages(res, targetUrl, forwardBody, apiKey, clientWantsStream, {
            inboundBeta: effectiveBeta,
            authType: isOAuth ? 'oauth' : 'api',
            log: message => plog(message),
            claudeCodeSessionId,
            extraHeaders: route.headers,
            refreshToken: route.refreshToken,
            onTokenRefreshed: async refreshed => {
              await providerRuntimeCache.adopt(credentialRouteKey, apiKey, refreshed);
            },
            signal: clientAbort.signal,
            responseModelId: originalModel,
            onObservedText: text => {
              if (clientWantsStream) {
                tracking.observeAnthropicSseText(text);
                return;
              }
              try {
                tracking.observeNonStreamAnthropic(JSON.parse(text));
              } catch {
                // Invalid/error bodies do not contain observable tool calls.
              }
            },
            onUpstreamError: inferenceLogPath
              ? (statusCode, errorContent) => writeInferenceResponseErrorLog(inferenceLogPath, {
                  modelId: clientModelId,
                  provider: route.providerId ?? route.aliasId.split(':')[1] ?? 'unknown',
                  route: 'passthrough',
                  statusCode,
                  errorContent,
                })
              : undefined,
            lifecycle: requestExecution,
          });
        } catch (err) {
          if (clientAbort.signal.aborted) return;
          requestExecution.fail(err);
          const message = err instanceof UpstreamUnreachableError ? err.message : String(err);
          plog(() => `anthropic-passthrough error: ${message}`);
          anthropicError(res, 502, message);
        }
        return;
      }

      // ── SDK-backed providers (Vercel AI SDK) ────────────────────────
      // OpenCode-assigned npm packages route through the SDK, which owns wire
      // format, endpoint selection, and provider quirks.
      if (usesSdkAdapter) {
        if (route.baseURL && !await revalidateUpstreamUrl(route.baseURL)) {
          anthropicError(res, 400, 'Custom endpoint URL failed security revalidation.');
          return;
        }
        const openAiOAuth = route.npm === '@ai-sdk/openai' && route.authType === 'oauth';
        const translationLifecycle = createTranslationLifecycle(
          inferenceLogPath,
          relayRequestId,
          clientModelId,
          route.providerId ?? route.aliasId.split(':')[1] ?? 'unknown',
        );
        try {
          const claudeSessionIdHeader = Array.isArray(req.headers['x-claude-code-session-id'])
            ? req.headers['x-claude-code-session-id'][0]
            : req.headers['x-claude-code-session-id'];
          const claudeSessionId = extractClaudeSessionId(anthropicBody, claudeSessionIdHeader);
          // Validated DTO: `sdkTranslateRequest` requires `model: string`, but
          // the raw wire body's `model` is optional (see `clientModelId`).
          const sdkRequestBody: AnthropicRequest = { ...anthropicBody, model: clientModelId, messages: anthropicBody.messages ?? [] };
          const params = sdkTranslateRequest(sdkRequestBody, route.npm!, {
            openAiOAuth,
            claudeSessionId,
            maxTools: maxToolsForNpm(route.npm),
            reasoningMetadata: {
              providerId: route.providerId,
              apiBaseUrl: route.baseURL,
              supportedParameters: route.supportedParameters,
              reasoning: route.reasoning,
              interleavedReasoningField: route.interleavedReasoningField,
              upstreamModelId: route.realModelId,
            },
          });
          plog(() =>
            `sdk: npm=${route.npm} model=${route.realModelId}, stream=${clientWantsStream}, ` +
            `tools=${anthropicBody.tools?.length ?? 0}, msgs=${params.messages.length}`,
          );
          const model = await providerRuntimeCache.getHandle(
            credentialRouteKey,
            credential,
            handleCredential => createLanguageModel({
              npm: route.npm!,
              modelId: route.realModelId,
              apiKey: handleCredential.credential,
              baseURL: route.baseURL,
              providerId: route.providerId ?? route.aliasId,
              authType: route.authType,
              oauthAccountId: route.oauthAccountId,
              providerData: route.providerData,
              headers: route.headers,
              useResponsesLite: route.useResponsesLite,
              preferWebSockets: route.preferWebSockets,
              onDebug: (msg: string) => plog(() => msg),
              onWebSocketDiagnostic: webSocketDiagnosticsLogPath
                ? event => writeWebSocketDiagnosticLog(webSocketDiagnosticsLogPath, event)
                : undefined,
            }),
          );
          translationLifecycle?.dispatched();
          if (clientWantsStream) {
            const writeStreamChunk = (chunk: string) => {
              requestExecution.markOutputEmitted();
              translationLifecycle?.onOutput(chunk);
              tracking.observeAnthropicSseText(chunk);
              if (!res.headersSent) {
                applyProxyExecutionHeaders(res, tracking);
                res.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive',
                });
              }
              res.write(chunk);
              heartbeat.reset();
            };
            const heartbeat = createSseHeartbeat(() => {
              if (!res.headersSent) {
                applyProxyExecutionHeaders(res, tracking);
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
            const maxRetries = autoReplayMaxRetries();
            let retryCount = 0;
            try {
              while (true) {
                try {
                  await withResponsesWebSocketDiagnosticContext(
                    { requestId: trackedRequestId, claudeSessionId },
                    () => streamAnthropicResponse(
                      model,
                      params,
                      clientModelId,
                      writeStreamChunk,
                      plog,
                      {
                        onPart: partType => translationLifecycle?.onPart(partType),
                        initialInputTokens: estimateAnthropicInputTokens(anthropicBody),
                        abortSignal: clientAbort.signal,
                        clientAbortSignal: clientAbort.signal,
                        lifecycle: requestExecution,
                      },
                    ),
                  );
                  break;
                } catch (error) {
                  if (retryCount >= maxRetries
                    || !requestExecution.canReplay()
                    || !isTransientSdkStreamFailure(error)) {
                    throw error;
                  }
                  retryCount += 1;
                  const reason = sdkTranslationErrorSignature(error);
                  if (reason === 'reasoning_part_not_found') {
                    evictResponsesWebSocketConnectionForRequest(trackedRequestId);
                  }
                  requestExecution.recordRetryAttempt({ attempt: retryCount, reason });
                  tracking.recordRetryAttempt();
                  plog(() => `sdk auto-replay: retry=${retryCount}/${maxRetries} reason=${reason}`);
                }
              }
              translationLifecycle?.complete();
              requestExecution.markStreamActivity();
              requestExecution.complete();
              if (!res.headersSent) writeStreamChunk('');
              res.end();
            } finally {
              heartbeat.clear();
              clientAbort.signal.removeEventListener('abort', clearHeartbeat);
            }
          } else {
            // ChatGPT's Codex backend (OpenAI OAuth) rejects non-streaming requests
            // outright ("Stream must be set to true"), so always stream internally
            // for it and collect the result, regardless of what the client asked for.
            const anthropicResponse = await withResponsesWebSocketDiagnosticContext(
              { requestId: trackedRequestId, claudeSessionId },
              () => generateAnthropicResponse(
                model,
                params,
                clientModelId,
                {
                  forceStream: openAiOAuth,
                  abortSignal: clientAbort.signal,
                  onPart: partType => translationLifecycle?.onPart(partType),
                  lifecycle: requestExecution,
                  log: plog,
                },
              ),
            );
            translationLifecycle?.onOutput(JSON.stringify(anthropicResponse));
            translationLifecycle?.complete();
            requestExecution.markStreamActivity();
            requestExecution.markOutputEmitted();
            requestExecution.complete();
            tracking.observeNonStreamAnthropic(anthropicResponse);
            applyProxyExecutionHeaders(res, tracking);
            sendJson(res, 200, anthropicResponse);
          }
        } catch (err) {
          if (clientAbort.signal.aborted) {
            translationLifecycle?.cancel();
            return;
          }
          requestExecution.fail(err);
          tracking.fail(undefined);
          const sdkErrorSignature = sdkTranslationErrorSignature(err);
          if (sdkErrorSignature === 'reasoning_part_not_found') {
            evictResponsesWebSocketConnectionForRequest(trackedRequestId);
          }
          translationLifecycle?.fail(
            err instanceof Error ? err.name : 'UpstreamError',
            sdkErrorSignature,
          );
          const message = formatUpstreamError(err);
          const details = sdkUpstreamErrorDetails(err);
          const upstreamStatus = details?.statusCode ?? upstreamHttpStatus(err, message);
          const contextLengthExceeded = upstreamStatus === 400
            && isContextLengthExceededError(err, message);
          const clientMessage = contextLengthExceeded
            ? anthropicPromptTooLongMessage(
                anthropicBody,
                resolveContextWindow(route.realModelId, route.contextWindow, route.contextWindowUnconfirmed),
              )
            : message;
          plog(() => `sdk error: ${message}${details?.errorContent ? ` — body: ${details.errorContent}` : ''}`);
          if (inferenceLogPath && upstreamStatus >= 400) {
            writeInferenceResponseErrorLog(inferenceLogPath, {
              ...(relayRequestId ? { requestId: relayRequestId } : {}),
              modelId: clientModelId,
              provider: route.providerId ?? route.aliasId.split(':')[1] ?? 'unknown',
              route: 'translated',
              statusCode: upstreamStatus,
              errorContent: details?.errorContent ?? message,
              isRetryable: details?.isRetryable,
              attemptCount: details?.attemptCount,
            });
          }
          if (!res.headersSent) {
            for (const [name, value] of Object.entries(sdkUpstreamResponseHeaders(details))) {
              res.setHeader(name, value);
            }
            anthropicError(
              res,
              upstreamStatus === 500 ? 502 : upstreamStatus,
              clientMessage,
              contextLengthExceeded ? (relayRequestId ?? randomUUID()) : undefined,
            );
          } else {
            const errorType = anthropicErrorType(upstreamStatus);
            res.write(`event: error\ndata: ${JSON.stringify({
              type: 'error',
              error: {
                type: errorType,
                message: clientMessage,
                status_code: upstreamStatus,
                ...(details?.retryAfterMs !== undefined ? { retry_after: Math.ceil(details.retryAfterMs / 1_000) } : {}),
              },
              ...(contextLengthExceeded ? { request_id: relayRequestId ?? randomUUID() } : {}),
            })}\n\n`);
            res.end();
          }
        }
        return;
      }

      // Non-anthropic route without a registered SDK npm — misconfigured route.
      anthropicError(res, 500, `No SDK provider configured for model ${originalModel} (npm=${route.npm ?? 'none'})`);
      return;
    }

    // Everything else → 404
    anthropicError(res, 404, `Unknown endpoint: ${req.method} ${req.url}`);
    } catch (err) {
      if (res.writableEnded || res.destroyed) return;
      const isClientError = err instanceof URIError || err instanceof SyntaxError;
      plog(() => `proxy request failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
      if (!res.headersSent) {
        anthropicError(
          res,
          isClientError ? 400 : 500,
          isClientError
            ? `Malformed request: ${err instanceof Error ? err.message : String(err)}`
            : 'Internal proxy error',
        );
      } else {
        try { res.end(); } catch { /* socket torn down */ }
      }
    }
  });

  server.keepAliveTimeout = INTERNAL_ADAPTER_KEEPALIVE_TIMEOUT_MS;
  const cleanupListeners = () => {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
  };
  let address: AddressInfo;
  try {
    address = await listenTcpServer(server, 0, '127.0.0.1');
  } catch (error) {
    cleanupListeners();
    throw error;
  }
  plog(() => `started on port ${address.port}, catalog=${routes.length} model(s), default=${defaultRoute.aliasId}`);
  return {
    port: address.port,
    token: proxyToken,
    close: async () => {
      cleanupListeners();
      // Local shutdown: settle every in-flight request to a `cancelled`
      // terminal outcome instead of abandoning it mid-stream.
      cancelAllActiveRequestExecutions();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await providerRuntimeCache.dispose();
    },
  };
}

/** Single-model proxy — backward-compatible wrapper around startProxyCatalog. */
export function startProxy(
  completionsUrl: string,
  modelId: string,
  debug = false,
  contextWindow?: number,
  sdk?: {
    npm?: string;
    baseURL?: string;
    upstreamModelId?: string;
    providerId?: string;
    authType?: 'api' | 'oauth' | 'none';
    oauthAccountId?: string;
    providerData?: Record<string, unknown>;
    modelFormat?: 'anthropic' | 'openai';
    supportedParameters?: string[];
    reasoning?: boolean;
    interleavedReasoningField?: string;
    useResponsesLite?: boolean;
    preferWebSockets?: boolean;
  },
  apiKey?: string,
): Promise<ProxyHandle> {
  const bareModelId = stripOneMContextSuffix(modelId);
  const clientModelId = claudeCodeClientModelId(modelId, contextWindow);
  return startProxyCatalog([{
    aliasId: clientModelId,
    realModelId: sdk?.upstreamModelId ?? bareModelId,
    displayName: bareModelId,
    upstreamUrl: completionsUrl,
    apiKey: apiKey ?? '',
    modelFormat: sdk?.modelFormat ?? 'openai',
    contextWindow,
    npm: sdk?.npm,
    baseURL: sdk?.baseURL,
    providerId: sdk?.providerId,
    authType: sdk?.authType,
    oauthAccountId: sdk?.oauthAccountId,
    providerData: sdk?.providerData,
    supportedParameters: sdk?.supportedParameters,
    reasoning: sdk?.reasoning,
    interleavedReasoningField: sdk?.interleavedReasoningField,
    useResponsesLite: sdk?.useResponsesLite,
    preferWebSockets: sdk?.preferWebSockets,
  }], clientModelId, debug);
}
