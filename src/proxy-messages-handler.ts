import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { rememberConfiguredPool } from './account-pool-dispatch.js';
import {
  anthropicMessagesEndpoint,
  estimateAnthropicInputTokens
} from './anthropic-endpoints.js';
import { resolveExecutionSessionKey } from './execution-session-key.js';
import {
  beginExecutionTracking,
  EXECUTION_ID_HEADER,
  ExecutionRecoveryBlockedError,
  reconcileIncomingToolResults,
  type ExecutionTrackingHandle
} from './execution-tracking.js';
import { extractApiKey, readBody, sendJson } from './http-utils.js';
import { buildProviderCapabilities } from './provider-capabilities.js';
import { isSdkMigratedNpm } from './provider-factory.js';
import { handleProxyNative } from './proxy-native-handler.js';
import {
  lookupRoute,
  parseAnthropicRequest,
  proxyExecutionMessages,
  proxyRuntimeRouteKey,
  proxyToolResults,
  revalidateUpstreamUrl
} from './proxy-request.js';
import {
  anthropicError
} from './proxy-response.js';
import { handleProxySdk } from './proxy-sdk-handler.js';
import { createRequestExecutionContext } from './request-execution-context.js';
import { attachRequestExecutionDisposal, wireClientDisconnectAbort } from './request-pipeline.js';
import {
  extractClaudeSessionId
} from './sdk-adapter.js';
import { relayAnthropicMessages, UpstreamUnreachableError } from './upstream-forward.js';
import { reportedContextWindow } from './context-window.js';
import { applyRequestContextPolicy, formatRequestPolicyOutcome } from './context/request-policy.js';
import { validAnthropicCacheControls } from './anthropic-sdk-cache.js';
import { resolveAccountRoute } from './account-route-auth.js';
import { assertRoutingIdentity, resolveRoutingBinding, routingBindingErrors, withRoutingLease, type RoutingBinding } from './routing-bindings.js';
import { assertRoutingRequest, routingAccountEligibility, routingDirectFailure } from './routing-account-eligibility.js';
import { loadRegistry } from './registry/io.js';
import { routingTransportFingerprint } from './routing-transport-identity.js';
import { applyRoutingEffort } from './routing-effort.js';
import { httpProxyModelId } from './http-proxy/routes.js';
import { recordFirstRoutingRequest } from './routing-request-estimate.js';
import { createSelectorAttemptFetch, SELECTOR_ATTEMPT_HEADER, SELECTOR_SESSION_HEADER,
  SELECTOR_CONSUMER_HEADER, SELECTOR_CONNECTION_HEADER } from './routing-selector-attempt.js';
import { decodeSelectorTrace, SELECTOR_TRACE_HEADER, selectorCostSnapshot, selectorTargetForAlias,
  writeSelectorTrace, type SelectorTrace } from './routing-selector-log.js';
import type { ResponseUsage } from './http-proxy/response-usage.js';


import type { ProxyRequestContext } from './proxy-handler.js';

function rejectedThreadedTranslation(prepared: PreparedProxyMessage, res: ServerResponse): boolean {
  if(prepared.route.modelFormat==='anthropic'||!('thread' in prepared.anthropicBody)) return false;
  // Because a 400 makes Claude Code resend this turn with the full history.
  anthropicError(res, 400, `Leverframe: message threads are not supported for ${prepared.originalModel}; resend without thread.`);
  return true;
}

