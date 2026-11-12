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
import { isOpenAiOAuth } from '../provider-factory.js';
import { hasCanonicalOpenAiEndpoint } from '../openai-endpoint-provenance.js';
import { rememberConfiguredPool } from '../account-pool-dispatch.js';
import { extractClaudeSessionId } from '../client-session.js';
import { dispatchOpenAiPool, dispatchOpenAiDirectPool } from './openai-pool.js';
import { recordObservation } from '../account-pool.js';
import { anthropicCapacity, codexCapacity } from '../account-pool-telemetry.js';
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

  const model = await validateOpenAiRoute(res, options, body);
  if (!model) return;

  const openAiRequestId = randomUUID();
  const openAiTracking = startOpenAiTracking(req, res, body, model, openAiRequestId);
  if (!openAiTracking) return;

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
      await relayOpenAiChat({ res, options, body, model, openAiTracking, openAiExecution }, req);
      return;
    }

    await executeOpenAiSdk({ res, options, body, model, openAiTracking, openAiExecution }, req, modelCache, plog, openAiClientAbort);
  } catch (error) {
    openAiExecution.fail(error);
    openAiTracking.fail(undefined);
    throw error;
  } finally {
    req.removeListener('aborted', abortOpenAiClientRequest);
    res.removeListener('close', abortOpenAiClosedResponse);
  }
}

async function validateOpenAiRoute(res: ServerResponse, options: ServerOptions, body: NonNullable<Awaited<ReturnType<typeof readJson>>>) {
  if (!Array.isArray(body.messages)) {
    sendJson(res, 400, { error: { message: 'messages must be an array', type: 'invalid_request_error' } });
    return null;
  }
  const model = lookupModel(res, options.catalog, body.model);
  if (!model) return null;
  const routeValidation = await validateOpenAiChatRoute(model);
  if (routeValidation) {
    sendJson(res, 400, { error: { message: routeValidation } });
    return null;
  }
  return model;
}

interface OpenAiRouteContext {
  res: ServerResponse;
  options: ServerOptions;
  body: NonNullable<Awaited<ReturnType<typeof readJson>>>;
  model: NonNullable<ReturnType<typeof lookupModel>>;
  openAiTracking: ExecutionTrackingHandle;
  openAiExecution: ReturnType<typeof createRequestExecutionContext>;
}

