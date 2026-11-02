import type { LanguageModel } from 'ai';
import { randomUUID } from 'node:crypto';
import { dispatchSdkPool } from './account-pool-sdk.js';
import {
  anthropicPromptTooLongMessage,
  estimateAnthropicInputTokens
} from './anthropic-endpoints.js';
import { reportedContextWindow } from './context-window.js';
import { sendJson } from './http-utils.js';
import {
  evictResponsesWebSocketConnectionForRequest,
  withResponsesWebSocketDiagnosticContext
} from './oauth/responses-websocket.js';
import { createLanguageModel, isOpenAiOAuth, maxToolsForNpm } from './provider-factory.js';
import {
  revalidateUpstreamUrl
} from './proxy-request.js';
import {
  anthropicError,
  applyProxyExecutionHeaders,
  createTranslationLifecycle
} from './proxy-response.js';
import { isTransientSdkStreamFailure } from './proxy-retry.js';
import { autoReplayMaxRetries } from './request-lifecycle.js';
import {
  extractClaudeSessionId,
  generateAnthropicResponse,
  translateRequest as sdkTranslateRequest,
  sdkTranslationErrorSignature,
  streamAnthropicResponse,
  type AnthropicRequest
} from './sdk-adapter.js';
import { createSseHeartbeat, DELAY_FIRST_HEARTBEAT } from './sse-heartbeat.js';
import {
  writeInferenceResponseErrorLog,
  writeWebSocketDiagnosticLog,
} from './trace-log.js';
import {
  anthropicErrorType,
  clientFacingAnthropicStatus,
  formatUpstreamError,
  isContextLengthExceededError,
  isTerminalUsageLimitText,
  sdkUpstreamErrorDetails,
  sdkUpstreamResponseHeaders,
  upstreamHttpStatus,
} from './upstream-error.js';


import type { ProxyMessageContext } from './proxy-message-context.js';

type ProxyTranslationLifecycle=ReturnType<typeof createTranslationLifecycle>;

export async function handleProxySdk(state: ProxyMessageContext): Promise<void> {
  const { res, route, providerId, relayRequestId, clientModelId, context }=state;
  const { inferenceLogPath }=context;
  if(route.baseURL&&!await revalidateUpstreamUrl(route.baseURL)) {
    anthropicError(res, 400, 'Custom endpoint URL failed security revalidation.');
    return;
  }
  const openAiOAuth=isOpenAiOAuth(route.npm, route.authType, providerId);
  const translationLifecycle=createTranslationLifecycle(
    inferenceLogPath, relayRequestId, clientModelId,
    route.providerId??route.aliasId.split(':')[1]??'unknown',
  );
  try {
    const prepared=prepareProxySdk(state, openAiOAuth);
    await executeProxySdk(state, prepared, openAiOAuth, translationLifecycle);
  } catch(err) {
    respondProxySdkFailure(state, translationLifecycle, err);
  }
}

function prepareProxySdk(state: ProxyMessageContext, openAiOAuth: boolean) {
  const { req, route, anthropicBody, clientModelId, clientWantsStream, context }=state;
  const { plog }=context;
  const claudeSessionIdHeader=Array.isArray(req.headers['x-claude-code-session-id'])
    ? req.headers['x-claude-code-session-id'][0]
    :req.headers['x-claude-code-session-id'];
  const claudeSessionId=extractClaudeSessionId(anthropicBody, claudeSessionIdHeader);

  const sdkRequestBody: AnthropicRequest={ ...anthropicBody, model: clientModelId, messages: anthropicBody.messages??[] };
  const params=sdkTranslateRequest(sdkRequestBody, route.npm!, {
    defaultEffort: route.defaultReasoningEffort,
    openAiOAuth,
    claudeSessionId,
    maxTools: maxToolsForNpm(route.npm),
    reasoningMetadata: {
      providerId: route.providerId,
      apiBaseUrl: route.baseURL,
      supportedParameters: route.supportedParameters,
      reasoning: route.reasoning,
      supportsTemperature: route.supportsTemperature,
      supportedReasoningEfforts: route.supportedReasoningEfforts,
      defaultReasoningEffort: route.defaultReasoningEffort,
      supportsReasoningSummaries: route.supportsReasoningSummaries,
      supportsReasoningSummaryParameter: route.supportsReasoningSummaryParameter,
      supportsParallelToolCalls: route.supportsParallelToolCalls,
      supportsReasoningToggle: route.supportsReasoningToggle,
      supportsPromptCacheBreakpoints: route.supportsPromptCacheBreakpoints,
      useResponsesLite: route.useResponsesLite,
      interleavedReasoningField: route.interleavedReasoningField,
      upstreamModelId: route.realModelId,
    },
  });
  plog(() =>
    `sdk: npm=${route.npm} model=${route.realModelId}, stream=${clientWantsStream}, `+
    `tools=${anthropicBody.tools?.length??0}, msgs=${params.messages.length}`,
  );
  return { claudeSessionId, params };
}

