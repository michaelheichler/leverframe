import type { IncomingMessage, ServerResponse } from 'node:http';
import { isConfiguredPool } from './account-pool-dispatch.js';
import { applyRequestContextPolicy, formatRequestPolicyOutcome } from './context/request-policy.js';
import { reportedContextWindow } from './context-window.js';
import { httpProxyModelId } from './http-proxy/routes.js';
import type { ModelRef } from './model-routing.js';
import type { ProxyRequestContext } from './proxy-handler.js';
import { classifyMessagePools, resolveMessageCredential, trackProxyMessage } from './proxy-messages-handler.js';
import { lookupRoute, parseAnthropicRequest } from './proxy-request.js';
import { handleProxySdk } from './proxy-sdk-handler.js';
import { handleProxyNative } from './proxy-native-handler.js';
import { isSdkMigratedNpm } from './provider-factory.js';
import { createRequestExecutionContext } from './request-execution-context.js';
import { assertRoutingIdentity, routingBindingErrors, type RoutingBinding } from './routing-bindings.js';
import { assertRoutingRequest, routingAccountEligibility, routingDirectFailure } from './routing-account-eligibility.js';
import { applyRoutingEffort } from './routing-effort.js';
import { RoutingSdkRejected } from './routing-sdk-outcome.js';
import { RoutingNativeRejected } from './routing-native-outcome.js';
import { routingTransportFingerprint } from './routing-transport-identity.js';
import { withRoutingBeforeSend, type RoutingBeforeSend } from './routing-before-send.js';
import { loadRegistry } from './registry/io.js';

export interface RoutingAdapterAttemptInput {
  req: IncomingMessage;
  res: ServerResponse;
  sessionId: string;
  clientModelId: string;
  requestId: string;
  controller: AbortController;
  deadline: number;
  beforeSend: RoutingBeforeSend;
}

export type RoutingAdapterAttempt = { kind: 'terminal'; lifecycleState?: import('./request-lifecycle.js').LifecycleState } | {
  kind: 'rejected'; failure: import('./routing-fallback-contract.js').RoutingAttemptFailure; request: Record<string, unknown>;
};

function assertDirectRoutingEligibility(binding: RoutingBinding, route: NonNullable<ReturnType<typeof lookupRoute>>,
  body: Record<string, unknown>): void {
  const failure = routingDirectFailure(binding, loadRegistry().providers.find(provider => provider.id === route.providerId),
    route.accountId, body);
  if (failure === 'identity') throw Object.assign(new Error('The bound model route changed. Restore the original route or start a new job.'),
    { code: routingBindingErrors.identityMismatch });
  if (failure === 'requirements') throw new Error('The bound model cannot satisfy this request. Check its capabilities and context limit.');
}

