import { writeSecureLogLine } from './trace-log.js';
import type { RoutingBinding } from './routing-bindings.js';
import type { RoutingAttemptFailure } from './routing-fallback-contract.js';
import type { ResponseUsage } from './http-proxy/response-usage.js';
import type { AnthropicUsageTrace } from './sdk-usage.js';
import { createHash } from 'node:crypto';
import { estimateWorkload, type WorkloadEstimate } from './routing-estimate.js';
import type { CostSnapshot } from './model-routing-catalog.js';

type RoutingLogEvent = 'decision' | 'attempt' | 'attempt_rejected' | 'fallback_proposed' | 'fallback_acknowledged'
  | 'request_completed' | 'request_failed' | 'request_cancelled' | 'request_outcome_unknown' | 'notice_write_failed' | 'exhausted' | 'fallback_skipped' | 'usage';
const LOG_IDENTIFIER = /^[a-zA-Z0-9_.:/-]{1,200}$/;
const SKIP_REASONS = ['fallback_transport_unsupported', 'fallback_provenance_missing', 'fallback_unavailable',
  'fallback_effort_incompatible', 'fallback_client_view_incompatible', 'fallback_request_limit_exceeded'];
export function routingSkipReason(value: string): boolean { return SKIP_REASONS.includes(value); }
function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && LOG_IDENTIFIER.test(value) ? value : undefined;
}
function reference(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : undefined;
}
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function correlation(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    ? createHash('sha256').update(value).digest('hex') : undefined;
}
export function routingMeasuredCost(snapshot: CostSnapshot, usage: ResponseUsage): WorkloadEstimate {
  const unknown = (): WorkloadEstimate => ({ kind: 'unknown', snapshot });
  const input = count(usage.inputTokens), output = count(usage.outputTokens), read = count(usage.cacheReadInputTokens),
    write = count(usage.cacheCreationInputTokens), five = count(usage.cacheCreation5mInputTokens), hour = count(usage.cacheCreation1hInputTokens);
  if (input === undefined || output === undefined || read === undefined || write === undefined
    || (usage.cacheCreation5mInputTokens !== undefined && five === undefined)
    || (usage.cacheCreation1hInputTokens !== undefined && hour === undefined)
    || (five !== undefined && five > write) || (hour !== undefined && hour > write)) return unknown();
  const total = input + read + write;
  if (!Number.isSafeInteger(total) || (usage.totalInputTokens !== undefined && count(usage.totalInputTokens) !== total)) return unknown();
  if (five !== undefined && hour !== undefined) {
    if (five + hour !== write) return unknown();
    return estimateWorkload(snapshot, { input, output, cacheRead: read, cacheWrites: [
      { ttlSeconds: 300, tokens: five }, { ttlSeconds: 3600, tokens: hour },
    ] });
  }
  return estimateWorkload(snapshot, { input, output, cacheRead: read, cacheWrite: write });
}
export function writeRoutingInferenceLog(path: string | undefined, event: RoutingLogEvent, requestId: string,
  attempt: number, binding: RoutingBinding, options?: { failure?: RoutingAttemptFailure; usage?: ResponseUsage;
    previous?: { providerId: string; modelId: string }; durationMs?: number;
    skipped?: { target: { providerId: string; modelId: string }; reason: string }; requestEstimate?: WorkloadEstimate }): void {
  if (!path || !identifier(requestId) || !count(attempt)) return;
  const decision = binding.decision;
  const usage = options?.usage;
  const measured = usage ? routingMeasuredCost(binding.decision.estimate.snapshot, usage) : undefined;
  const estimate = decision.estimate;
  const amount = estimate.kind === 'known' && typeof estimate.amount === 'number'
    && Number.isFinite(estimate.amount) && estimate.amount >= 0 ? estimate.amount : undefined;
  const requestEstimate = options?.requestEstimate;
  const requestAmount = requestEstimate?.kind === 'known' && typeof requestEstimate.amount === 'number'
    && Number.isFinite(requestEstimate.amount) && requestEstimate.amount >= 0 ? requestEstimate.amount : undefined;
  writeSecureLogLine(path, JSON.stringify({
    timestamp: new Date().toISOString(), event: `routing_${event}`, requestId, attempt,
    sessionHash: correlation(binding.sessionId), bindingHash: correlation(binding.id), launchHash: correlation(binding.launchId),
    role: binding.role, category: reference(binding.category), revision: count(binding.revision),
    noticeSequence: count(binding.pendingNotice?.sequence), durationMs: count(options?.durationMs),
    provider: reference(decision.target.providerId), model: reference(decision.target.modelId),
    previousProvider: reference(options?.previous?.providerId), previousModel: reference(options?.previous?.modelId),
    skippedProvider: reference(options?.skipped?.target.providerId), skippedModel: reference(options?.skipped?.target.modelId),
    skippedReason: options?.skipped && routingSkipReason(options.skipped.reason) ? options.skipped.reason : undefined,
    effort: reference(decision.effort), policy: decision.policy, policyVersion: decision.policyVersion,
    source: decision.source, reason: identifier(decision.reason),
    failureReason: options?.failure?.reason, acceptance: options?.failure?.acceptance,
    response: options?.failure?.response, output: options?.failure?.output, tool: options?.failure?.tool,
    estimate: { kind: amount === undefined ? 'unknown' : 'known', ...(amount === undefined ? {} : { amount }),
      unit: 'estimated_api_equivalent_usd', basis: 'binding_snapshot', source: reference(estimate.snapshot.source), freshness: estimate.snapshot.freshness },
    ...(requestEstimate ? { requestEstimate: { kind: requestAmount === undefined ? 'unknown' : 'known',
      ...(requestAmount === undefined ? {} : { amount: requestAmount }), unit: 'estimated_api_equivalent_usd',
      basis: 'pre_policy_serialized_bytes' } } : {}),
    actualBilling: 'unknown', subscriptionConsumption: 'unknown',
    ...(usage ? { measuredApiEquivalent: { kind: measured?.kind,
      ...(measured?.kind === 'known' ? { amount: measured.amount } : {}), currency: 'USD', basis: 'provider_usage' },
      usageStage: usage.usageStage, usageIsCumulative: true,
      inputTokens: count(usage.inputTokens), outputTokens: count(usage.outputTokens),
      cacheCreationInputTokens: count(usage.cacheCreationInputTokens), cacheReadInputTokens: count(usage.cacheReadInputTokens),
      cacheCreation5mInputTokens: count(usage.cacheCreation5mInputTokens),
      cacheCreation1hInputTokens: count(usage.cacheCreation1hInputTokens), totalInputTokens: count(usage.totalInputTokens) } : {}),
  }));
}
export function routingSdkUsage(usage: AnthropicUsageTrace): ResponseUsage {
  return { usageStage: 'message_delta', inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens),
    cacheCreationInputTokens: count(usage.cache_creation_input_tokens), cacheReadInputTokens: count(usage.cache_read_input_tokens),
    cacheCreation5mInputTokens: count(usage.cache_creation_5m_input_tokens), cacheCreation1hInputTokens: count(usage.cache_creation_1h_input_tokens) };
}
