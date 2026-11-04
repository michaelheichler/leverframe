import { dispatchNativePool } from './account-pool-native.js';
import {
  CLAUDE_CODE_CLI_VERSION,
  injectClaudeCodeBillingSystemLine,
  injectClaudeIdentity,
  selectBetaFlags,
} from './oauth/claude-identity.js';
import {
  revalidateUpstreamUrl
} from './proxy-request.js';
import {
  anthropicError,
  applyProxyExecutionHeaders
} from './proxy-response.js';
import {
  writeInferenceResponseErrorLog
} from './trace-log.js';
import { relayAnthropicMessages, UpstreamUnreachableError } from './upstream-forward.js';
import { nativeUsageLogger } from './native-usage-log.js';
import { finishRoutingNativeRejection, RoutingNativeRejected } from './routing-native-outcome.js';
import { routingGuardedFetch } from './routing-before-send.js';


import type { ProxyMessageContext } from './proxy-message-context.js';

function nativeProxyUsageObserver(state: ProxyMessageContext): ReturnType<typeof nativeUsageLogger> {
  const ordinary: ReturnType<typeof nativeUsageLogger> = state.routingUsage
    ? usage => state.routingUsage?.(usage)
    : nativeUsageLogger(state.context.inferenceLogPath, state.trackedRequestId, state.clientModelId, state.providerId);
  if (!state.selectorUsage) return ordinary;
  return (usage, upstreamMs, accountId) => {
    ordinary?.(usage, upstreamMs, accountId);
    state.selectorUsage?.(usage);
  };
}

export async function handleProxyNative(state: ProxyMessageContext): Promise<void> {
  const { req, res, route, anthropicBody, originalModel, clientModelId, clientWantsStream,
    clientAbort, requestExecution, tracking, apiKey,
    upstreamUrl, credentialRouteKey, pooledNative, context }=state;
  const { providerRuntimeCache, plog, inferenceLogPath }=context;
  if(!await revalidateUpstreamUrl(upstreamUrl)) {
    anthropicError(res, 400, 'Custom endpoint URL failed security revalidation.');
    return;
  }
  const betaHeaderRaw=req.headers['anthropic-beta'];
  const inboundBeta=Array.isArray(betaHeaderRaw)? betaHeaderRaw.join(','):betaHeaderRaw;
  const forwardBody={ ...anthropicBody, model: route.realModelId };
  const query = state.routingAttempt ? new URL(req.url ?? '/', 'http://127.0.0.1').search : '';
  const targetUrl=`${upstreamUrl}/v1/messages${query}`;
  const isOAuth=route.authType==='oauth';

  if(pooledNative) {
    await executePooledProxyNative(state, targetUrl, forwardBody, inboundBeta);
    return;
  }

  const { effectiveBeta, claudeCodeSessionId }=prepareProxyNativeIdentity(state, forwardBody, inboundBeta, isOAuth);

  try {
    applyProxyExecutionHeaders(res, tracking);
    const rejection = await relayAnthropicMessages(res, targetUrl, forwardBody, apiKey, clientWantsStream, {
      deferRejection: state.routingAttempt === true,
      inboundBeta: effectiveBeta,
      onUsage: nativeProxyUsageObserver(state),
      inboundVersion: Array.isArray(req.headers['anthropic-version']) ? req.headers['anthropic-version'][0] : req.headers['anthropic-version'],
      authType: route.authType === 'none' ? 'none' : isOAuth? 'oauth':'api',
      log: message => plog(message),
      claudeCodeSessionId,
      extraHeaders: route.headers,
      refreshToken: state.selectorAttemptFetch ? undefined : route.refreshToken,
      fetch: state.routingAttempt ? routingGuardedFetch(state.selectorAttemptFetch ?? fetch) : state.selectorAttemptFetch,
      onTokenRefreshed: async refreshed => {
        await providerRuntimeCache.adopt(credentialRouteKey, apiKey, refreshed);
      },
      signal: clientAbort.signal,
      responseModelId: originalModel,
      onObservedText: text => observeNativeResponseText(state, text),
      onUpstreamError: inferenceLogPath
        ? (statusCode, errorContent) => writeInferenceResponseErrorLog(inferenceLogPath, {
          modelId: clientModelId,
          provider: route.providerId??route.aliasId.split(':')[1]??'unknown',
          route: 'passthrough',
          statusCode,
          errorContent,
        })
        :undefined,
      lifecycle: requestExecution,
    });
    if (rejection) finishRoutingNativeRejection(rejection, state);
  } catch(err) {
    if (err instanceof RoutingNativeRejected) throw err;
    if(clientAbort.signal.aborted) return;
    requestExecution.fail(err);
    const message=err instanceof UpstreamUnreachableError? err.message:String(err);
    plog(() => `anthropic-passthrough error: ${message}`);
    anthropicError(res, 502, message);
  }
  return;

}

