import type { ServerResponse } from 'node:http';
import { classifyPoolFailure } from './account-pool-dispatch.js';
import type { RoutingAttemptFailure } from './routing-fallback-contract.js';
import type { RequestExecutionSnapshot } from './request-execution-context.js';
import { sdkUpstreamErrorDetails } from './upstream-error.js';

export class RoutingSdkRejected extends Error {
  constructor(readonly failure: RoutingAttemptFailure) {
    super('The routing provider rejected the request before output.');
    this.name = 'RoutingSdkRejected';
  }
}

export function routingSdkPrecommit(response: ServerResponse, snapshot: RequestExecutionSnapshot, signal: AbortSignal): boolean {
  return !signal.aborted && !response.headersSent && !response.destroyed && !response.writableEnded
    && !snapshot.outputEmitted && !snapshot.toolCallEmitted;
}

export function routingSdkPoolUnavailable(accounts: Array<{ status: string; reason?: 'billing' }>,
  response: ServerResponse, snapshot: RequestExecutionSnapshot, signal: AbortSignal): RoutingAttemptFailure | undefined {
  if (!routingSdkPrecommit(response, snapshot, signal) || accounts.length === 0) return undefined;
  const reason = accounts.every(account => account.status === 'auth_failure') ? 'credential_rejected'
    : accounts.every(account => account.status === 'exhausted' && account.reason === 'billing') ? 'credit_exhausted'
    : accounts.every(account => (account.status === 'exhausted' || account.status === 'rate_limited') && !account.reason)
      ? 'quota_exhausted' : undefined;
  return reason ? { reason, acceptance: 'not_sent', response: 'clear', output: 'none', tool: 'none' } : undefined;
}

export function routingSdkFailure(error: unknown, response: ServerResponse, snapshot: RequestExecutionSnapshot,
  signal: AbortSignal, providerId: string): RoutingAttemptFailure | undefined {
  if (!routingSdkPrecommit(response, snapshot, signal)) return undefined;
  const details = sdkUpstreamErrorDetails(error);
  if (!details || !Number.isInteger(details.statusCode)) return undefined;
  const observation = classifyPoolFailure({ provider: providerId, accountId: 'routing-attempt',
    statusCode: details.statusCode, body: details.data ?? details.errorContent,
    headers: details.responseHeaders, now: Date.now() });
  const reason = observation?.status === 'auth_failure' ? 'credential_rejected'
    : observation?.source.endsWith(':billing') ? 'credit_exhausted'
    : observation?.status === 'rate_limited' || observation?.status === 'exhausted' ? 'quota_exhausted' : undefined;
  return reason ? { reason, acceptance: 'rejected', response: 'clear', output: 'none', tool: 'none' } : undefined;
}