export async function handleProxyMessages(req: IncomingMessage, res: ServerResponse, context: ProxyRequestContext, messagesEndpoint: NonNullable<ReturnType<typeof anthropicMessagesEndpoint>>): Promise<void> {
  const prepared=await prepareProxyMessage(req, res, context, messagesEndpoint);
  if(!prepared||rejectedThreadedTranslation(prepared, res)) return;
  if(prepared.bindingRequest) {
    try { await withRoutingLease(prepared.bindingRequest, async binding => {
      if (messagesEndpoint === 'messages') {
        await recordFirstRoutingRequest(binding, prepared.anthropicBody as unknown as Record<string, unknown>, context.routing!.catalog);
      }
      await dispatchPreparedMessage(prepared, messagesEndpoint, binding);
    }); }
    catch(error) {
      if (res.headersSent || res.destroyed) { if (!res.writableEnded) res.destroy(); return; }
      const retryable = !!error && typeof error === 'object' && 'retryable' in error && error.retryable === true;
      if (error && typeof error === 'object' && 'code' in error && error.code === routingBindingErrors.leaseAbandoned) {
        sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', code: routingBindingErrors.leaseAbandoned,
          message: error instanceof Error ? error.message : 'Recover the abandoned routing request.' } });
        return;
      }
      anthropicError(res, retryable ? 409 : 500, error instanceof Error ? error.message : 'Routing request failed.');
    }
    return;
  }
  await dispatchPreparedMessage(prepared, messagesEndpoint);
}

async function dispatchPreparedMessage(prepared: PreparedProxyMessage, messagesEndpoint: NonNullable<ReturnType<typeof anthropicMessagesEndpoint>>, binding?: RoutingBinding): Promise<void> {
  const { req, res, context } = prepared;
  if(messagesEndpoint==='count_tokens') {
    await handleProxyTokenCount(prepared);
    return;
  }
  const tracked=trackProxyMessage(prepared);
  if(!tracked) return;
  const { route, originalModel, clientModelId, clientWantsStream, relayRequestId,
    clientAbort, requestExecution, providerId, apiKey, upstreamUrl, credentialRouteKey, credential,
    pooledNative, pooledSdk, usesSdkAdapter }=prepared;
  const { claudeSessionId, trackedRequestId, tracking }=tracked;
  const policyStarted=performance.now();
  const policy=await applyRequestContextPolicy({
    request: prepared.anthropicBody,
    sessionId: claudeSessionId,
    routeIdentity: `${providerId}:${route.realModelId}`,
    contextWindow: reportedContextWindow(route.contextWindow, route.contextWindowUnconfirmed),
    signal: clientAbort.signal,
  });
  context.plog(() => formatRequestPolicyOutcome(policy, performance.now()-policyStarted));
  if(clientAbort.signal.aborted) return;
  const anthropicBody=policy.request;
  if(!apiKey&&!usesSdkAdapter) {
    anthropicError(res, 401, 'Missing API key');
    return;
  }

  requestExecution.startResolving();

  const state={
    req, res, context, route, anthropicBody, originalModel, clientModelId, clientWantsStream, relayRequestId,
    trackedRequestId, claudeSessionId, clientAbort, requestExecution, tracking, providerId, apiKey,
    upstreamUrl, credentialRouteKey, credential, pooledNative, pooledSdk, selectorAttemptFetch: prepared.selectorAttemptFetch,
    selectorUsage: selectorUsageObserver(context, prepared.selectorTrace, originalModel),
    ...(binding ? { routingBound: true as const, eligibleAccount: routingAccountEligibility(binding, context.routing!.catalog, anthropicBody as unknown as Record<string, unknown>) } : {}),
  };
  if(route.modelFormat==='anthropic') {
    await handleProxyNative(state);
    return;
  }
  if(usesSdkAdapter) {
    await handleProxySdk(state);
    return;
  }

  anthropicError(res, 500, `No SDK provider configured for model ${originalModel} (npm=${route.npm??'none'})`);
  return;

}

