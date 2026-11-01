import type { LanguageModel } from 'ai';
import { sendJson } from '../http-utils.js';
import { anthropicPromptTooLongMessage, estimateAnthropicInputTokens } from '../anthropic-endpoints.js';
import { getLatestMessagePreview, writeInferenceResponseLifecycleLog } from '../trace-log.js';
import { isOpenAiOAuth, maxToolsForNpm } from '../provider-factory.js';
import { anthropicErrorType, clientFacingAnthropicStatus, formatUpstreamError, isContextLengthExceededError, isTerminalUsageLimitText, sdkUpstreamErrorDetails, sdkUpstreamResponseHeaders } from '../upstream-error.js';
import { reportedContextWindow } from '../context-window.js';
import { translateRequest as sdkTranslateRequest, streamAnthropicResponse, generateAnthropicResponse, anthropicEffortFromRequest, type AnthropicRequest, type AnthropicUsageTrace } from '../sdk-adapter.js';
import { withResponsesWebSocketDiagnosticContext } from '../oauth/responses-websocket.js';
import { applyExecutionHeaders, auditInference, auditSdkError, getOrInitLanguageModel, getResponseModelId, inferenceProvider } from './route-helpers.js';
import { upstreamModelId } from './models.js';
import { createTrackedSseResponse } from './sse-response.js';
import { rememberConfiguredPool } from '../account-pool-dispatch.js';
import { dispatchSdkPool } from '../account-pool-sdk.js';
import type { NativeRequestContext } from './anthropic-native-route.js';

export async function handleSdkAnthropicMessages(context: NativeRequestContext): Promise<void> {
  const { res, options, modelCache, body, model, claudeSessionId, clientAbort, requestExecution, tracking } = context;
  const prepared = prepareSdkRequest(context);
  const { apiKey, params, clientWantsStream, responseModelId, onUsage } = prepared;
  try {
    if (model.providerId === 'openai-oauth' && model.authType === 'oauth'
      && rememberConfiguredPool(options.managedPools ?? new Set(), model.providerId, 'oauth')) {
      await dispatchSdkPool({
        res, params, cache: modelCache, sessionId: claudeSessionId, signal: clientAbort.signal,
        clientModelId: responseModelId, stream: clientWantsStream, lifecycle: requestExecution, tracking,
        contextWindow: reportedContextWindow(model.contextWindow, model.contextWindowUnconfirmed),
        initialInputTokens: estimateAnthropicInputTokens(body), onUsage,
        route: {
          aliasId: model.id, realModelId: upstreamModelId(model), displayName: model.name,
          upstreamUrl: model.baseUrl ?? '', apiKey, modelFormat: 'openai', npm: model.npm,
          providerId: model.providerId, authType: model.authType, baseURL: model.apiBaseUrl,
          headers: model.headers, useResponsesLite: model.useResponsesLite,
          minimalClientVersion: model.minimalClientVersion,
        },
      });
      return;
    }
    const languageModel = await getOrInitLanguageModel(
      modelCache, model, model.npm!, model.apiBaseUrl, apiKey, options.webSocketDiagnosticsLogPath,
    );
    if (clientWantsStream) {
      await executeSdkStream(context, prepared, languageModel);
    } else {
      await executeSdkGenerate(context, prepared, languageModel);
    }
  } catch (err) {
    respondSdkFailure(context, err);
  }
}

function prepareSdkRequest(context: NativeRequestContext) {
  const { options, plog, body, model, requestId, claudeSessionId } = context;
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
  const openAiOAuth = isOpenAiOAuth(model.npm, model.authType, model.providerId);
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
  const clientWantsStream = Boolean(body.stream);
  const responseModelId = getResponseModelId(body.model, model, options);
  const onUsage = createSdkUsageObserver(context);

  plog(() => `sdk npm=${model.npm} upstream=${upstreamModelId(model)} responseModel=${responseModelId} stream=${clientWantsStream}`);

  return { apiKey, openAiOAuth, params, clientWantsStream, responseModelId, onUsage };
}

function createSdkUsageObserver(context: NativeRequestContext) {
  const { options, requestId, model } = context;
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

  return onUsage;
}

type PreparedSdkRequest = ReturnType<typeof prepareSdkRequest>;

async function executeSdkStream(context: NativeRequestContext, prepared: PreparedSdkRequest, languageModel: LanguageModel): Promise<void> {
  const { res, body, model, requestId, claudeSessionId, clientAbort, requestExecution, tracking } = context;
  const { params, responseModelId, onUsage } = prepared;
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
}

async function executeSdkGenerate(context: NativeRequestContext, prepared: PreparedSdkRequest, languageModel: LanguageModel): Promise<void> {
  const { res, model, requestId, claudeSessionId, clientAbort, requestExecution, tracking } = context;
  const { params, responseModelId, openAiOAuth, onUsage } = prepared;

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

function respondSdkFailure(context: NativeRequestContext, err: unknown): void {
  const { res, options, plog, body, model, requestId, clientAbort, requestExecution, tracking } = context;
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
}