async function relayOpenAiChat({ res, options, body, model, openAiTracking, openAiExecution }: OpenAiRouteContext, req: IncomingMessage): Promise<void> {
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
  const relayOptions = {
    extraHeaders: model.headers,
    authType: model.authType === 'none' ? 'none' as const : undefined,
    responseModelId: getResponseModelId(body.model, model, options),
    onObservedText: (text: string) => {
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
      ? (statusCode: number, errorContent: string) => writeInferenceResponseErrorLog(options.inferenceLogPath!, {
          modelId: body.model,
          provider: inferenceProvider(model),
          route: 'passthrough',
          statusCode,
          errorContent,
        })
      : undefined,
    lifecycle: openAiExecution,
  };
  const kind = configuredOpenAiPool(model, options);
  if (kind) {
    const pool = { providerId: model.providerId!, modelId: upstreamModelId(model), billingType: model.authType === 'oauth' ? 'oauth' as const : 'api' as const };
    await dispatchOpenAiDirectPool({ res, model, kind,
      sessionId: extractClaudeSessionId(body, requestHeader(req, 'x-claude-code-session-id')),
      onExhausted: () => { openAiExecution.fail(new Error('Account pool exhausted')); openAiTracking.fail(undefined); },
      onFailure: (status, errorContent) => {
        openAiExecution.fail(new Error(`Upstream returned HTTP ${status}`));
        openAiTracking.fail(undefined);
        relayOptions.onUpstreamError?.(status, errorContent);
      },
      run: binding => relayAnthropicMessages(res, completionsUrl, forwardBody, binding.apiKey, directStream, {
        ...relayOptions, deferRejection: true, onResponseHeaders: async headers => {
          const now = Date.now();
          const observations = kind === 'codex' ? codexCapacity(headers, binding.account.id, now)
            : kind === 'anthropic' ? anthropicCapacity(headers, binding.account.id, now) : [];
          for (const observation of observations) await recordObservation({ pool, observation, now, generation: binding.generation });
        },
      }),
    });
  } else {
    await relayAnthropicMessages(res, completionsUrl, forwardBody, apiKey, directStream, relayOptions);
  }
  if (openAiExecution.finish()) openAiTracking.fail(undefined);
  return;
}

async function executeOpenAiSdk(
  { res, options, body, model, openAiTracking, openAiExecution }: OpenAiRouteContext,
  req: IncomingMessage, modelCache: ProviderRuntimeCache<LanguageModel>, plog: PLog, openAiClientAbort: AbortController,
): Promise<void> {
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
  const kind = configuredOpenAiPool(model, options);
  if (kind) {
    const params = translateOpenAiRequest(body as unknown as OpenAiRequest, {
      openAiOAuth: kind === 'codex', claudeSessionId: requestHeader(req, 'x-claude-code-session-id'),
      providerId: model.providerId,
    });
    try {
      await dispatchOpenAiPool({ res, model, cache: modelCache, kind,
        sessionId: extractClaudeSessionId(body, requestHeader(req, 'x-claude-code-session-id')),
        onExhausted: () => {
          openAiExecution.fail(new Error('Account pool exhausted'));
          openAiTracking.fail(undefined);
          applyExecutionHeaders(res, openAiTracking);
        },
        run: languageModel => runOpenAiSdkResponse({ res, options, body, model, openAiTracking, openAiExecution },
          languageModel, pooledOpenAiParams(params, body, languageModel, kind), openAiClientAbort, plog, kind === 'codex') });
    } catch (err) {
      if (openAiClientAbort.signal.aborted) return;
      openAiExecution.fail(err);
      openAiTracking.fail(undefined);
      respondOpenAiSdkError({ res, options, body, model, openAiTracking, openAiExecution }, plog, err);
    }
    return;
  }
  const baseURL = model.modelFormat === 'anthropic' ? model.baseUrl : model.apiBaseUrl;
  const languageModel = await getOrInitLanguageModel(modelCache, model, npm, baseURL, apiKey);
  const openAiOAuth = isOpenAiOAuth(npm, model.authType, model.providerId);
  const params = translateOpenAiRequest(body as unknown as OpenAiRequest, {
    openAiOAuth,
    openAiProvider: hasCanonicalOpenAiEndpoint(languageModel),
    claudeSessionId: requestHeader(req, 'x-claude-code-session-id'),
    providerId: model.providerId,
  });
  const clientWantsStream = Boolean(body.stream);
  const responseModelId = getResponseModelId(body.model, model, options);

  plog(() => `sdk-openai npm=${npm} upstream=${upstreamModelId(model)} responseModel=${responseModelId} stream=${clientWantsStream}`);

  try {
    await runOpenAiSdkResponse({ res, options, body, model, openAiTracking, openAiExecution }, languageModel, params,
      openAiClientAbort, plog, openAiOAuth);
  } catch (err) {
    if (openAiClientAbort.signal.aborted) return;
    openAiExecution.fail(err);
    openAiTracking.fail(undefined);
    respondOpenAiSdkError({ res, options, body, model, openAiTracking, openAiExecution }, plog, err);
  }
}

function pooledOpenAiParams(
  params: ReturnType<typeof translateOpenAiRequest>, body: OpenAiRouteContext['body'], model: LanguageModel,
  kind: 'codex' | 'anthropic' | 'provider',
): ReturnType<typeof translateOpenAiRequest> {
  return {
    ...params,
    maxRetries: 0,
    ...(kind !== 'codex' && hasCanonicalOpenAiEndpoint(model) && typeof body.prompt_cache_key === 'string'
      ? { providerOptions: { ...params.providerOptions, openai: { ...params.providerOptions?.openai, promptCacheKey: body.prompt_cache_key } } }
      : {}),
  };
}

function configuredOpenAiPool(model: OpenAiRouteContext['model'], options: ServerOptions): 'codex' | 'anthropic' | 'provider' | undefined {
  if (!model.providerId || (!model.accountTag && !rememberConfiguredPool(options.managedPools ?? new Set(), model.providerId,
    model.authType === 'oauth' ? 'oauth' : 'api'))) return undefined;
  if (isOpenAiOAuth(model.npm, model.authType, model.providerId)) return 'codex';
  if (model.modelFormat === 'anthropic' || model.npm === '@ai-sdk/anthropic') return 'anthropic';
  return 'provider';
}

async function runOpenAiSdkResponse(
  { res, options, body, model, openAiTracking, openAiExecution }: OpenAiRouteContext,
  languageModel: LanguageModel, params: ReturnType<typeof translateOpenAiRequest>, openAiClientAbort: AbortController,
  plog: PLog, openAiOAuth: boolean,
): Promise<void> {
  const responseModelId = getResponseModelId(body.model, model, options);
  if (body.stream) {
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
}

function startOpenAiTracking(req: IncomingMessage, res: ServerResponse, body: OpenAiRouteContext['body'], model: OpenAiRouteContext['model'], openAiRequestId: string): ExecutionTrackingHandle | null {
  const openAiSessionKey = resolveExecutionSessionKey({
    claudeSessionId: typeof body.user === 'string' ? body.user : requestHeader(req, 'x-claude-code-session-id'),
    provider: inferenceProvider(model),
    model: model.id,
  });
  reconcileIncomingToolResults({ sessionKey: openAiSessionKey, toolResults: extractOpenAiToolResults(body) });
  try {
    return beginExecutionTracking({
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
      return null;
    }
    throw error;
  }

}

function respondOpenAiSdkError({ res, options, body, model }: OpenAiRouteContext, plog: PLog, err: unknown): void {
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