function selectorNoticeGuard(req: IncomingMessage, context: ProxyRequestContext): (() => void) | undefined {
  const encoded = req.headers[SELECTOR_SESSION_HEADER], consumerId = req.headers[SELECTOR_CONSUMER_HEADER],
    connectionId = req.headers[SELECTOR_CONNECTION_HEADER];
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{1,5462}$/.test(encoded)
    || typeof consumerId !== 'string' || typeof connectionId !== 'string') return undefined;
  const sessionId = Buffer.from(encoded, 'base64url').toString('utf8');
  if (Buffer.from(sessionId, 'utf8').toString('base64url') !== encoded) return undefined;
  const channel = context.routing?.noticeChannel;
  const captured = channel?.capture(sessionId);
  if (!captured || captured.consumerId !== consumerId || captured.connectionId !== connectionId) return undefined;
  return () => {
    const current = channel?.capture(sessionId);
    if (captured.signal.aborted || !current || current.signal !== captured.signal
      || current.consumerId !== consumerId || current.connectionId !== connectionId) {
      throw new Error('Routing selector notice consumer is unavailable.');
    }
  };
}

function prepareSelectorAttempt(req: IncomingMessage, res: ServerResponse, context: ProxyRequestContext): {
  fetch?: typeof fetch; trace?: SelectorTrace;
} | null {
  const marker = req.headers[SELECTOR_ATTEMPT_HEADER];
  if (marker === undefined) {
    if (req.headers[SELECTOR_TRACE_HEADER] !== undefined) { anthropicError(res, 400, 'Invalid selector trace.'); return null; }
    return {};
  }
  if (marker !== '1') { anthropicError(res, 400, 'Invalid selector attempt marker'); return null; }
  const rawTrace = req.headers[SELECTOR_TRACE_HEADER], trace = decodeSelectorTrace(rawTrace);
  if ((rawTrace !== undefined && !trace) || (context.routing?.selectorRequiresNotice && !trace)) {
    anthropicError(res, 400, 'Invalid selector trace.'); return null;
  }
  const guard = context.routing?.selectorRequiresNotice ? selectorNoticeGuard(req, context) : undefined;
  if (context.routing?.selectorRequiresNotice && !guard) {
    anthropicError(res, 400, 'Routing selector notice consumer is unavailable.'); return null;
  }
  return { trace, fetch: createSelectorAttemptFetch(guard,
    trace ? () => writeSelectorTrace(context.inferenceLogPath, trace, 'send') : undefined) };
}

function selectorUsageObserver(context: ProxyRequestContext, trace: SelectorTrace | undefined, alias: unknown): ((usage: ResponseUsage) => void) | undefined {
  if (!trace) return undefined;
  const catalog = context.routing?.catalog;
  const target = catalog && typeof alias === 'string' ? selectorTargetForAlias(catalog, alias) : undefined;
  const snapshot = catalog && target ? selectorCostSnapshot(catalog, target) : undefined;
  return usage => writeSelectorTrace(context.inferenceLogPath, trace, 'usage', { target, snapshot, usage });
}

