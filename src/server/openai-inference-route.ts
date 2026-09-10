import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LanguageModel } from 'ai';
import { translateOpenAiRequest, generateOpenAiResponse, streamOpenAiResponse, type OpenAiRequest } from '../openai-adapter.js';
import { sendJson } from '../http-utils.js';
import { relayAnthropicMessages } from '../upstream-forward.js';
import { getLatestMessagePreview, writeInferenceResponseErrorLog } from '../trace-log.js';
import type { ServerOptions } from './router.js';
import { formatUpstreamError, sdkUpstreamErrorDetails } from '../upstream-error.js';
import { ProviderRuntimeCache } from '../provider-runtime-cache.js';
import { beginExecutionTracking, reconcileIncomingToolResults, ExecutionRecoveryBlockedError, EXECUTION_ID_HEADER, type ExecutionTrackingHandle } from '../execution-tracking.js';
import { createRequestExecutionContext } from '../request-execution-context.js';
import { resolveExecutionSessionKey } from '../execution-session-key.js';
import { applyExecutionHeaders, auditInference, auditSdkError, executionCapabilities, extractOpenAiToolResults, getOrInitLanguageModel, getResponseModelId, inferenceProvider, lookupModel, openAiEffort, readJson, requestHeader, respondExecutionRecoveryBlocked, toDigestableMessages, type PLog } from './route-helpers.js';
import { supportsDirectOpenAIChatCompletions, upstreamModelId } from './models.js';
import { validateOpenAiChatRoute } from './route-validation.js';
import { createTrackedSseResponse } from './sse-response.js';

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

  if (!Array.isArray(body.messages)) {
    sendJson(res, 400, { error: { message: 'messages must be an array', type: 'invalid_request_error' } });
    return;
  }
  const model = lookupModel(res, options.catalog, body.model);
  if (!model) return;
  const routeValidation = await validateOpenAiChatRoute(model);
  if (routeValidation) {
    sendJson(res, 400, { error: { message: routeValidation } });
    return;
  }

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
      toolResults: extractOpenAiToolResults(body),
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

  try {
    if (supportsDirectOpenAIChatCompletions(model)) {
      const completionsUrl = model.completionsUrl!;
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
        extraHeaders: model.headers,
        responseModelId: getResponseModelId(body.model, model, options),
        onObservedText: text => {
          if (directStream) {
            openAiTracking.observeOpenAiSseText(text);
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            return;
          }
          openAiTracking.observeNonStreamOpenAi(parsed);
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
      if (openAiExecution.finish()) openAiTracking.fail(undefined);
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
    const languageModel = await getOrInitLanguageModel(modelCache, model, npm, baseURL, apiKey);
    const openAiOAuth = npm === '@ai-sdk/openai' && model.authType === 'oauth';
    const params = translateOpenAiRequest(body as unknown as OpenAiRequest, { openAiOAuth });
    const clientWantsStream = Boolean(body.stream);
    const responseModelId = getResponseModelId(body.model, model, options);

    plog(() => `sdk-openai npm=${npm} upstream=${upstreamModelId(model)} responseModel=${responseModelId} stream=${clientWantsStream}`);

    try {
      if (clientWantsStream) {
        const sse = createTrackedSseResponse({
          res,
          clientAbortSignal: openAiClientAbort.signal,
          applyHeaders: () => applyExecutionHeaders(res, openAiTracking),
          observeChunk: openAiTracking.observeOpenAiSseText,
        });
        sse.start();
        try {
          await streamOpenAiResponse(languageModel, params, responseModelId, sse.writeChunk, {
            abortSignal: openAiClientAbort.signal,
            lifecycle: openAiExecution,
          });
          openAiExecution.markStreamActivity();
          openAiExecution.complete();
          if (!res.headersSent) sse.writeChunk('');
          res.end();
        } finally {
          sse.stop();
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
    }
  } catch (error) {
    openAiExecution.fail(error);
    openAiTracking.fail(undefined);
    throw error;
  } finally {
    req.removeListener('aborted', abortOpenAiClientRequest);
    res.removeListener('close', abortOpenAiClosedResponse);
  }
}
