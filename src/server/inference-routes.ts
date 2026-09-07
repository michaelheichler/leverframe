import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LanguageModel } from 'ai';
import {
  translateOpenAiRequest,
  generateOpenAiResponse,
  streamOpenAiResponse,
  type OpenAiRequest,
} from '../openai-adapter.js';
import { sendJson } from '../http-utils.js';
import { relayAnthropicMessages } from '../upstream-forward.js';
import {
  anthropicPromptTooLongMessage,
  estimateAnthropicInputTokens,
} from '../anthropic-endpoints.js';
import { resolveProviderCredential } from '../env.js';
import { oauthAuthRef } from '../registry/import-build.js';
import {
  injectClaudeCodeBillingSystemLine,
  injectClaudeIdentity,
  selectBetaFlags,
} from '../oauth/claude-identity.js';
import {
  getLatestMessagePreview,
  writeInferenceResponseErrorLog,
  writeInferenceResponseLifecycleLog,
  writeWebSocketDiagnosticRequestLog,
} from '../trace-log.js';
import type { ServerOptions } from './router.js';
import { isSdkMigratedNpm, maxToolsForNpm } from '../provider-factory.js';
import {
  anthropicErrorType,
  clientFacingAnthropicStatus,
  formatUpstreamError,
  isContextLengthExceededError,
  isTerminalUsageLimitText,
  sdkUpstreamErrorDetails,
  sdkUpstreamResponseHeaders,
} from '../upstream-error.js';
import { reportedContextWindow } from '../context-window.js';
import {
  translateRequest as sdkTranslateRequest,
  streamAnthropicResponse,
  generateAnthropicResponse,
  anthropicEffortFromRequest,
  extractClaudeSessionId,
  type AnthropicRequest,
  type AnthropicUsageTrace,
} from '../sdk-adapter.js';
import { withResponsesWebSocketDiagnosticContext } from '../oauth/responses-websocket.js';
import { ProviderRuntimeCache } from '../provider-runtime-cache.js';
import {
  beginExecutionTracking,
  reconcileIncomingToolResults,
  ExecutionRecoveryBlockedError,
  EXECUTION_ID_HEADER,
  type ExecutionTrackingHandle,
} from '../execution-tracking.js';
import { createRequestExecutionContext } from '../request-execution-context.js';
import { resolveExecutionSessionKey } from '../execution-session-key.js';
import { attachRequestExecutionDisposal, wireClientDisconnectAbort } from '../request-pipeline.js';
import { createSseHeartbeat, DELAY_FIRST_HEARTBEAT } from '../sse-heartbeat.js';
import {
  applyExecutionHeaders,
  auditInference,
  auditSdkError,
  attachAnthropicObserver,
  executionCapabilities,
  extractAnthropicToolResults,
  extractOpenAiToolResults,
  getOrInitLanguageModel,
  getResponseModelId,
  inferenceProvider,
  lookupModel,
  openAiEffort,
  providerRuntimeRouteKey,
  readJson,
  requestHeader,
  respondExecutionRecoveryBlocked,
  revalidateEndpointUrl,
  toDigestableMessages,
  type PLog,
} from './route-helpers.js';
import { supportsDirectOpenAIChatCompletions, upstreamModelId } from './models.js';

export async function handleAnthropicMessages(
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

  const { controller: clientAbort, detach: detachClientAbort } = wireClientDisconnectAbort(req, res);

  const requestExecution = createRequestExecutionContext({
    requestId,
    provider: inferenceProvider(model),
    model: model.id,
    correlationId: requestId,
    signal: clientAbort.signal,
  });
  attachRequestExecutionDisposal(res, requestExecution);
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
        supportsTemperature: model.supportsTemperature,
        supportedReasoningEfforts: model.supportedReasoningEfforts,
        defaultReasoningEffort: model.defaultReasoningEffort,
        supportsReasoningSummaries: model.supportsReasoningSummaries,
        supportsReasoningSummaryParameter: model.supportsReasoningSummaryParameter,
        supportsParallelToolCalls: model.supportsParallelToolCalls,
        supportsReasoningToggle: model.supportsReasoningToggle,
        supportsPromptCacheBreakpoints: model.supportsPromptCacheBreakpoints,
        useResponsesLite: model.useResponsesLite,
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
              contextWindow: reportedContextWindow(model.contextWindow, model.contextWindowUnconfirmed),
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

        const anthropicResponse = await withResponsesWebSocketDiagnosticContext(
          { requestId, claudeSessionId },
          () => generateAnthropicResponse(languageModel, params, responseModelId, {
            forceStream: openAiOAuth,
            abortSignal: clientAbort.signal,
            onUsage,
            lifecycle: requestExecution,
            contextWindow: reportedContextWindow(model.contextWindow, model.contextWindowUnconfirmed),
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
      const clientStatus = clientFacingAnthropicStatus(status, message, details?.errorContent);
      const terminalUsageLimit = clientStatus !== status
        && isTerminalUsageLimitText(message, details?.errorContent);
      const contextLengthExceeded = status === 400
        && isContextLengthExceededError(err, message);
      const reportedWindow = reportedContextWindow(model.contextWindow, model.contextWindowUnconfirmed);
      const clientMessage = contextLengthExceeded && reportedWindow !== undefined
        ? anthropicPromptTooLongMessage(
            body,
            reportedWindow,
          )
        : message;
      plog(() => `sdk error npm=${model.npm} upstream=${upstreamModelId(model)}: ${message}${details?.errorContent ? `, body: ${details.errorContent}` : ''}`);
      if (!res.headersSent) {
        if (!terminalUsageLimit) {
          for (const [name, value] of Object.entries(sdkUpstreamResponseHeaders(details))) {
            res.setHeader(name, value);
          }
        }
        if (contextLengthExceeded) {
          sendJson(res, 400, {
            type: 'error',
            error: { type: 'invalid_request_error', message: clientMessage },
            request_id: requestId,
          });
        } else {
          sendJson(res, clientStatus === 500 ? 502 : clientStatus, {
            type: 'error',
            error: { type: anthropicErrorType(clientStatus), message: clientMessage },
          });
        }
      } else {
        const errorType = anthropicErrorType(clientStatus);
        res.write(`event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: {
            type: errorType,
            message: clientMessage,
            status_code: clientStatus,
            ...(!terminalUsageLimit && details?.retryAfterMs !== undefined
              ? { retry_after: Math.ceil(details.retryAfterMs / 1_000) }
              : {}),
          },
          ...(contextLengthExceeded ? { request_id: requestId } : {}),
        })}\n\n`);
        res.end();
      }
    } finally {
      detachClientAbort();
    }
    return;
  }

  sendJson(res, 400, { error: { message: `Unsupported model format: ${model.modelFormat}` } });
}

export async function handleOpenAIChatCompletions(
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