async function prepareProxyMessage(req: IncomingMessage, res: ServerResponse, context: ProxyRequestContext, messagesEndpoint: NonNullable<ReturnType<typeof anthropicMessagesEndpoint>>) {
  const { proxyToken, byAlias, defaultRoute, plog }=context;
  const inboundKey=extractApiKey(req);
  if(inboundKey!==proxyToken) {
    anthropicError(res, 401, 'Invalid proxy token');
    return;
  }

  const selectorAttempt = prepareSelectorAttempt(req, res, context);
  if (selectorAttempt === null) return;
  const { fetch: selectorAttemptFetch } = selectorAttempt, { controller: clientAbort }=wireClientDisconnectAbort(req, res);

  const raw=await readBody(req);
  const parsedRequest=parseAnthropicRequest(raw);
  if(!parsedRequest.ok) {
    anthropicError(res, parsedRequest.status, parsedRequest.message);
    return;
  }
  const anthropicBody=parsedRequest.body;

  const originalModel=anthropicBody.model;
  const clientWantsStream=Boolean(anthropicBody.stream);
  if (selectorAttemptFetch && (messagesEndpoint !== 'messages' || clientWantsStream)) {
    anthropicError(res, 400, 'Selector attempts require nonstream messages'); return;
  }
  const relayRequestIdRaw=req.headers['x-relay-request-id'];
  const relayRequestId=Array.isArray(relayRequestIdRaw)? relayRequestIdRaw[0]:relayRequestIdRaw;

  const bound = await resolveBoundRoute(req, res, context, anthropicBody);
  if (bound === null) return;
  const bindingRequest = bound?.bindingRequest;
  if (bindingRequest && messagesEndpoint === 'messages') {
    anthropicError(res, 409, 'Bound routing messages require the HTTP routing gateway.');
    return;
  }
  const resolvedRoute=bound?.route ?? (typeof originalModel==='string'? lookupRoute(byAlias, originalModel):undefined);
  if(typeof originalModel==='string'&&!resolvedRoute) {
    anthropicError(res, 404, `Unknown model: ${originalModel}`);
    return;
  }
  let route=resolvedRoute??defaultRoute;
  if(messagesEndpoint==='count_tokens'&&route.accountId) {
    try { route=await resolveAccountRoute(route); }
    catch { anthropicError(res, 401, 'The selected account is unavailable.'); return; }
  }
  if(messagesEndpoint==='messages' && route.modelFormat!=='anthropic' && route.npm==='@ai-sdk/anthropic'
    && isSdkMigratedNpm(route.npm, route.providerId) && !validAnthropicCacheControls(anthropicBody)) {
    anthropicError(res, 400, 'Invalid Anthropic cache_control');
    return;
  }
  const { pooledNative, pooledSdk, credentialRouteKey, credential, apiKey } = await resolveMessageCredential(context, route, messagesEndpoint);
  const upstreamUrl=route.upstreamUrl;
  const providerId=route.providerId??route.aliasId.split(':')[1]??'unknown';

  const clientModelId=originalModel??route.aliasId;

  plog(() =>
    `POST /v1/messages - alias=${originalModel} route=${route.realModelId} format=${route.modelFormat} key=${apiKey? `len:${apiKey.length}`:'MISSING'}`,
  );

  const usesSdkAdapter=providerId==='github-copilot'||isSdkMigratedNpm(route.npm, providerId);

  const requestExecution=createRequestExecutionContext({
    requestId: relayRequestId??randomUUID(),
    provider: providerId,
    model: typeof originalModel==='string'? originalModel:route.aliasId,
    correlationId: relayRequestId,
    signal: clientAbort.signal,
    deadlines: route.requestDeadlines,
  });

  attachRequestExecutionDisposal(res, requestExecution);

  return {
    req, res, context, route, anthropicBody, originalModel, clientModelId, clientWantsStream,
    relayRequestId, clientAbort, requestExecution, providerId, apiKey, upstreamUrl, credentialRouteKey,
    credential, pooledNative, pooledSdk, usesSdkAdapter, bindingRequest, selectorAttemptFetch, selectorTrace: selectorAttempt.trace
  };
}

