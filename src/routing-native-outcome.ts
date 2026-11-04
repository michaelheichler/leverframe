import type { ServerResponse } from 'node:http';
import { classifyPoolFailure } from './account-pool-dispatch.js';
import type { RoutingAttemptFailure } from './routing-fallback-contract.js';
import type { RequestExecutionSnapshot } from './request-execution-context.js';
import { routingSdkPrecommit } from './routing-sdk-outcome.js';
import type { ProxyMessageContext } from './proxy-message-context.js';

export interface RoutingNativeRejection { status: number; body: string; headers: Headers }

export class RoutingNativeRejected extends Error {
  constructor(readonly failure: RoutingAttemptFailure) {
    super('The routing provider rejected the request before output.');
    this.name = 'RoutingNativeRejected';
  }
}

export function routingNativeFailure(rejection: RoutingNativeRejection, response: ServerResponse,
  snapshot: RequestExecutionSnapshot, signal: AbortSignal, providerId: string): RoutingAttemptFailure | undefined {
  if (!routingSdkPrecommit(response, snapshot, signal)) return undefined;
  const observation = classifyPoolFailure({ provider: providerId, accountId: 'routing-attempt',
    statusCode: rejection.status, body: rejection.body, headers: rejection.headers, now: Date.now() });
  const reason = observation?.status === 'auth_failure' ? 'credential_rejected'
    : observation?.source.endsWith(':billing') ? 'credit_exhausted'
    : observation?.status === 'rate_limited' || observation?.status === 'exhausted' ? 'quota_exhausted' : undefined;
  return reason ? { reason, acceptance: 'rejected', response: 'clear', output: 'none', tool: 'none' } : undefined;
}

export function finishRoutingNativeRejection(rejection: RoutingNativeRejection, state: ProxyMessageContext): void {
  if (state.clientAbort.signal.aborted || state.res.destroyed || state.res.writableEnded) return;
  if (state.res.headersSent) { state.res.destroy(); return; }
  const failure = routingNativeFailure(rejection, state.res, state.requestExecution.getSnapshot(), state.requestExecution.abortSignal, state.providerId);
  if (failure) throw new RoutingNativeRejected(failure);
  state.requestExecution.fail(new Error(`Upstream returned HTTP ${rejection.status}`));
  state.res.writeHead(rejection.status, { 'Content-Type': rejection.headers.get('content-type') ?? 'application/json' });
  state.res.end(rejection.body);
}
