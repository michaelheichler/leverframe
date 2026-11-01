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


import type { ProxyMessageContext } from './proxy-message-context.js';

export async function handleProxyNative(state: ProxyMessageContext): Promise<void> {
  const { req, res, route, anthropicBody, originalModel, clientModelId, clientWantsStream,
    clientAbort, requestExecution, tracking, apiKey,
    upstreamUrl, credentialRouteKey, pooledNative, context, trackedRequestId, providerId }=state;
  const { providerRuntimeCache, plog, inferenceLogPath }=context;
  if(!await revalidateUpstreamUrl(upstreamUrl)) {
    anthropicError(res, 400, 'Custom endpoint URL failed security revalidation.');
    return;
  }
  const betaHeaderRaw=req.headers['anthropic-beta'];
  const inboundBeta=Array.isArray(betaHeaderRaw)? betaHeaderRaw.join(','):betaHeaderRaw;
  const forwardBody={ ...anthropicBody, model: route.realModelId };
  const targetUrl=`${upstreamUrl}/v1/messages`;
  const isOAuth=route.authType==='oauth';

  if(pooledNative) {
    await executePooledProxyNative(state, targetUrl, forwardBody, inboundBeta);
    return;
  }

  const { effectiveBeta, claudeCodeSessionId }=prepareProxyNativeIdentity(state, forwardBody, inboundBeta, isOAuth);

  try {
    applyProxyExecutionHeaders(res, tracking);
    await relayAnthropicMessages(res, targetUrl, forwardBody, apiKey, clientWantsStream, {
      inboundBeta: effectiveBeta,
      onUsage: nativeUsageLogger(inferenceLogPath, trackedRequestId, clientModelId, providerId),
      inboundVersion: Array.isArray(req.headers['anthropic-version']) ? req.headers['anthropic-version'][0] : req.headers['anthropic-version'],
      authType: isOAuth? 'oauth':'api',
      log: message => plog(message),
      claudeCodeSessionId,
      extraHeaders: route.headers,
      refreshToken: route.refreshToken,
      onTokenRefreshed: async refreshed => {
        await providerRuntimeCache.adopt(credentialRouteKey, apiKey, refreshed);
      },
      signal: clientAbort.signal,
      responseModelId: originalModel,
      onObservedText: text => {
        if(clientWantsStream) {
          tracking.observeAnthropicSseText(text);
          return;
        }
        let parsed: unknown;
        try {
          parsed=JSON.parse(text);
        } catch {
          return;
        }
        tracking.observeNonStreamAnthropic(parsed);
      },
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
  } catch(err) {
    if(clientAbort.signal.aborted) return;
    requestExecution.fail(err);
    const message=err instanceof UpstreamUnreachableError? err.message:String(err);
    plog(() => `anthropic-passthrough error: ${message}`);
    anthropicError(res, 502, message);
  }
  return;

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
  const { req, res, route, originalModel, clientModelId, clientWantsStream, claudeSessionId, trackedRequestId,
    clientAbort, requestExecution, tracking, providerId, context }=state;
  const { inferenceLogPath }=context;
  applyProxyExecutionHeaders(res, tracking);
  await dispatchNativePool({
    res, providerId, modelId: route.realModelId, sessionId: claudeSessionId, targetUrl,
    body: forwardBody, stream: clientWantsStream, inboundBeta, headers: route.headers,
    inboundVersion: Array.isArray(req.headers['anthropic-version']) ? req.headers['anthropic-version'][0] : req.headers['anthropic-version'],
    onUsage: nativeUsageLogger(inferenceLogPath, trackedRequestId, clientModelId, providerId),
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