async function resolveBoundRoute(req: IncomingMessage, res: ServerResponse, context: ProxyRequestContext,
  body: Extract<ReturnType<typeof parseAnthropicRequest>, { ok: true }>['body']) {
  const requested = body.model;
  const internalBinding = req.headers['x-leverframe-routing-binding'];
  const modelId = typeof internalBinding === 'string' ? internalBinding : requested;
  if (!context.routing || typeof modelId !== 'string' || !modelId.startsWith('leverframe:binding:')) return undefined;
  const header = req.headers['x-claude-code-session-id'];
  const sessionId = extractClaudeSessionId(body, Array.isArray(header) ? header[0] : header);
  if (!sessionId) { anthropicError(res, 400, 'Routing binding requires a session identity.'); return null; }
  const bindingRequest = { sessionId, modelId };
  try {
    const binding = await resolveRoutingBinding(bindingRequest);
    assertRoutingIdentity(binding, context.routing.catalog);
    applyRoutingEffort(body as unknown as Record<string, unknown>, binding.decision.effort);
    if (anthropicMessagesEndpoint(req.url) === 'messages') {
      assertRoutingRequest(binding, context.routing.catalog, body as unknown as Record<string, unknown>);
    }
    const route = lookupRoute(context.byAlias, httpProxyModelId(binding.decision.target.providerId, binding.decision.target.modelId));
    if (!route || binding.identity.credentialSource !== 'registry'
      || route.providerId !== binding.decision.target.providerId
      || route.realModelId !== binding.identity.upstreamModelId
      || routingTransportFingerprint({ endpoint: route.baseURL ?? route.upstreamUrl, npm: route.npm,
        format: route.modelFormat, credentialSource: 'registry', providerId: route.providerId, authType: route.authType }) !== binding.identity.transportFingerprint) {
      throw Object.assign(new Error('The bound model route changed. Restore the original route or start a new job.'), { code: routingBindingErrors.identityMismatch });
    }
    const endpoint = anthropicMessagesEndpoint(req.url);
    const { pooledNative, pooledSdk } = classifyMessagePools(context, route, endpoint);
    if (!pooledNative && !pooledSdk) {
      const failure = routingDirectFailure(binding, loadRegistry().providers.find(provider => provider.id === route.providerId),
        route.accountId, endpoint === 'messages' ? body as unknown as Record<string, unknown> : undefined);
      if (failure === 'identity') throw Object.assign(new Error('The bound model route changed. Restore the original route or start a new job.'), { code: routingBindingErrors.identityMismatch });
      if (failure === 'requirements') throw new Error('The bound model cannot satisfy this request. Check its capabilities and context limit.');
    }
    return { bindingRequest, route };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === routingBindingErrors.identityMismatch) {
      sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', code: routingBindingErrors.identityMismatch,
        message: error instanceof Error ? error.message : 'Invalid routing identity.' } });
    } else {
      anthropicError(res, 400, error instanceof Error ? error.message : 'Invalid routing binding.');
    }
    return null;
  }
}

export function classifyMessagePools(context: ProxyRequestContext, route: NonNullable<ReturnType<typeof lookupRoute>>,
  endpoint: ReturnType<typeof anthropicMessagesEndpoint>) {
  const { managedPools } = context;
  const pooledNative = endpoint === 'messages' && !!route.providerId && route.authType !== 'oauth'
    && route.modelFormat === 'anthropic' && (!!route.accountTag || rememberConfiguredPool(managedPools, route.providerId, 'api'));
  const pooledSdk = endpoint === 'messages' && !!route.providerId && route.modelFormat === 'openai'
    && (!!route.accountTag || rememberConfiguredPool(managedPools, route.providerId, route.authType === 'oauth' ? 'oauth' : 'api'));
  return { pooledNative, pooledSdk };
}

export async function resolveMessageCredential(context: ProxyRequestContext, route: NonNullable<ReturnType<typeof lookupRoute>>,
  endpoint: NonNullable<ReturnType<typeof anthropicMessagesEndpoint>>) {
  const { providerRuntimeCache } = context;
  const { pooledNative, pooledSdk } = classifyMessagePools(context, route, endpoint);
  const credentialRouteKey = proxyRuntimeRouteKey(route);
  let credential = pooledNative || pooledSdk ? undefined : providerRuntimeCache.snapshot(credentialRouteKey, route.apiKey);
  if (credential && route.authType !== 'oauth' && credential.credential !== route.apiKey) {
    credential = await providerRuntimeCache.adopt(credentialRouteKey, credential.credential, route.apiKey);
  }
  return { pooledNative, pooledSdk, credentialRouteKey, credential, apiKey: credential?.credential ?? route.apiKey };
}

type PreparedProxyMessage=NonNullable<Awaited<ReturnType<typeof prepareProxyMessage>>>;

