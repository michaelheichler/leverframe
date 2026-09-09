import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LanguageModel } from 'ai';
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
import { maxToolsForNpm } from '../provider-factory.js';
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
import {
  applyExecutionHeaders,
  auditInference,
  auditSdkError,
  attachAnthropicObserver,
  executionCapabilities,
  extractAnthropicToolResults,
  getOrInitLanguageModel,
  getResponseModelId,
  inferenceProvider,
  lookupModel,
  providerRuntimeRouteKey,
  readJson,
  requestHeader,
  respondExecutionRecoveryBlocked,
  toDigestableMessages,
  type PLog,
} from './route-helpers.js';
import { upstreamModelId } from './models.js';
import { validateAnthropicMessagesRoute } from './route-validation.js';
import { createTrackedSseResponse } from './sse-response.js';

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
  const routeValidation = await validateAnthropicMessagesRoute(model);
  if (routeValidation) {
    sendJson(res, 400, { error: { message: routeValidation } });
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
      toolResults: extractAnthropicToolResults(body),
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
        const sse = createTrackedSseResponse({
          res,
          clientAbortSignal: clientAbort.signal,
          applyHeaders: () => applyExecutionHeaders(res, tracking),
          observeChunk: tracking.observeAnthropicSseText,
        });
        sse.start();
        try {
          await withResponsesWebSocketDiagnosticContext(
            { requestId, claudeSessionId },
            () => streamAnthropicResponse(languageModel, params, responseModelId, sse.writeChunk, undefined, {
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
          if (!res.headersSent) sse.writeChunk('');
          res.end();
        } finally {
          sse.stop();
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
