import type { ModelRef } from './model-routing.js';
import type { RoutingBinding } from './routing-bindings.js';
import { safeRoutingEstimate, type RoutingFallbackNotice, type RoutingInformationalNotice, type RoutingNotice } from './routing-fallback-contract.js';

const SELECTOR_REASONS = ['selector_timeout', 'selector_invalid_result', 'selector_call_cap', 'selector_transport_failure',
  'selector_skipped_no_measured_benefit', 'selector_cache_hit', 'selector_selected', 'selector_invalid_signature',
  'selector_metadata_unavailable', 'selector_notice_unavailable'];
const FAILURE_REASONS = ['credential_missing', 'credential_rejected', 'quota_exhausted', 'credit_exhausted'];
const LAUNCH_REASONS = ['pool_lowest_cost', 'pool_workload_unknown', 'router_floor', 'router_fallback', 'category_target',
  'category_billing_preference', 'availability_fallback', ...SELECTOR_REASONS];
export function selectorNoticeReason(value: string): boolean { return SELECTOR_REASONS.includes(value); }
function validText(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4096; }
function validRef(value: unknown): value is ModelRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as ModelRef;
  return Object.keys(ref).every(key => ['providerId', 'modelId'].includes(key))
    && validText(ref.providerId) && !!ref.providerId.trim() && validText(ref.modelId) && !!ref.modelId.trim();
}
function validCommon(notice: RoutingNotice, binding: RoutingBinding, sequence: unknown): boolean {
  return notice.sessionId === binding.sessionId && notice.modelId === binding.modelId
    && Number.isSafeInteger(notice.sequence) && notice.sequence > 0 && typeof sequence === 'number' && notice.sequence <= sequence
    && Number.isSafeInteger(notice.revision) && notice.revision > 0 && notice.revision <= binding.revision
    && notice.role === binding.role && notice.category === binding.category && notice.policy === binding.decision.policy
    && notice.policyVersion === binding.decision.policyVersion && (notice.effort === null || validText(notice.effort))
    && !!safeRoutingEstimate(notice.estimate) && typeof notice.acknowledged === 'boolean';
}
export function validFallbackNotice(notice: RoutingFallbackNotice, binding: RoutingBinding, sequence: unknown): boolean {
  return !!notice && typeof notice === 'object' && !Array.isArray(notice)
    && Object.keys(notice).every(key => ['sessionId', 'sequence', 'modelId', 'revision', 'previous', 'target', 'reason',
      'role', 'category', 'policy', 'policyVersion', 'effort', 'estimate', 'cacheReuse', 'acknowledged'].includes(key))
    && validCommon(notice, binding, sequence) && notice.revision > 0 && validRef(notice.previous) && validRef(notice.target)
    && FAILURE_REASONS.includes(notice.reason) && notice.cacheReuse === 'unknown';
}
export function validRoutingNotice(notice: RoutingNotice, binding: RoutingBinding, sequence: unknown): boolean {
  if (!notice || typeof notice !== 'object' || Array.isArray(notice)) return false;
  if (!('kind' in notice)) return validFallbackNotice(notice, binding, sequence);
  const info = notice as RoutingInformationalNotice;
  if (!Object.keys(info).every(key => ['kind', 'sessionId', 'sequence', 'modelId', 'revision', 'role', 'category', 'policy',
    'policyVersion', 'effort', 'estimate', 'target', 'reason', 'lastAttempted', 'attemptedCount', 'skippedCount', 'acknowledged'].includes(key))
    || !validCommon(info, binding, sequence)) return false;
  if (info.kind === 'launch' || info.kind === 'request_completed') return validRef(info.target)
    && (info.kind === 'launch' ? LAUNCH_REASONS.includes(info.reason) : info.reason === 'request_completed')
    && info.lastAttempted === undefined && info.attemptedCount === undefined && info.skippedCount === undefined;
  if (info.kind === 'selector') return SELECTOR_REASONS.includes(info.reason) && info.target === undefined
    && info.lastAttempted === undefined && info.attemptedCount === undefined && info.skippedCount === undefined;
  return info.kind === 'exhausted' && FAILURE_REASONS.includes(info.reason) && info.target === undefined
    && validRef(info.lastAttempted) && Number.isSafeInteger(info.attemptedCount) && info.attemptedCount! > 0
    && Number.isSafeInteger(info.skippedCount) && info.skippedCount! >= 0;
}