type PreparedProxySdk=ReturnType<typeof prepareProxySdk>;

async function executeProxySdk(state: ProxyMessageContext, prepared: PreparedProxySdk, openAiOAuth: boolean, translationLifecycle: ProxyTranslationLifecycle): Promise<void> {
  const { res, route, anthropicBody, clientModelId, clientWantsStream, clientAbort, requestExecution,
    tracking, providerId, credentialRouteKey, credential, pooledSdk, context }=state;
  const { providerRuntimeCache, plog, webSocketDiagnosticsLogPath }=context;
  const { claudeSessionId, params }=prepared;
  if(pooledSdk) {
    await dispatchSdkPool({
      res, route, params, cache: providerRuntimeCache, sessionId: claudeSessionId,
      clientModelId, stream: clientWantsStream, signal: clientAbort.signal, lifecycle: requestExecution, tracking,
      contextWindow: reportedContextWindow(route.contextWindow, route.contextWindowUnconfirmed),
      initialInputTokens: estimateAnthropicInputTokens(anthropicBody),
      onDispatch: () => translationLifecycle?.dispatched(), onPart: part => translationLifecycle?.onPart(part),
      onOutput: chunk => translationLifecycle?.onOutput(chunk), onComplete: () => translationLifecycle?.complete(),
      onExhausted: () => translationLifecycle?.fail('PoolExhausted'),
    });
    return;
  }
  const model=await providerRuntimeCache.getHandle(
    credentialRouteKey,
    credential!,
    handleCredential => createLanguageModel({
      npm: route.npm!,
      modelId: route.realModelId,
      apiKey: handleCredential.credential,
      baseURL: route.baseURL,
      providerId: providerId==='github-copilot'? providerId:route.providerId??route.aliasId,
      authType: route.authType,
      oauthAccountId: route.oauthAccountId,
      providerData: route.providerData,
      headers: route.headers,
      useResponsesLite: route.useResponsesLite,
      preferWebSockets: route.preferWebSockets,
      minimalClientVersion: route.minimalClientVersion,
      onDebug: (msg: string) => plog(() => msg),
      onWebSocketDiagnostic: webSocketDiagnosticsLogPath
        ? event => writeWebSocketDiagnosticLog(webSocketDiagnosticsLogPath, event)
        :undefined,
    }),
  );
  translationLifecycle?.dispatched();
  if(clientWantsStream) {
    await streamProxySdk(state, prepared, model, translationLifecycle);
  } else {
    await generateProxySdk(state, prepared, model, openAiOAuth, translationLifecycle);
  }
}

async function streamProxySdk(state: ProxyMessageContext, prepared: PreparedProxySdk, model: LanguageModel, translationLifecycle: ProxyTranslationLifecycle): Promise<void> {
  const { res, clientAbort, requestExecution, tracking }=state;
  const writeStreamChunk=(chunk: string) => {
    requestExecution.markOutputEmitted();
    translationLifecycle?.onOutput(chunk);
    tracking.observeAnthropicSseText(chunk);
    if(!res.headersSent) {
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
  const heartbeat=createSseHeartbeat(() => {
    if(!res.headersSent) {
      applyProxyExecutionHeaders(res, tracking);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
    }
    res.write('event: ping\ndata: {"type":"ping"}\n\n');
  }, () => !res.writableEnded&&!res.destroyed, DELAY_FIRST_HEARTBEAT);
  const clearHeartbeat=() => heartbeat.clear();
  clientAbort.signal.addEventListener('abort', clearHeartbeat, { once: true });
  heartbeat.arm();
  try {
    await streamProxySdkWithReplay(state, prepared, model, translationLifecycle, writeStreamChunk);
    translationLifecycle?.complete();
    requestExecution.markStreamActivity();
    requestExecution.complete();
    if(!res.headersSent) writeStreamChunk('');
    res.end();
  } finally {
    heartbeat.clear();
    clientAbort.signal.removeEventListener('abort', clearHeartbeat);
  }
}

async function streamProxySdkWithReplay(state: ProxyMessageContext, prepared: PreparedProxySdk, model: LanguageModel, translationLifecycle: ProxyTranslationLifecycle, writeStreamChunk: (chunk: string) => void): Promise<void> {
  const { route, anthropicBody, clientModelId, trackedRequestId, clientAbort, requestExecution, tracking, context }=state;
  const { plog }=context;
  const { claudeSessionId, params }=prepared;
  const maxRetries=autoReplayMaxRetries();
  let retryCount=0;
  while(true) {
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
            contextWindow: reportedContextWindow(route.contextWindow, route.contextWindowUnconfirmed),
            initialInputTokens: estimateAnthropicInputTokens(anthropicBody),
            abortSignal: clientAbort.signal,
            clientAbortSignal: clientAbort.signal,
            lifecycle: requestExecution,
          },
        ),
      );
      break;
    } catch(error) {
      if(retryCount>=maxRetries
        ||!requestExecution.canReplay()
        ||!isTransientSdkStreamFailure(error)) {
        throw error;
      }
      retryCount+=1;
      const reason=sdkTranslationErrorSignature(error);
      if(reason==='reasoning_part_not_found') {
        evictResponsesWebSocketConnectionForRequest(trackedRequestId);
      }
      requestExecution.recordRetryAttempt({ attempt: retryCount, reason });
      tracking.recordRetryAttempt();
      plog(() => `sdk auto-replay: retry=${retryCount}/${maxRetries} reason=${reason}`);
    }
  }
}