function observeNativeResponseText(state: ProxyMessageContext, text: string): void {
  if (state.clientWantsStream) { state.tracking.observeAnthropicSseText(text); return; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return; }
  state.tracking.observeNonStreamAnthropic(parsed);
}

function prepareProxyNativeIdentity(state: ProxyMessageContext, forwardBody: Record<string, unknown>, inboundBeta: string|undefined, isOAuth: boolean) {
  const { route, clientWantsStream, context: { plog } }=state;
  let effectiveBeta=inboundBeta;
  let claudeCodeSessionId: string|undefined;
  if(isOAuth) {
    const seed=route.providerId??route.realModelId;
    const identity=injectClaudeIdentity(forwardBody, route.providerData, seed);
    if(route.providerId==='claude-code') injectClaudeCodeBillingSystemLine(forwardBody);
    claudeCodeSessionId=identity.sessionId;
    effectiveBeta=selectBetaFlags(forwardBody, route.realModelId, inboundBeta);
    plog(() => `anthropic-oauth: model=${route.realModelId}, beta=${effectiveBeta}`);
    plog(() => `anthropic-oauth headers: user-agent=claude-cli/${CLAUDE_CODE_CLI_VERSION} x-app=cli session-header=${claudeCodeSessionId? 'set':'missing'}`);
  } else {
    plog(() => `anthropic-passthrough: model=${route.realModelId}, stream=${clientWantsStream}`);
  }
  return { effectiveBeta, claudeCodeSessionId };
}

async function executePooledProxyNative(state: ProxyMessageContext, targetUrl: string, forwardBody: Record<string, unknown>, inboundBeta: string|undefined): Promise<void> {
  const { req, res, route, originalModel, clientModelId, clientWantsStream, claudeSessionId,
    clientAbort, requestExecution, tracking, providerId, context }=state;
  const { inferenceLogPath }=context;
  applyProxyExecutionHeaders(res, tracking);
  await dispatchNativePool({
    res, providerId, modelId: route.realModelId, sessionId: claudeSessionId, accountId: route.accountId, targetUrl,
    eligibleAccount: state.eligibleAccount,
    selectorAttemptFetch: state.selectorAttemptFetch,
    deferRoutingFailure: state.routingAttempt, routingSnapshot: () => requestExecution.getSnapshot(),
    authType: route.authType === 'none' ? 'none' : 'api',
    body: forwardBody, stream: clientWantsStream, inboundBeta, headers: route.headers,
    inboundVersion: Array.isArray(req.headers['anthropic-version']) ? req.headers['anthropic-version'][0] : req.headers['anthropic-version'],
    onUsage: nativeProxyUsageObserver(state),
    signal: clientAbort.signal, lifecycle: requestExecution, responseModelId: originalModel,
    onObservedText: text => {
      if(clientWantsStream) tracking.observeAnthropicSseText(text);
      else {
        try { tracking.observeNonStreamAnthropic(JSON.parse(text)); } catch { return; }
      }
    },
    onFailure: () => tracking.fail(undefined),
    onUpstreamError: inferenceLogPath? (statusCode, errorContent) => writeInferenceResponseErrorLog(inferenceLogPath, {
      modelId: clientModelId, provider: providerId, route: 'passthrough', statusCode, errorContent,
    }):undefined,
  });
  return;

}
