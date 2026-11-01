import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LanguageModel } from 'ai';
import { relayAnthropicMessages } from '../upstream-forward.js';
import { resolveProviderCredential } from '../env.js';
import { oauthAuthRef } from '../registry/import-build.js';
import { injectClaudeCodeBillingSystemLine, injectClaudeIdentity, selectBetaFlags } from '../oauth/claude-identity.js';
import { getLatestMessagePreview, writeInferenceResponseErrorLog } from '../trace-log.js';
import { anthropicEffortFromRequest, type AnthropicRequest } from '../sdk-adapter.js';
import type { ProviderRuntimeCache } from '../provider-runtime-cache.js';
import type { ExecutionTrackingHandle } from '../execution-tracking.js';
import type { createRequestExecutionContext } from '../request-execution-context.js';
import { rememberConfiguredPool } from '../account-pool-dispatch.js';
import { dispatchNativePool } from '../account-pool-native.js';
import type { ServerOptions } from './router.js';
import { applyExecutionHeaders, auditInference, attachAnthropicObserver, getResponseModelId, inferenceProvider, providerRuntimeRouteKey, requestHeader } from './route-helpers.js';
import type { lookupModel, readJson, PLog } from './route-helpers.js';
import { upstreamModelId } from './models.js';
import { nativeUsageLogger } from '../native-usage-log.js';

export type NativeRequestContext = {
  req: IncomingMessage;
  res: ServerResponse;
  options: ServerOptions;
  modelCache: ProviderRuntimeCache<LanguageModel>;
  plog: PLog;
  body: NonNullable<Awaited<ReturnType<typeof readJson>>>;
  model: NonNullable<ReturnType<typeof lookupModel>>;
  requestId: string;
  claudeSessionId: string | undefined;
  clientAbort: AbortController;
  requestExecution: ReturnType<typeof createRequestExecutionContext>;
  tracking: ExecutionTrackingHandle;
};

export async function handleNativeAnthropicMessages(context: NativeRequestContext): Promise<void> {
  const { options, model } = context;
  const messagesUrl = `${model.baseUrl}/v1/messages`;
  if (model.providerId === 'anthropic-api' && model.authType === 'api'
    && rememberConfiguredPool(options.managedPools ?? new Set(), model.providerId, 'api')) {
    const { body, requestId, claudeSessionId } = context;
    auditInference(options, {
      requestId,
      modelId: body.model,
      effort: anthropicEffortFromRequest(body as AnthropicRequest) ?? model.defaultEffort,
      claudeSessionId,
      provider: inferenceProvider(model),
      route: 'passthrough',
      requestPreview: getLatestMessagePreview(body.messages, body.system),
    });
    await executePooledNative(context, messagesUrl);
    return;
  }
  await executeNativeRelay(context, messagesUrl);
}

async function executePooledNative(context: NativeRequestContext, messagesUrl: string): Promise<void> {
  const { req, res, options, body, model, requestId, claudeSessionId, clientAbort, requestExecution, tracking } = context;
  applyExecutionHeaders(res, tracking);
  await dispatchNativePool({
    res, providerId: model.providerId!, modelId: upstreamModelId(model), sessionId: claudeSessionId,
    targetUrl: messagesUrl, body: { ...body, model: upstreamModelId(model) }, stream: Boolean(body.stream),
    inboundBeta: requestHeader(req, 'anthropic-beta'), inboundVersion: requestHeader(req, 'anthropic-version'), headers: model.headers,
    onUsage: nativeUsageLogger(options.inferenceLogPath, requestId, body.model, inferenceProvider(model)),
    signal: clientAbort.signal, lifecycle: requestExecution,
    responseModelId: getResponseModelId(body.model, model, options),
    onObservedText: attachAnthropicObserver(tracking, Boolean(body.stream)),
    onFailure: () => tracking.fail(undefined),
    onUpstreamError: options.inferenceLogPath ? (statusCode, errorContent) => writeInferenceResponseErrorLog(options.inferenceLogPath!, {
      requestId, modelId: body.model, provider: inferenceProvider(model), route: 'passthrough', statusCode, errorContent,
    }) : undefined,
  });
}

async function executeNativeRelay(context: NativeRequestContext, messagesUrl: string): Promise<void> {
  const { req, res, options, modelCache, plog, body, model, requestId, requestExecution, tracking } = context;
  const { credentialRouteKey, apiKey, forwardBody, clientWantsStream, isOAuth, effectiveBeta, claudeCodeSessionId, refreshToken } = prepareNativeRelay(context);

  plog(() => `anthropic-passthrough → ${messagesUrl} oauth=${isOAuth} stream=${clientWantsStream}`);
  applyExecutionHeaders(res, tracking);
  await relayAnthropicMessages(res, messagesUrl, forwardBody, apiKey, clientWantsStream, {
    inboundBeta: effectiveBeta,
    inboundVersion: requestHeader(req, 'anthropic-version'),
    onUsage: nativeUsageLogger(options.inferenceLogPath, requestId, body.model, inferenceProvider(model)),
    authType: isOAuth ? 'oauth' : 'api',
    log: message => plog(message),
    claudeCodeSessionId,
    extraHeaders: model.headers,
    refreshToken,
    lifecycle: requestExecution,
    responseModelId: getResponseModelId(body.model, model, options),
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
}

function prepareNativeRelay(context: NativeRequestContext) {
  const { req, options, modelCache, body, model, requestId, claudeSessionId } = context;
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

  return { credentialRouteKey, apiKey, forwardBody, clientWantsStream, isOAuth, effectiveBeta, claudeCodeSessionId, refreshToken };
}
