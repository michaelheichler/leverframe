import { isDeepStrictEqual } from 'node:util';
import type { ModelRef, RoutingConfig, RoutingTarget } from './model-routing.js';
import type { CostSnapshot, RoutingCatalogSnapshot } from './model-routing-catalog.js';
import type { RoutingWorkload, WorkloadEstimate } from './routing-estimate.js';
import { validRate, validateCacheWrites, validateTiers } from './model-routing-price-validation.js';
import { eligible, sameRef, type RoutingDecision, type RoutingRequirements } from './routing-policy.js';
import { routingIdentityErrors, routingPolicyIdentity } from './routing-policy-identity.js';
import type { BindingRequestInput, RoutingBinding } from './routing-bindings.js';

export interface RoutingCandidatePin {
  identity: RoutingBinding['identity'];
  metadata: ReturnType<typeof routingPolicyIdentity>['metadata'];
  capabilities: NonNullable<RoutingRequirements['capabilities']>;
}
export interface RoutingAuthorizedTarget extends RoutingTarget { kind: 'serving' | 'fallback'; pin?: RoutingCandidatePin }
export interface RoutingFallbackAuthorization {
  version: 1;
  targets: RoutingAuthorizedTarget[];
  selectorTargets: ModelRef[];
  subscriptionPreference: NonNullable<RoutingConfig['subscriptionPreference']>;
}
export type RoutingAttemptReason = 'credential_missing' | 'credential_rejected' | 'quota_exhausted' | 'credit_exhausted';
export interface RoutingAttemptFailure {
  reason: RoutingAttemptReason;
  acceptance: 'not_sent' | 'rejected' | 'unknown';
  response: 'clear' | 'committed' | 'unknown';
  output: 'none' | 'emitted' | 'unknown';
  tool: 'none' | 'emitted' | 'unknown';
}
export interface RoutingFallbackNotice {
  sessionId: string;
  sequence: number;
  modelId: string;
  revision: number;
  previous: ModelRef;
  target: ModelRef;
  reason: RoutingAttemptReason;
  role: 'router' | 'specialist';
  category?: string;
  policy: RoutingDecision['policy'];
  policyVersion: RoutingDecision['policyVersion'];
  effort: string | null;
  estimate: RoutingDecision['estimate'];
  cacheReuse: 'unknown';
  acknowledged: boolean;
}
export interface RoutingInformationalNotice {
  kind: 'launch' | 'selector' | 'exhausted' | 'request_completed';
  sessionId: string;
  sequence: number;
  modelId: string;
  revision: number;
  role: 'router' | 'specialist';
  category?: string;
  policy: RoutingDecision['policy'];
  policyVersion: RoutingDecision['policyVersion'];
  effort: string | null;
  estimate: RoutingDecision['estimate'];
  target?: ModelRef;
  reason: string;
  lastAttempted?: ModelRef;
  attemptedCount?: number;
  skippedCount?: number;
  acknowledged: boolean;
}
export type RoutingNotice = RoutingFallbackNotice | RoutingInformationalNotice;
export interface RoutingFallbackInput extends BindingRequestInput {
  leaseId: string;
  revision: number;
  failure: RoutingAttemptFailure;
  catalog: RoutingCatalogSnapshot;
  requirements: { capabilities: NonNullable<RoutingRequirements['capabilities']>; contextTokens: number };
  maxOutputTokens: number;
  workload: RoutingWorkload;
  deadline: number;
  signal: AbortSignal;
  candidateAllowed?: (target: RoutingAuthorizedTarget) => boolean;
}
export function routingReplayAllowed(failure: RoutingAttemptFailure): boolean {
  return !!failure && ['credential_missing', 'credential_rejected', 'quota_exhausted', 'credit_exhausted'].includes(failure.reason)
    && ['not_sent', 'rejected'].includes(failure.acceptance) && failure.response === 'clear'
    && failure.output === 'none' && failure.tool === 'none';
}
function validText(value: string): boolean { return typeof value === 'string' && value.length > 0 && value.length <= 4096; }
export function safeRoutingEstimate(value: unknown): WorkloadEstimate | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const estimate = value as Record<string, unknown>;
  if (Object.keys(estimate).some(key => !['kind', 'amount', 'snapshot'].includes(key))
    || !['known', 'unknown'].includes(String(estimate.kind)) || (estimate.amount !== undefined && !validRate(estimate.amount))
    || (estimate.kind === 'known' && estimate.amount === undefined) || (estimate.kind === 'unknown' && estimate.amount !== undefined)
    || !estimate.snapshot || typeof estimate.snapshot !== 'object' || Array.isArray(estimate.snapshot)) return undefined;
  const raw = estimate.snapshot as Record<string, unknown>;
  const keys = ['kind', 'currency', 'unit', 'input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrites', 'tiers', 'source',
    'observedAt', 'platform', 'requestedPlatform', 'tier', 'usageMultiplier', 'usageMultiplierApplies', 'substituted', 'freshness'];
  if (Object.keys(raw).some(key => !keys.includes(key)) || !['known', 'unknown'].includes(String(raw.kind))
    || raw.currency !== 'USD' || raw.unit !== 'per-million-tokens' || typeof raw.substituted !== 'boolean'
    || !['current', 'stale', 'unknown'].includes(String(raw.freshness))) return undefined;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'usageMultiplier']) {
    if (raw[key] !== undefined && !validRate(raw[key])) return undefined;
  }
  for (const key of ['source', 'observedAt', 'platform', 'requestedPlatform', 'tier']) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || raw[key].length > 256
      || Array.from(raw[key]).some(char => { const code = char.charCodeAt(0); return code < 32 || code === 127; }))) return undefined;
  }
  if (raw.usageMultiplierApplies !== undefined && typeof raw.usageMultiplierApplies !== 'boolean') return undefined;
  const writes = validateCacheWrites(raw.cacheWrites);
  const tiers = validateTiers(raw.tiers);
  const equalJson = (left: unknown, right: unknown) => {
    if (left === undefined || right === undefined) return left === right;
    try { return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right))); }
    catch { return false; }
  };
  if (!writes.valid || !tiers.valid || !equalJson(raw.cacheWrites, writes.value) || !equalJson(raw.tiers, tiers.value)) return undefined;
  const snapshot: CostSnapshot = { kind: raw.kind as CostSnapshot['kind'], currency: 'USD', unit: 'per-million-tokens',
    substituted: raw.substituted, freshness: raw.freshness as CostSnapshot['freshness'] };
  for (const key of keys) if (raw[key] !== undefined && !['cacheWrites', 'tiers'].includes(key)) {
    (snapshot as unknown as Record<string, unknown>)[key] = raw[key];
  }
  if (writes.value !== undefined) snapshot.cacheWrites = writes.value;
  if (tiers.value !== undefined) snapshot.tiers = tiers.value;
  return { kind: estimate.kind as WorkloadEstimate['kind'], ...(estimate.amount === undefined ? {} : { amount: estimate.amount as number }), snapshot };
}
export function validCandidatePin(value: unknown): value is RoutingCandidatePin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pin = value as RoutingCandidatePin;
  if (!pin.identity || !validText(pin.identity.upstreamModelId)
    || !['claude-code', 'registry'].includes(pin.identity.credentialSource)
    || !/^[a-f0-9]{64}$/.test(pin.identity.transportFingerprint) || !pin.metadata || typeof pin.metadata !== 'object') return false;
  const metadata = pin.metadata;
  return (metadata.contextWindow === undefined || (Number.isSafeInteger(metadata.contextWindow) && metadata.contextWindow > 0))
    && (metadata.maxOutputTokens === undefined || (Number.isSafeInteger(metadata.maxOutputTokens) && metadata.maxOutputTokens > 0))
    && (metadata.supportedReasoningEfforts === undefined || (Array.isArray(metadata.supportedReasoningEfforts)
      && metadata.supportedReasoningEfforts.every(validText)))
    && Array.isArray(pin.capabilities) && pin.capabilities.every(cap => ['tools', 'images', 'reasoning', 'promptCache', 'websocket'].includes(cap));
}
export function candidatePin(catalog: RoutingCatalogSnapshot, ref: ModelRef, effort: string | undefined,
  requirements: RoutingRequirements | undefined, ignoreAvailability = false): RoutingCandidatePin | undefined {
  const hasEligible = catalog.models.some(model => sameRef(model.ref, ref) && eligible(model, effort, requirements));
  const stable = ignoreAvailability && !hasEligible ? { ...catalog, models: catalog.models.map(model => ({ ...model,
    credential: { ...model.credential, available: true }, capacity: undefined })) } : catalog;
  try {
    const resolved = routingPolicyIdentity(stable, ref, effort, requirements);
    const rows = stable.models.filter(model => sameRef(model.ref, ref) && eligible(model, effort, requirements));
    const capabilities = (['tools', 'images', 'reasoning', 'promptCache', 'websocket'] as const)
      .filter(cap => rows.every(model => model.confirmedCapabilities.includes(cap) && model.capabilities[cap]));
    return { identity: resolved.identity, metadata: resolved.metadata, capabilities };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === routingIdentityErrors.unavailable) return undefined;
    throw error;
  }
}
export function validFallbackAuthorization(value: unknown): value is RoutingFallbackAuthorization {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const authorization = value as RoutingFallbackAuthorization;
  const validTarget = (target: RoutingTarget) => !!target && typeof target === 'object' && !Array.isArray(target)
    && Object.keys(target).every(key => ['providerId', 'modelId', 'effort', 'kind', 'pin'].includes(key))
    && validText(target.providerId) && validText(target.modelId)
    && (target.effort === undefined || validText(target.effort));
  return Object.keys(authorization).every(key => ['version', 'targets', 'selectorTargets', 'subscriptionPreference'].includes(key))
    && authorization.version === 1 && Array.isArray(authorization.targets) && authorization.targets.every((target, index, all) => validTarget(target)
      && ['serving', 'fallback'].includes(target.kind) && (target.pin === undefined || validCandidatePin(target.pin))
      && all.findIndex(item => item?.providerId === target.providerId && item?.modelId === target.modelId) === index)
    && Array.isArray(authorization.selectorTargets) && authorization.selectorTargets.every(target => validTarget(target)
      && !('effort' in target) && !('kind' in target) && !('pin' in target))
    && authorization.selectorTargets.every((target, index, all) =>
      all.findIndex(item => item?.providerId === target.providerId && item?.modelId === target.modelId) === index)
    && ['auto', 'subscription-first', 'api-first', 'balanced'].includes(authorization.subscriptionPreference);
}
export function compatibleCandidate(current: RoutingBinding, target: RoutingAuthorizedTarget, live: RoutingCandidatePin): boolean {
  const baseline = current.clientPin;
  const frozen = target.pin;
  if (!baseline || !frozen || JSON.stringify(frozen.identity) !== JSON.stringify(live.identity)) return false;
  if (target.kind === 'serving' && frozen.identity.upstreamModelId !== baseline.identity.upstreamModelId) return false;
  if (target.effort !== current.decision.effort) return false;
  const original = baseline.metadata;
  return !!original.contextWindow && !!original.maxOutputTokens && !!frozen.metadata.contextWindow && !!frozen.metadata.maxOutputTokens
    && !!live.metadata.contextWindow && !!live.metadata.maxOutputTokens
    && frozen.metadata.contextWindow >= original.contextWindow && live.metadata.contextWindow >= original.contextWindow
    && frozen.metadata.maxOutputTokens >= original.maxOutputTokens && live.metadata.maxOutputTokens >= original.maxOutputTokens
    && !!original.supportedReasoningEfforts && !!frozen.metadata.supportedReasoningEfforts && !!live.metadata.supportedReasoningEfforts
    && original.supportedReasoningEfforts.every(effort => frozen.metadata.supportedReasoningEfforts!.includes(effort)
      && live.metadata.supportedReasoningEfforts!.includes(effort))
    && baseline.capabilities.every(cap => frozen.capabilities.includes(cap) && live.capabilities.includes(cap));
}