async function handleProxyTokenCount(prepared: PreparedProxyMessage): Promise<void> {
  const { req, res, context, route, anthropicBody, originalModel, apiKey, upstreamUrl, credentialRouteKey, clientAbort, requestExecution }=prepared;
  const { plog, providerRuntimeCache }=context;
  if(route.modelFormat!=='anthropic') {
    const inputTokens=estimateAnthropicInputTokens(anthropicBody);
    plog(() => `token-count: local estimate model=${originalModel} input_tokens=${inputTokens}`);
    res.setHeader('x-relay-token-count-source', 'local-estimate');

    requestExecution.markStreamActivity();
    requestExecution.markOutputEmitted();
    requestExecution.complete();
    sendJson(res, 200, { input_tokens: inputTokens });
    return;
  }

  if(!apiKey) {
    anthropicError(res, 401, 'Missing API key');
    return;
  }

  if(!await revalidateUpstreamUrl(upstreamUrl)) {
    anthropicError(res, 400, 'Custom endpoint URL failed security revalidation.');
    return;
  }

  const betaHeaderRaw=req.headers['anthropic-beta'];
  const inboundBeta=Array.isArray(betaHeaderRaw)? betaHeaderRaw.join(','):betaHeaderRaw;
  const forwardBody={ ...anthropicBody, model: route.realModelId };
  const targetUrl=`${upstreamUrl}/v1/messages/count_tokens`;
  const isOAuth=route.authType==='oauth';
  try {
    await relayAnthropicMessages(res, targetUrl, forwardBody, apiKey, false, {
      inboundBeta,
      inboundVersion: Array.isArray(req.headers['anthropic-version']) ? req.headers['anthropic-version'][0] : req.headers['anthropic-version'],
      authType: route.authType === 'none' ? 'none' : isOAuth? 'oauth':'api',
      log: message => plog(message),
      extraHeaders: route.headers,
      refreshToken: route.refreshToken,
      onTokenRefreshed: async refreshed => {
        await providerRuntimeCache.adopt(credentialRouteKey, apiKey, refreshed);
      },
      signal: clientAbort.signal,
      lifecycle: requestExecution,
    });
  } catch(err) {
    if(clientAbort.signal.aborted) return;
    requestExecution.fail(err);
    const message=err instanceof UpstreamUnreachableError? err.message:String(err);
    plog(() => `anthropic token-count error: ${message}`);
    anthropicError(res, 502, message);
  }
  return;
}

export function trackProxyMessage(prepared: Pick<PreparedProxyMessage, 'req' | 'res' | 'route' | 'anthropicBody' | 'originalModel' | 'providerId' | 'relayRequestId'>) {
  const { req, res, route, anthropicBody, originalModel, providerId, relayRequestId }=prepared;
  const sessionHeaderValue=req.headers['x-claude-code-session-id'];
  const sessionHeader=Array.isArray(sessionHeaderValue)? sessionHeaderValue[0]:sessionHeaderValue;
  const claudeSessionId=extractClaudeSessionId(anthropicBody, sessionHeader);
  const executionSessionKey=resolveExecutionSessionKey({
    claudeSessionId,
    provider: providerId,
    model: route.realModelId,
  });
  reconcileIncomingToolResults({ sessionKey: executionSessionKey, toolResults: proxyToolResults(anthropicBody) });
  const executionHeader=req.headers[EXECUTION_ID_HEADER];
  const requestedExecutionId=Array.isArray(executionHeader)? executionHeader[0]:executionHeader;
  const trackedRequestId=relayRequestId??randomUUID();

  const providerCapabilities=buildProviderCapabilities({
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
    tracking=beginExecutionTracking({
      sessionKey: executionSessionKey,
      executionId: requestedExecutionId,
      requestId: trackedRequestId,
      provider: providerId,
      model: typeof originalModel==='string'? originalModel:route.aliasId,
      route: route.modelFormat==='anthropic'? 'passthrough':'translated',
      messages: proxyExecutionMessages(anthropicBody),
      toolResults: proxyToolResults(anthropicBody),
      capabilities: providerCapabilities,
    });
  } catch(error) {
    if(error instanceof ExecutionRecoveryBlockedError) {
      anthropicError(res, error.statusCode, error.message);
      return;
    }
    throw error;
  }

  return { claudeSessionId, trackedRequestId, tracking };
}
