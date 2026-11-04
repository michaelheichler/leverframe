import type { ServerResponse } from 'node:http';
import { classifyPoolFailure, dispatchWithPool, poolExhaustionMessage, poolExhaustionStatus } from './account-pool-dispatch.js';
import { anthropicError } from './proxy-response.js';
import { relayAnthropicMessages } from './upstream-forward.js';
import type { RequestExecutionObserver } from './request-execution-context.js';
import { recordObservation } from './account-pool.js';
import { anthropicCapacity } from './account-pool-telemetry.js';
import type { ResponseUsage } from './http-proxy/response-usage.js';
import { routingGuardedFetch } from './routing-before-send.js';
import type { RequestExecutionSnapshot } from './request-execution-context.js';
import { routingNativeFailure, RoutingNativeRejected, type RoutingNativeRejection } from './routing-native-outcome.js';
import { routingSdkPoolUnavailable, routingSdkPrecommit, RoutingSdkRejected } from './routing-sdk-outcome.js';

function reportNativeFailure(options: {
  res: ServerResponse; signal: AbortSignal; lifecycle: RequestExecutionObserver; onFailure?: () => void;
}, error: unknown): void {
  if (options.signal.aborted) return;
  options.lifecycle.fail(error);
  options.onFailure?.();
  anthropicError(options.res, 502, error instanceof Error ? error.message : String(error));
}

export async function dispatchNativePool(options: {
  res: ServerResponse;
  providerId: string;
  modelId: string;
  sessionId?: string;
  accountId?: string;
  eligibleAccount?: Parameters<typeof dispatchWithPool>[0]['eligibleAccount'];
  selectorAttemptFetch?: typeof fetch;
  deferRoutingFailure?: boolean;
  routingSnapshot?: () => RequestExecutionSnapshot;
  authType?: 'api' | 'none';
  targetUrl: string;
  body: Record<string, unknown>;
  stream: boolean;
  inboundBeta?: string;
  inboundVersion?: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  lifecycle: RequestExecutionObserver;
  responseModelId?: string;
  onObservedText?: (text: string) => void;
  onUsage?: (usage: ResponseUsage, upstreamMs: number, accountId: string) => void;
  onFailure?: () => void;
  onUpstreamError?: (statusCode: number, body: string) => void;
}): Promise<void> {
  let lastRejection: RoutingNativeRejection | undefined;
  const result = await dispatchWithPool({
    pool: { providerId: options.providerId, modelId: options.modelId, billingType: 'api' },
    sessionId: options.sessionId,
    accountId: options.accountId,
    eligibleAccount: options.eligibleAccount,
    maxDispatches: options.selectorAttemptFetch ? 1 : undefined,
    skipMissingCredentials: options.deferRoutingFailure === true,
    dispatch: async binding => {
      const rejection = await relayAnthropicMessages(options.res, options.targetUrl, options.body, binding.apiKey, options.stream, {
        fetch: options.deferRoutingFailure ? routingGuardedFetch(options.selectorAttemptFetch ?? fetch) : options.selectorAttemptFetch,
        inboundBeta: options.inboundBeta, inboundVersion: options.inboundVersion, authType: options.authType ?? 'api', extraHeaders: options.headers, signal: options.signal,
        lifecycle: options.lifecycle, responseModelId: options.responseModelId, deferRejection: true,
        onObservedText: options.onObservedText,
        onUsage: options.onUsage ? (usage, upstreamMs) => options.onUsage?.(usage, upstreamMs, binding.account.id) : undefined,
        onResponseHeaders: async headers => {
          const now = Date.now();
          for (const observation of anthropicCapacity(headers, binding.account.id, now)) {
            await recordObservation({
              pool: { providerId: options.providerId, modelId: options.modelId, billingType: 'api' }, observation, now,
              generation: binding.generation,
            });
          }
        },
      });
      if (!rejection) return { kind: 'success' as const, value: undefined };
      lastRejection = rejection;
      const observation = classifyPoolFailure({ provider: 'anthropic', accountId: binding.account.id,
        statusCode: rejection.status, body: rejection.body, headers: rejection.headers, now: Date.now() });
      return { kind: 'failure' as const, value: rejection, observation };
    },
  }).catch(error => {
    reportNativeFailure(options, error);
    return undefined;
  });
  if (!result) return;
  if (options.deferRoutingFailure && options.routingSnapshot) {
    const rejection = result.kind === 'exhausted' ? lastRejection : result.value;
    if (rejection) {
      const failure = routingNativeFailure(rejection, options.res, options.routingSnapshot(), options.lifecycle.abortSignal, options.providerId);
      if (failure) throw new RoutingNativeRejected(failure);
    } else if (result.kind === 'exhausted' && result.attempted.length === 0
      && result.accounts.length === 0 && result.missingCredentialAccounts?.length
      && routingSdkPrecommit(options.res, options.routingSnapshot(), options.lifecycle.abortSignal)) {
      throw new RoutingSdkRejected({ reason: 'credential_missing', acceptance: 'not_sent', response: 'clear', output: 'none', tool: 'none' });
    } else if (result.kind === 'exhausted' && result.attempted.length === 0 && !result.missingCredentialAccounts?.length) {
      const failure = routingSdkPoolUnavailable(result.accounts, options.res, options.routingSnapshot(), options.lifecycle.abortSignal);
      if (failure) throw new RoutingSdkRejected(failure);
    }
  }
  if (result.kind === 'exhausted') {
    options.lifecycle.fail(new Error('Account pool exhausted'));
    options.onFailure?.();
    const message = poolExhaustionMessage(result);
    const status = poolExhaustionStatus(result);
    options.onUpstreamError?.(status, message);
    anthropicError(options.res, status, message);
  } else if (result.value) {
    options.lifecycle.fail(new Error(`Upstream returned HTTP ${result.value.status}`));
    options.onFailure?.();
    options.onUpstreamError?.(result.value.status, result.value.body);
    options.res.writeHead(result.value.status, { 'Content-Type': result.value.headers.get('content-type') ?? 'application/json' });
    options.res.end(result.value.body);
  }
}