async function generateProxySdk(state: ProxyMessageContext, prepared: PreparedProxySdk, model: LanguageModel, openAiOAuth: boolean, translationLifecycle: ProxyTranslationLifecycle): Promise<void> {
  const { res, route, clientModelId, trackedRequestId, clientAbort, requestExecution, tracking, context }=state;
  const { plog }=context;
  const { claudeSessionId, params }=prepared;

  const anthropicResponse=await withResponsesWebSocketDiagnosticContext(
    { requestId: trackedRequestId, claudeSessionId },
    () => generateAnthropicResponse(
      model,
      params,
      clientModelId,
      {
        forceStream: openAiOAuth,
        contextWindow: reportedContextWindow(route.contextWindow, route.contextWindowUnconfirmed),
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

function respondProxySdkFailure(state: ProxyMessageContext, translationLifecycle: ProxyTranslationLifecycle, err: unknown): void {
  const { res, route, anthropicBody, clientModelId, relayRequestId, trackedRequestId, clientAbort, requestExecution, tracking, context }=state;
  const { plog, inferenceLogPath }=context;
  if(clientAbort.signal.aborted) {
    translationLifecycle?.cancel();
    return;
  }
  requestExecution.fail(err);
  tracking.fail(undefined);
  const sdkErrorSignature=sdkTranslationErrorSignature(err);
  if(sdkErrorSignature==='reasoning_part_not_found') {
    evictResponsesWebSocketConnectionForRequest(trackedRequestId);
  }
  translationLifecycle?.fail(
    err instanceof Error? err.name:'UpstreamError',
    sdkErrorSignature,
  );
  const message=formatUpstreamError(err);
  const details=sdkUpstreamErrorDetails(err);
  const upstreamStatus=details?.statusCode??upstreamHttpStatus(err, message);
  const clientStatus=clientFacingAnthropicStatus(
    upstreamStatus,
    message,
    details?.errorContent,
  );
  const terminalUsageLimit=clientStatus!==upstreamStatus
    &&isTerminalUsageLimitText(message, details?.errorContent);
  const contextLengthExceeded=upstreamStatus===400
    &&isContextLengthExceededError(err, message);
  const reportedWindow=reportedContextWindow(route.contextWindow, route.contextWindowUnconfirmed);
  const clientMessage=contextLengthExceeded&&reportedWindow!==undefined
    ? anthropicPromptTooLongMessage(
      anthropicBody,
      reportedWindow,
    )
    :message;
  plog(() => `sdk error: ${message}${details?.errorContent? ` - body: ${details.errorContent}`:''}`);
  if(inferenceLogPath&&upstreamStatus>=400) {
    writeInferenceResponseErrorLog(inferenceLogPath, {
      ...(relayRequestId? { requestId: relayRequestId }:{}),
      modelId: clientModelId,
      provider: route.providerId??route.aliasId.split(':')[1]??'unknown',
      route: 'translated',
      statusCode: upstreamStatus,
      errorContent: details?.errorContent??message,
      isRetryable: terminalUsageLimit? false:details?.isRetryable,
      attemptCount: details?.attemptCount,
      completion: details?.completion,
    });
  }
  if(!res.headersSent) {
    if(!terminalUsageLimit) {
      for(const [name, value] of Object.entries(sdkUpstreamResponseHeaders(details))) {
        res.setHeader(name, value);
      }
    }
    anthropicError(
      res,
      clientStatus===500? 502:clientStatus,
      clientMessage,
      contextLengthExceeded? (relayRequestId??randomUUID()):undefined,
    );
  } else {
    const errorType=anthropicErrorType(clientStatus);
    res.write(`event: error\ndata: ${JSON.stringify({
      type: 'error',
      error: {
        type: errorType,
        message: clientMessage,
        status_code: clientStatus,
        ...(!terminalUsageLimit&&details?.retryAfterMs!==undefined
          ? { retry_after: Math.ceil(details.retryAfterMs/1_000) }
          :{}),
      },
      ...(contextLengthExceeded? { request_id: relayRequestId??randomUUID() }:{}),
    })}\n\n`);
    res.end();
  }
}
