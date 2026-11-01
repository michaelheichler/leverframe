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


import type { ProxyRequestContext } from './proxy-handler.js';

export async function handleProxyMessages(req: IncomingMessage, res: ServerResponse, context: ProxyRequestContext, messagesEndpoint: NonNullable<ReturnType<typeof anthropicMessagesEndpoint>>): Promise<void> {
  const prepared=await prepareProxyMessage(req, res, context, messagesEndpoint);
  if(!prepared) return;
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
    upstreamUrl, credentialRouteKey, credential, pooledNative, pooledSdk,
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

async function prepareProxyMessage(req: IncomingMessage, res: ServerResponse, context: ProxyRequestContext, messagesEndpoint: NonNullable<ReturnType<typeof anthropicMessagesEndpoint>>) {
  const { proxyToken, byAlias, defaultRoute, managedPools, providerRuntimeCache, plog }=context;
  const inboundKey=extractApiKey(req);
  if(inboundKey!==proxyToken) {
    anthropicError(res, 401, 'Invalid proxy token');
    return;
  }

  const { controller: clientAbort }=wireClientDisconnectAbort(req, res);

  const raw=await readBody(req);
  const parsedRequest=parseAnthropicRequest(raw);
  if(!parsedRequest.ok) {
    anthropicError(res, parsedRequest.status, parsedRequest.message);
    return;
  }
  const anthropicBody=parsedRequest.body;

  const originalModel=anthropicBody.model;
  const clientWantsStream=Boolean(anthropicBody.stream);
  const relayRequestIdRaw=req.headers['x-relay-request-id'];
  const relayRequestId=Array.isArray(relayRequestIdRaw)? relayRequestIdRaw[0]:relayRequestIdRaw;

  const resolvedRoute=typeof originalModel==='string'? lookupRoute(byAlias, originalModel):undefined;
  if(typeof originalModel==='string'&&!resolvedRoute) {
    anthropicError(res, 404, `Unknown model: ${originalModel}`);
    return;
  }
  const route=resolvedRoute??defaultRoute;
  const pooledNative=messagesEndpoint==='messages'&&route.providerId==='anthropic-api'
    &&route.authType==='api'&&route.modelFormat==='anthropic'&&rememberConfiguredPool(managedPools, route.providerId, 'api');
  const pooledSdk=messagesEndpoint==='messages'&&route.providerId==='openai-oauth'
    &&route.authType==='oauth'&&rememberConfiguredPool(managedPools, route.providerId, 'oauth');
  const credentialRouteKey=proxyRuntimeRouteKey(route);
  let credential=pooledNative||pooledSdk? undefined:providerRuntimeCache.snapshot(credentialRouteKey, route.apiKey);
  if(credential&&route.authType!=='oauth'&&credential.credential!==route.apiKey) {
    credential=await providerRuntimeCache.adopt(
      credentialRouteKey,
      credential.credential,
      route.apiKey,
    );
  }
  const apiKey=credential?.credential??route.apiKey;
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
    credential, pooledNative, pooledSdk, usesSdkAdapter
  };
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
      authType: isOAuth? 'oauth':'api',
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

function trackProxyMessage(prepared: PreparedProxyMessage) {
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