export function createRoutingAdapterSession(context: ProxyRequestContext, input: RoutingAdapterAttemptInput, isOpen: () => boolean) {
  let tracked: ReturnType<typeof trackProxyMessage>;
  let policyPrepared = false;
  let canonical: Record<string, unknown> | undefined;
  const routeFor = (target: ModelRef) => lookupRoute(context.byAlias, httpProxyModelId(target.providerId, target.modelId));
  return {
    transportFor(target: ModelRef, request: Record<string, unknown>): 'native-anthropic' | 'openai-compatible' | undefined {
      const route = routeFor(target);
      if (!route) return undefined;
      if (route.modelFormat === 'anthropic') return route.authType !== 'oauth' ? 'native-anthropic' : undefined;
      const billingType = route.authType === 'oauth' ? 'oauth' : 'api';
      return route.npm === '@ai-sdk/openai-compatible' && route.providerId !== 'github-copilot'
        && route.providerId !== 'antigravity' && (request.temperature === undefined || route.supportsTemperature !== false)
        && !!route.providerId && (!!route.accountTag || context.managedPools.has(`${route.providerId}:${billingType}`)
          || isConfiguredPool(route.providerId, billingType))
        ? 'openai-compatible' : undefined;
    },
    async attempt(binding: RoutingBinding, request: Record<string, unknown>,
      routingUsage?: (usage: import('./http-proxy/response-usage.js').ResponseUsage) => void): Promise<RoutingAdapterAttempt> {
      if (!isOpen() || input.controller.signal.aborted || Date.now() >= input.deadline || !context.routing) {
        throw new Error('The routing adapter is unavailable or the request timed out.');
      }
      assertRoutingIdentity(binding, context.routing.catalog);
      const route = routeFor(binding.decision.target);
      if (!route || binding.identity.credentialSource !== 'registry' || route.providerId !== binding.decision.target.providerId
        || route.realModelId !== binding.identity.upstreamModelId
        || routingTransportFingerprint({ endpoint: route.baseURL ?? route.upstreamUrl, npm: route.npm,
          format: route.modelFormat, credentialSource: 'registry', providerId: route.providerId, authType: route.authType }) !== binding.identity.transportFingerprint) {
        throw Object.assign(new Error('The bound model route changed. Restore the original route or start a new job.'),
          { code: routingBindingErrors.identityMismatch });
      }
      const parsed = parseAnthropicRequest(JSON.stringify(request));
      if (!parsed.ok) throw new Error(parsed.message);
      const pools = classifyMessagePools(context, route, 'messages');
      if (!pools.pooledNative && !pools.pooledSdk) {
        const eligibilityBody = structuredClone(parsed.body) as unknown as Record<string, unknown>;
        applyRoutingEffort(eligibilityBody, binding.decision.effort);
        assertDirectRoutingEligibility(binding, route, eligibilityBody);
      }
      if (!policyPrepared) {
        if ((binding.attemptedTargets?.length ?? 0) > 1) {
          canonical = structuredClone(parsed.body) as unknown as Record<string, unknown>;
        } else {
          const policyStarted = performance.now();
          const policy = await applyRequestContextPolicy({ request: parsed.body, sessionId: input.sessionId,
            routeIdentity: `${route.providerId}:${route.realModelId}`,
            contextWindow: reportedContextWindow(route.contextWindow, route.contextWindowUnconfirmed), signal: input.controller.signal });
          context.plog(() => formatRequestPolicyOutcome(policy, performance.now() - policyStarted));
          canonical = structuredClone(policy.request) as unknown as Record<string, unknown>;
        }
        policyPrepared = true;
      }
      const attemptBody = structuredClone(canonical ?? request);
      applyRoutingEffort(attemptBody, binding.decision.effort);
      const bodyResult = parseAnthropicRequest(JSON.stringify(attemptBody));
      if (!bodyResult.ok) throw new Error(bodyResult.message);
      const availableCatalog = { ...context.routing.catalog, models: context.routing.catalog.models.map(model => ({ ...model,
        credential: { ...model.credential, available: true }, capacity: undefined })) };
      assertRoutingRequest(binding, availableCatalog, attemptBody);
      const providerId = route.providerId ?? route.aliasId.split(':')[1] ?? 'unknown';
      if (route.modelFormat === 'openai' && providerId !== 'github-copilot' && !isSdkMigratedNpm(route.npm, providerId)) {
        throw new Error('The bound model has no SDK transport.');
      }
      const { pooledNative, pooledSdk, credentialRouteKey, credential, apiKey } = await resolveMessageCredential(context, route, 'messages');
      if (!pooledNative && !pooledSdk) assertDirectRoutingEligibility(binding, route, attemptBody);
      if (!pooledNative && !pooledSdk && !apiKey && route.authType !== 'none') return { kind: 'rejected', request: attemptBody,
        failure: { reason: 'credential_missing', acceptance: 'not_sent', response: 'clear', output: 'none', tool: 'none' } };
      tracked ??= trackProxyMessage({ req: input.req, res: input.res, route, anthropicBody: bodyResult.body,
        originalModel: input.clientModelId, providerId, relayRequestId: input.requestId });
      if (!tracked) return { kind: 'terminal' };
      if (tracked.claudeSessionId !== input.sessionId) throw new Error('The routing request session changed.');
      const remaining = input.deadline - Date.now();
      if (!isOpen() || input.controller.signal.aborted || remaining <= 0) throw new Error('The routing request was cancelled or timed out.');
      const requestExecution = createRequestExecutionContext({ requestId: input.requestId, provider: providerId,
        model: input.clientModelId, signal: input.controller.signal,
        deadlines: { ...route.requestDeadlines, totalMs: Math.min(remaining, route.requestDeadlines?.totalMs ?? remaining) } });
      requestExecution.startResolving();
      try {
        const beforeSend = { verify: input.beforeSend.verify, check: () => {
          if (!isOpen()) throw new Error('The routing adapter is unavailable.');
          input.beforeSend.check();
        } };
        const state = { req: input.req, res: input.res, context, route, anthropicBody: bodyResult.body,
          originalModel: input.clientModelId, clientModelId: input.clientModelId, clientWantsStream: Boolean(bodyResult.body.stream),
          relayRequestId: input.requestId, trackedRequestId: tracked.trackedRequestId, claudeSessionId: tracked.claudeSessionId,
          clientAbort: input.controller, requestExecution, tracking: tracked.tracking, providerId, apiKey,
          upstreamUrl: route.upstreamUrl, credentialRouteKey, credential, pooledNative, pooledSdk, routingBound: true,
          routingAttempt: true, routingUsage, eligibleAccount: routingAccountEligibility(binding, context.routing.catalog, attemptBody) } as const;
        if (route.modelFormat === 'anthropic') await withRoutingBeforeSend(beforeSend, () => handleProxyNative(state));
        else await withRoutingBeforeSend(beforeSend, () => handleProxySdk(state));
        return { kind: 'terminal', lifecycleState: requestExecution.getSnapshot().state };
      } catch (error) {
        if (!isOpen() || input.controller.signal.aborted || Date.now() >= input.deadline) {
          throw new Error('The routing adapter is unavailable or the request timed out.');
        }
        if (error instanceof RoutingSdkRejected || error instanceof RoutingNativeRejected) {
          return { kind: 'rejected', failure: error.failure, request: attemptBody };
        }
        throw error;
      } finally { requestExecution.dispose(); }
    },
  };
}

export type RoutingAdapterSession = ReturnType<typeof createRoutingAdapterSession>;
