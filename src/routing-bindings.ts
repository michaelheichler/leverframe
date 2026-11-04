import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureExecutionDir, getExecutionDir, getExecutionsRoot, MAX_DOCUMENT_BYTES, readDocument, workspaceOrSessionHash,
  writeDocumentCAS, type StoreReadResult } from './checkpoint-store.js';
import { readRoutingHandoff, type RoutingConfig, type RoutingPromptResult, type RoutingCategorySelection, type ModelRef, type RoutingTarget } from './model-routing.js';
import type { RoutingCatalogSnapshot } from './model-routing-catalog.js';
import type { RoutingWorkload } from './routing-estimate.js';
import { estimateWorkload } from './routing-estimate.js';
import { decideRouting, eligible, sameRef, type RoutingDecision, type RoutingRequirements } from './routing-policy.js';
import { routingSelectorTargets, selectRoutingTie, type SelectorDependencies, type SelectorFeatures } from './routing-selector.js';
import { ROUTING_SIGNATURE_VERSION, routingSelectorCandidateVersion } from './routing-selector-versions.js';
import { routingPolicyIdentity } from './routing-policy-identity.js';
import type { RoutingSelectorCache } from './routing-selector-cache.js';
import { candidatePin, compatibleCandidate, routingReplayAllowed, safeRoutingEstimate, validCandidatePin, validFallbackAuthorization,
  type RoutingAuthorizedTarget, type RoutingCandidatePin, type RoutingFallbackAuthorization,
  type RoutingFallbackInput, type RoutingFallbackNotice, type RoutingInformationalNotice, type RoutingNotice } from './routing-fallback-contract.js';
import { selectorNoticeReason, validFallbackNotice, validRoutingNotice } from './routing-notice-contract.js';
import { compactRoutingNoticeHistory } from './routing-notice-retention.js';
export { routingReplayAllowed } from './routing-fallback-contract.js';
export type { RoutingAttemptFailure, RoutingAttemptReason, RoutingAuthorizedTarget, RoutingFallbackAuthorization, RoutingFallbackInput, RoutingFallbackNotice } from './routing-fallback-contract.js';

const PREFIX = 'leverframe:binding:';
const VERSION = 1;
export const routingBindingErrors = {
  invalid: 'routing_binding_invalid', sessionMismatch: 'routing_binding_session_mismatch',
  expired: 'routing_binding_expired', resumeMissing: 'routing_resume_missing',
  launchMismatch: 'routing_launch_mismatch', leaseConflict: 'routing_lease_conflict',
  stateInvalid: 'routing_state_invalid', pending: 'routing_binding_pending', disabled: 'routing_disabled',
  routerPinMismatch: 'routing_router_pin_mismatch',
  identityMismatch: 'routing_identity_mismatch',
  leaseAbandoned: 'routing_lease_abandoned',
  capacity: 'routing_state_capacity',
} as const;
export const routingBindingEvents = { selectorMetadataUnavailable: 'selector_metadata_unavailable' } as const;

export interface RoutingSavedHandoff {
  version: 1;
  agentType: string;
  reviewedTask: string;
  prefix: RoutingPromptResult['prefix'];
  provenance: Exclude<RoutingCategorySelection['provenance'], 'unverified'>;
}

export interface RoutingBinding {
  id: string;
  modelId: string;
  sessionId: string;
  launchId: string;
  role: 'router' | 'specialist';
  category?: string;
  arm?: 0 | 1;
  requirements?: RoutingRequirements;
  identity: { upstreamModelId: string; credentialSource: 'claude-code' | 'registry'; transportFingerprint: string };
  taskDigest: string;
  handoff?: RoutingSavedHandoff;
  decision: RoutingDecision;
  revision: number;
  expiresAt: string;
  selectorCalls: number;
  fallbackAuthorization?: RoutingFallbackAuthorization;
  clientPin?: RoutingCandidatePin;
  clientTarget?: ModelRef;
  attemptedTargets?: ModelRef[];
  pendingNotice?: RoutingFallbackNotice;
  requestEstimateRecorded?: boolean;
  initialNoticesAcknowledged?: { launch?: true; selector?: true };
  launchFingerprint: string;
  pending?: boolean;
  pendingOwner?: number;
  lease?: string;
  leaseOwner?: number;
}

export interface BindingLaunchInput {
  sessionId: string;
  launchId: string;
  role: 'router' | 'specialist';
  category?: string;
  agentType?: string;
  effort?: string;
  task: string;
  handoff?: RoutingSavedHandoff;
  config: RoutingConfig;
  catalog: RoutingCatalogSnapshot;
  workload: RoutingWorkload;
  requirements?: RoutingRequirements;
  requirementsFromConfig?: true;
  selector?: { features: SelectorFeatures; candidateSetVersion?: string; signatureVersion?: string;
    selectorWorkload: RoutingWorkload; call: SelectorDependencies['call']; beforeCall?: SelectorDependencies['beforeCall']; deadline?: number };
  selectorCache?: RoutingSelectorCache;
  selectorSkipReason?: typeof routingBindingEvents.selectorMetadataUnavailable;
  now?: () => number;
  ttlMs?: number;
  resume?: boolean;
  acceptNewBinding?: () => boolean;
}
export interface BindingRequestInput { sessionId: string; modelId: string; now?: () => number }
interface State { schemaVersion: number; generation: number; nextArm: number; noticeSequence?: number; notices?: RoutingNotice[]; bindings: RoutingBinding[] }
interface StoredBinding extends Omit<RoutingBinding, 'handoff'> { handoff?: RoutingSavedHandoff; handoffRef?: string }
interface StoredState { schemaVersion: number; generation: number; nextArm: number; noticeSequence?: number; notices?: RoutingNotice[]; bindings: StoredBinding[] }
interface HandoffDocument { schemaVersion: number; generation: number; handoff: RoutingSavedHandoff }

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, ...(code === routingBindingErrors.pending ? { retryable: true } : {}) });
}
function validText(value: string): boolean { return typeof value === 'string' && value.length > 0 && value.length <= 4096; }
function freezeFallbackAuthorization(input: BindingLaunchInput, category: string | undefined, effort: string | undefined): RoutingFallbackAuthorization {
  const categoryConfig = input.config.categories?.[category ?? ''];
  const serving = input.role === 'router' ? [] : [categoryConfig?.target, ...(categoryConfig?.servingAlternatives ?? [])];
  const fallbacks = input.role === 'router' ? [input.config.cheapFallback, ...(input.config.routerFallbacks ?? [])]
    : categoryConfig?.fallbacks ?? [];
  const selectorTargets = routingSelectorTargets(input.config, input.catalog, input.selector?.selectorWorkload ?? {});
  const authorization: RoutingFallbackAuthorization = { version: 1,
    targets: [...serving.filter((target): target is RoutingTarget => !!target).map(target => ({ providerId: target.providerId, modelId: target.modelId,
      ...(effort === undefined ? {} : { effort }), kind: 'serving' as const })),
      ...fallbacks.filter((target): target is RoutingTarget => !!target).map(target => ({ providerId: target.providerId, modelId: target.modelId,
        ...(target.effort === undefined ? {} : { effort: target.effort }), kind: 'fallback' as const }))],
    selectorTargets: selectorTargets.filter((target): target is ModelRef => !!target)
      .map(target => ({ providerId: target.providerId, modelId: target.modelId })),
    subscriptionPreference: input.config.subscriptionPreference ?? 'auto' };
  for (const target of [...authorization.targets, ...authorization.selectorTargets]) {
    if (!input.catalog.models.some(model => model.ref.providerId === target.providerId && model.ref.modelId === target.modelId)) {
      return fail('routing_unresolved_target', `Routing fallback ${target.providerId}/${target.modelId} is unresolved. Run provider discovery and setup.`);
    }
  }
  const uniqueTargets: RoutingAuthorizedTarget[] = [];
  for (const target of authorization.targets) {
    const prior = uniqueTargets.find(item => item.providerId === target.providerId && item.modelId === target.modelId);
    if (!prior) uniqueTargets.push(target);
    else if (prior.effort !== target.effort) {
      const path = input.role === 'router' ? 'routing.cheapFallback or routing.routerFallbacks'
        : `routing.categories.${category} target, servingAlternatives, or fallbacks`;
      return fail('routing_fallback_invalid', `Duplicate routing reference ${target.providerId}/${target.modelId} has conflicting effort in ${path}.`);
    }
  }
  authorization.targets = uniqueTargets;
  for (const target of authorization.targets) {
    const pin = candidatePin(input.catalog, target, target.effort, input.requirements, true);
    if (pin) target.pin = pin;
  }
  authorization.selectorTargets = authorization.selectorTargets.filter((target, index, all) =>
    all.findIndex(item => item.providerId === target.providerId && item.modelId === target.modelId) === index);
  if (!validFallbackAuthorization(authorization)) return fail('routing_fallback_invalid', 'Invalid routing fallback authorization.');
  return authorization;
}
function validHandoff(value: unknown): value is RoutingSavedHandoff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const handoff = value as RoutingSavedHandoff;
  if (Object.keys(handoff).some(key => !['version', 'agentType', 'reviewedTask', 'prefix', 'provenance'].includes(key))
    || handoff.version !== 1 || !validText(handoff.agentType) || typeof handoff.reviewedTask !== 'string'
    || !['explicit', 'agent_mapping', 'task_category_match', 'default'].includes(handoff.provenance)) return false;
  try {
    const envelope = readRoutingHandoff(handoff.reviewedTask);
    return envelope.agentType === handoff.agentType && JSON.stringify(envelope.prefix) === JSON.stringify(handoff.prefix);
  } catch { return false; }
}
function scope(sessionId: string): string { return workspaceOrSessionHash(sessionId); }
export function routingBindingStatePath(sessionId: string): string {
  return join(getExecutionDir(scope(sessionId), 'routing-bindings'), 'bindings.json');
}
function validState(value: Record<string, unknown>): boolean {
  const bindings = value.bindings;
  return Number.isSafeInteger(value.nextArm) && (value.nextArm as number) >= 0
    && (value.noticeSequence === undefined || (Number.isSafeInteger(value.noticeSequence) && (value.noticeSequence as number) >= 0))
    && Array.isArray(bindings)
    && bindings.every((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const binding = item as RoutingBinding;
      return typeof binding.id === 'string' && binding.modelId === binding.id
        && validText(binding.sessionId) && validText(binding.launchId)
        && ['router', 'specialist'].includes(binding.role)
        && (binding.category === undefined || validText(binding.category))
        && (binding.arm === undefined || binding.arm === 0 || binding.arm === 1)
        && !!binding.identity && validText(binding.identity.upstreamModelId)
        && ['claude-code', 'registry'].includes(binding.identity.credentialSource)
        && typeof binding.identity.transportFingerprint === 'string' && /^[a-f0-9]{64}$/.test(binding.identity.transportFingerprint)
        && /^[a-f0-9]{64}$/.test(binding.taskDigest) && /^[a-f0-9]{64}$/.test(binding.launchFingerprint)
        && (binding.handoff === undefined || (binding.role === 'specialist' && validHandoff(binding.handoff)
          && binding.handoff.prefix.category === binding.category
          && createHash('sha256').update(binding.handoff.reviewedTask).digest('hex') === binding.taskDigest))
        && Number.isSafeInteger(binding.revision) && binding.revision > 0
        && Number.isSafeInteger(binding.selectorCalls) && binding.selectorCalls >= 0
        && (binding.fallbackAuthorization === undefined || validFallbackAuthorization(binding.fallbackAuthorization))
        && (binding.clientPin === undefined || validCandidatePin(binding.clientPin))
        && (binding.clientTarget === undefined || (!!binding.clientTarget && typeof binding.clientTarget === 'object'
          && !Array.isArray(binding.clientTarget) && Object.keys(binding.clientTarget).every(key => ['providerId', 'modelId'].includes(key))
          && validText(binding.clientTarget.providerId) && validText(binding.clientTarget.modelId)))
        && (binding.attemptedTargets === undefined || (Array.isArray(binding.attemptedTargets)
          && binding.attemptedTargets.every((target, index, all) => !!target && validText(target.providerId) && validText(target.modelId)
            && all.findIndex(item => item?.providerId === target.providerId && item?.modelId === target.modelId) === index)))
        && !!binding.decision && typeof binding.decision === 'object' && !!binding.decision.target
        && (binding.pendingNotice === undefined || (validFallbackNotice(binding.pendingNotice, binding, value.noticeSequence)
          && binding.pendingNotice.revision === binding.revision && sameRef(binding.pendingNotice.target, binding.decision.target)
          && Array.isArray(value.notices) && value.notices.some((notice: unknown) => JSON.stringify(notice) === JSON.stringify(binding.pendingNotice))))
        && (binding.requestEstimateRecorded === undefined || binding.requestEstimateRecorded === true)
        && (binding.initialNoticesAcknowledged === undefined || (!!binding.initialNoticesAcknowledged
          && typeof binding.initialNoticesAcknowledged === 'object' && !Array.isArray(binding.initialNoticesAcknowledged)
          && Object.keys(binding.initialNoticesAcknowledged).every(key => ['launch', 'selector'].includes(key))
          && (binding.initialNoticesAcknowledged.launch === undefined || binding.initialNoticesAcknowledged.launch === true)
          && (binding.initialNoticesAcknowledged.selector === undefined || binding.initialNoticesAcknowledged.selector === true)))
        && Number.isFinite(Date.parse(binding.expiresAt))
        && (binding.pending === undefined || binding.pending === true)
        && (binding.pending ? Number.isSafeInteger(binding.pendingOwner) && binding.pendingOwner! > 0 : binding.pendingOwner === undefined)
        && (binding.lease === undefined || typeof binding.lease === 'string')
        && (binding.leaseOwner === undefined || (binding.lease !== undefined
          && Number.isSafeInteger(binding.leaseOwner) && binding.leaseOwner > 0))
        && !!binding.decision && typeof binding.decision === 'object'
        && !!binding.decision.target && validText(binding.decision.target.providerId)
        && validText(binding.decision.target.modelId);
    }) && (value.notices === undefined || (Array.isArray(value.notices) && value.notices.every((notice: RoutingNotice, index: number, all: RoutingNotice[]) => {
      const binding = bindings.find((item: RoutingBinding) => item.id === notice?.modelId);
      return !!binding && validRoutingNotice(notice, binding, value.noticeSequence)
        && all.findIndex(item => item?.sequence === notice.sequence) === index;
    })));
}
function validStoredState(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.bindings)) return false;
  const bindings = [];
  for (const item of value.bindings) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const { handoffRef, ...binding } = item as StoredBinding;
    if (handoffRef !== undefined && (binding.handoff !== undefined || typeof handoffRef !== 'string'
      || !/^[a-f0-9]{64}$/.test(handoffRef))) return false;
    bindings.push(binding);
  }
  return validState({ ...value, bindings });
}

function canonicalHandoff(handoff: RoutingSavedHandoff): string {
  return JSON.stringify({ version: handoff.version, agentType: handoff.agentType, reviewedTask: handoff.reviewedTask,
    prefix: readRoutingHandoff(handoff.reviewedTask).prefix, provenance: handoff.provenance });
}

function handoffDigest(handoff: RoutingSavedHandoff): string {
  return createHash('sha256').update(canonicalHandoff(handoff)).digest('hex');
}

function handoffPath(scopeHash: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) return fail(routingBindingErrors.stateInvalid, 'Invalid routing handoff reference.');
  return join(getExecutionDir(scopeHash, 'routing-bindings'), `handoff-${digest}.json`);
}

function validHandoffDocument(value: Record<string, unknown>): boolean {
  return value.generation === 1 && validHandoff(value.handoff);
}

function readHandoff(scopeHash: string, digest: string): RoutingSavedHandoff {
  const saved = readDocument<HandoffDocument>(handoffPath(scopeHash, digest), VERSION, validHandoffDocument, 'routing handoff');
  if (saved.state !== 'ok' || !saved.value || handoffDigest(saved.value.handoff) !== digest) {
    return fail(routingBindingErrors.stateInvalid, 'The saved routing handoff is unavailable or invalid.');
  }
  return saved.value.handoff;
}

function storeHandoff(scopeHash: string, handoff: RoutingSavedHandoff): string {
  const digest = handoffDigest(handoff);
  const path = handoffPath(scopeHash, digest);
  const existing = readDocument<HandoffDocument>(path, VERSION, validHandoffDocument, 'routing handoff');
  if (existing.state === 'ok') {
    if (!existing.value || handoffDigest(existing.value.handoff) !== digest
      || canonicalHandoff(existing.value.handoff) !== canonicalHandoff(handoff)) return fail(routingBindingErrors.stateInvalid, 'The saved routing handoff is invalid.');
    return digest;
  }
  if (existing.state !== 'missing') return fail(routingBindingErrors.stateInvalid, 'The saved routing handoff is unavailable or invalid.');
  const document: HandoffDocument = { schemaVersion: VERSION, generation: 1, handoff };
  if (Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`, 'utf8') > MAX_DOCUMENT_BYTES) {
    return fail(routingBindingErrors.capacity, 'The routing handoff exceeds checkpoint storage limits.');
  }
  const saved = writeDocumentCAS(path, VERSION, validHandoffDocument, 0, document, 'routing handoff');
  if (!saved.ok) {
    if (saved.reason !== 'conflict' || canonicalHandoff(readHandoff(scopeHash, digest)) !== canonicalHandoff(handoff)) {
      return fail(routingBindingErrors.stateInvalid, 'The routing handoff could not be saved.');
    }
  }
  return digest;
}

function readRoutingState(path: string, scopeHash: string): StoreReadResult<State> {
  const saved = readDocument<StoredState>(path, VERSION, validStoredState, 'routing bindings');
  if (saved.state !== 'ok' || !saved.value) return saved as StoreReadResult<State>;
  try {
    const bindings = saved.value.bindings.map(({ handoffRef, ...binding }) =>
      handoffRef === undefined ? binding : { ...binding, handoff: readHandoff(scopeHash, handoffRef) });
    const state: State = { ...saved.value, bindings };
    if (!validState(state as unknown as Record<string, unknown>)) throw new Error('Invalid routing bindings.');
    return { ...saved, value: state };
  } catch (error) {
    return { state: 'invalid-storage', generation: saved.generation, error: error instanceof Error ? error.message : String(error) };
  }
}

function storeRoutingState(scopeHash: string, state: State): StoredState {
  const bindings = state.bindings.map(({ handoff, ...binding }) => handoff === undefined ? binding
    : { ...binding, handoffRef: handoffDigest(handoff) });
  const stored = { ...state, bindings };
  if (Buffer.byteLength(`${JSON.stringify(stored, null, 2)}\n`, 'utf8') > MAX_DOCUMENT_BYTES) {
    return fail(routingBindingErrors.capacity, 'Routing session storage is full. Start a new session to launch more agents.');
  }
  for (const { handoff } of state.bindings) if (handoff !== undefined) storeHandoff(scopeHash, handoff);
  return stored;
}
function read(sessionId: string): State {
  const result = readRoutingState(routingBindingStatePath(sessionId), scope(sessionId));
  if (result.state === 'missing') return { schemaVersion: VERSION, generation: 0, nextArm: 0, bindings: [] };
  if (result.state !== 'ok' || !result.value) return fail(routingBindingErrors.stateInvalid, `Routing state is unavailable: ${result.error ?? result.state}`);
  return result.value;
}
function update<T>(sessionId: string, change: (state: State) => T): T {
  ensureExecutionDir(scope(sessionId), 'routing-bindings');
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = read(sessionId);
    const result = change(state);
    compactRoutingNoticeHistory(state);
    const generation = state.generation;
    state.generation++;
    const stored = storeRoutingState(scope(sessionId), state);
    const saved = writeDocumentCAS(routingBindingStatePath(sessionId), VERSION, validStoredState, generation, stored, 'routing bindings');
    if (saved.ok) return result;
    if (saved.reason !== 'conflict') return fail(routingBindingErrors.stateInvalid, `Routing state could not be saved: ${saved.error ?? saved.reason}`);
  }
  return fail('routing_state_conflict', 'Routing state is busy. Retry the request.');
}
function find(input: BindingRequestInput, state: State, checkLease = false): RoutingBinding {
  if (!validText(input.sessionId) || typeof input.modelId !== 'string' || !/^leverframe:binding:[a-f0-9]{32}:[a-f0-9]{64}$/.test(input.modelId)) {
    return fail(routingBindingErrors.invalid, 'Invalid routing binding.');
  }
  if (!input.modelId.startsWith(`${PREFIX}${scope(input.sessionId)}:`)) return fail(routingBindingErrors.sessionMismatch, 'Routing binding belongs to another session.');
  const binding = state.bindings.find(item => item.id === input.modelId);
  if (!binding || binding.sessionId !== input.sessionId) return fail(routingBindingErrors.invalid, 'Routing binding was not found.');
  if (checkLease && binding.lease) {
    if (binding.leaseOwner !== undefined && !ownerAlive(binding.leaseOwner)) {
      return fail(routingBindingErrors.leaseAbandoned, 'A previous inference ended without a known outcome. Recover the job before continuing.');
    }
    throw Object.assign(new Error('Another request is using this binding. Retry shortly.'), {
      code: routingBindingErrors.leaseConflict, retryable: true,
    });
  }
  if (!Number.isFinite(Date.parse(binding.expiresAt)) || (input.now ?? Date.now)() >= Date.parse(binding.expiresAt)) {
    return fail(routingBindingErrors.expired, 'Routing binding has expired. Start a new job.');
  }
  if (binding.pending) return fail(routingBindingErrors.pending, 'Routing launch is still being resolved. Retry shortly.');
  return binding;
}
function ownerAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export async function resolveRoutingBinding(input: BindingRequestInput): Promise<RoutingBinding> { return find(input, read(input.sessionId)); }

export function scanRoutingRecovery(now: () => number = Date.now): { needed: boolean; targets: RoutingDecision['target'][] } {
  const root = getExecutionsRoot();
  let scopes;
  try { scopes = readdirSync(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { needed: false, targets: [] };
    throw error;
  }
  let needed = false;
  const targets = new Map<string, RoutingDecision['target']>();
  for (const entry of scopes) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
    const path = join(getExecutionDir(entry.name, 'routing-bindings'), 'bindings.json');
    const saved = readRoutingState(path, entry.name);
    if (saved.state === 'missing') continue;
    if (saved.state !== 'ok' || !saved.value || saved.value.bindings.some(binding => scope(binding.sessionId) !== entry.name
      || !/^leverframe:binding:[a-f0-9]{32}:[a-f0-9]{64}$/.test(binding.id)
      || !binding.id.startsWith(`${PREFIX}${entry.name}:`))) {
      return fail(routingBindingErrors.stateInvalid, 'Routing recovery state is unavailable or invalid.');
    }
    for (const binding of saved.value.bindings) {
      if (binding.role !== 'specialist') continue;
      needed = true;
      if (now() >= Date.parse(binding.expiresAt)) continue;
      const target = binding.decision.target;
      targets.set(JSON.stringify([target.providerId, target.modelId]), target);
    }
  }
  return { needed, targets: [...targets.values()] };
}

export async function resolveRoutingRecovery(input: { sessionId: string; launchId: string; marker?: unknown; sidecarValid: boolean }) {
  if (!validText(input.sessionId) || !validText(input.launchId) || input.sidecarValid !== true) {
    return fail(routingBindingErrors.invalid, 'A valid saved agent sidecar is required for routing recovery.');
  }
  if (input.marker === undefined) {
    if (read(input.sessionId).bindings.some(binding => binding.launchId === input.launchId)) {
      return fail(routingBindingErrors.invalid, 'Saved routing marker is missing for a known agent.');
    }
    return { kind: 'unbound' as const };
  }
  if (typeof input.marker !== 'string') return fail(routingBindingErrors.invalid, 'Invalid saved routing marker.');
  const binding = await resolveRoutingBinding({ sessionId: input.sessionId, modelId: input.marker });
  if (binding.launchId !== input.launchId || binding.role !== 'specialist') {
    return fail(routingBindingErrors.launchMismatch, 'Saved routing marker does not match this agent.');
  }
  return { kind: 'bound' as const, binding };
}

export function assertRoutingIdentity(binding: RoutingBinding, catalog: RoutingCatalogSnapshot): void {
  const identity = candidatePin(catalog, binding.decision.target, binding.decision.effort, binding.requirements, true)?.identity;
  if (!identity) return fail(routingBindingErrors.identityMismatch, 'The saved routing model identity is unavailable. Restore the original model.');
  if (identity.upstreamModelId !== binding.identity.upstreamModelId || identity.credentialSource !== binding.identity.credentialSource
    || identity.transportFingerprint !== binding.identity.transportFingerprint) {
    fail(routingBindingErrors.identityMismatch, 'The saved routing model identity changed. Restore the original model or start a new job.');
  }
}

export async function recordRoutingRequestEstimate(input: BindingRequestInput & {
  leaseId: string; inputBytes: number; maxOutputTokens: number; catalog: RoutingCatalogSnapshot; cacheUsageUnknown?: boolean;
}): Promise<RoutingBinding> {
  if (!Number.isSafeInteger(input.inputBytes) || input.inputBytes < 0
    || !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0) {
    return fail('routing_estimate_invalid', 'Request estimate bounds are invalid.');
  }
  return update(input.sessionId, state => {
    const current = state.bindings.find(item => item.id === input.modelId && item.sessionId === input.sessionId);
    if (!current || !current.lease || current.lease !== input.leaseId) {
      throw Object.assign(new Error('Routing lease is no longer active.'), { code: routingBindingErrors.leaseConflict, retryable: true });
    }
    if (current.requestEstimateRecorded) return current;
    const snapshot = current.decision.estimate.snapshot;
    const estimate = input.cacheUsageUnknown ? { kind: 'unknown' as const, snapshot }
      : estimateWorkload(snapshot, { input: input.inputBytes, output: input.maxOutputTokens });
    current.decision = { ...current.decision, estimate, events: [...current.decision.events, {
      reason: input.cacheUsageUnknown ? 'request_cost_cache_unknown' : 'request_cost_estimate_uncached_bytes',
      target: current.decision.target,
    }] };
    current.requestEstimateRecorded = true;
    return current;
  });
}

function appendInformationalNotice(state: State, binding: RoutingBinding, kind: RoutingInformationalNotice['kind'], reason: string,
  details: Pick<RoutingInformationalNotice, 'target' | 'lastAttempted' | 'attemptedCount' | 'skippedCount'>): RoutingInformationalNotice {
  state.noticeSequence = (state.noticeSequence ?? 0) + 1;
  const notice: RoutingInformationalNotice = { kind, sessionId: binding.sessionId, sequence: state.noticeSequence,
    modelId: binding.modelId, revision: binding.revision, role: binding.role, category: binding.category,
    policy: binding.decision.policy, policyVersion: binding.decision.policyVersion, effort: binding.decision.effort ?? null,
    estimate: binding.decision.estimate, reason, ...details, acknowledged: false };
  (state.notices ??= []).push(notice);
  return notice;
}

export async function ensureRoutingLaunchNotices(input: BindingRequestInput & {
  leaseId: string; revision: number;
}): Promise<RoutingInformationalNotice[]> {
  return update(input.sessionId, state => {
    const binding = find(input, state);
    if (binding.lease !== input.leaseId || binding.revision !== input.revision) {
      return fail(routingBindingErrors.leaseConflict, 'The routing lease or revision is no longer active.');
    }
    const notices = (state.notices ?? []).filter((notice): notice is RoutingInformationalNotice =>
      'kind' in notice && notice.modelId === binding.modelId && (notice.kind === 'launch' || notice.kind === 'selector'
        || (notice.kind === 'request_completed' && !notice.acknowledged)));
    if (!binding.initialNoticesAcknowledged?.launch && !notices.some(notice => notice.kind === 'launch')) {
      notices.push(appendInformationalNotice(state, binding, 'launch', binding.decision.reason,
        { target: { ...binding.decision.target } }));
    }
    const selector = [...binding.decision.events].reverse().find(event => selectorNoticeReason(event.reason));
    if (selector && !binding.initialNoticesAcknowledged?.selector && !notices.some(notice => notice.kind === 'selector')) {
      notices.push(appendInformationalNotice(state, binding, 'selector', selector.reason, {}));
    }
    return notices.sort((a, b) => a.sequence - b.sequence);
  });
}

export async function recordRoutingRequestCompletion(input: BindingRequestInput & {
  leaseId: string; revision: number;
}): Promise<RoutingInformationalNotice> {
  return update(input.sessionId, state => {
    const binding = find(input, state);
    if (binding.lease !== input.leaseId || binding.revision !== input.revision) {
      return fail(routingBindingErrors.leaseConflict, 'The routing lease or revision is no longer active.');
    }
    if ((state.notices ?? []).some(notice => 'kind' in notice && notice.kind === 'request_completed'
      && notice.modelId === binding.modelId && !notice.acknowledged)) {
      return fail('routing_notice_pending', 'The previous completion notice has not been acknowledged.');
    }
    return appendInformationalNotice(state, binding, 'request_completed', 'request_completed',
      { target: { ...binding.decision.target } });
  });
}

export async function advanceRoutingFallback(input: RoutingFallbackInput): Promise<RoutingBinding> {
  if (!routingReplayAllowed(input.failure)) return fail('routing_replay_unsafe', 'The failed request cannot safely be replayed.');
  if (!input.requirements || !Array.isArray(input.requirements.capabilities)
    || !Number.isSafeInteger(input.requirements.contextTokens) || input.requirements.contextTokens! <= 0
    || !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0) {
    return fail('routing_request_evidence_missing', 'The request bounds are unavailable. The request cannot safely be replayed.');
  }
  if (input.signal.aborted || !Number.isFinite(input.deadline) || (input.now ?? Date.now)() >= input.deadline) {
    return fail('routing_request_cancelled', 'The routing request was cancelled or its deadline expired.');
  }
  const outcome = update(input.sessionId, state => {
    if (input.signal.aborted || (input.now ?? Date.now)() >= input.deadline) {
      return fail('routing_request_cancelled', 'The routing request was cancelled or its deadline expired.');
    }
    const current = find(input, state);
    if (!current.lease || current.lease !== input.leaseId || current.revision !== input.revision) {
      return fail(routingBindingErrors.leaseConflict, 'The routing lease or revision is no longer active.');
    }
    if (!current.fallbackAuthorization || !current.clientPin || !current.attemptedTargets) {
      return fail('routing_fallback_provenance_missing', 'The saved routing fallback authorization is unavailable. Start a new job.');
    }
    if (current.pendingNotice && !current.pendingNotice.acknowledged) {
      return fail('routing_notice_pending', 'The previous routing notice has not been acknowledged.');
    }
    const skipped: RoutingDecision['events'] = [];
    for (const target of current.fallbackAuthorization.targets) {
      if (current.attemptedTargets.some(ref => sameRef(ref, target))) continue;
      if (!input.catalog.models.some(row => sameRef(row.ref, target))) {
        return fail('routing_unresolved_target', `Routing fallback ${target.providerId}/${target.modelId} is unresolved. Restore its configured model.`);
      }
      if (input.candidateAllowed && input.candidateAllowed(structuredClone(target)) !== true) {
        skipped.push({ reason: 'fallback_transport_unsupported', target: { providerId: target.providerId, modelId: target.modelId } });
        continue;
      }
      const live = candidatePin(input.catalog, target, target.effort, input.requirements);
      const model = input.catalog.models.find(row => sameRef(row.ref, target) && eligible(row, target.effort, input.requirements));
      if (live && target.pin && JSON.stringify(target.pin.identity) !== JSON.stringify(live.identity)) {
        return fail(routingBindingErrors.identityMismatch, 'An authorized fallback model identity changed. Restore its original configuration.');
      }
      const skipReason = !target.pin ? 'fallback_provenance_missing'
        : !live || !model ? 'fallback_unavailable'
          : target.effort !== current.decision.effort ? 'fallback_effort_incompatible'
            : !compatibleCandidate(current, target, live) ? 'fallback_client_view_incompatible'
              : input.maxOutputTokens > (live.metadata.maxOutputTokens ?? 0) ? 'fallback_request_limit_exceeded' : undefined;
      if (skipReason) {
        skipped.push({ reason: skipReason, target: { providerId: target.providerId, modelId: target.modelId } });
        continue;
      }
      if (!live || !model) return fail('routing_fallback_invalid', 'Fallback evidence is unavailable.');
      const previous = current.decision.target;
      const rawEstimate = input.workload.cacheRead === undefined || input.workload.cacheWrite === undefined
        ? { kind: 'unknown' as const, snapshot: model.estimate } : estimateWorkload(model.estimate, input.workload);
      const estimate = safeRoutingEstimate(rawEstimate);
      if (!estimate) return fail('routing_estimate_invalid', 'The fallback cost snapshot is invalid.');
      current.revision++;
      current.identity = live.identity;
      current.decision = { ...current.decision, target: { providerId: target.providerId, modelId: target.modelId },
        effort: target.effort, estimate, reason: 'availability_fallback', events: [...current.decision.events, ...skipped,
          { reason: 'availability_fallback', target: { providerId: target.providerId, modelId: target.modelId } }] };
      current.attemptedTargets.push(current.decision.target);
      state.noticeSequence = (state.noticeSequence ?? 0) + 1;
      current.pendingNotice = { sessionId: current.sessionId, sequence: state.noticeSequence, modelId: current.modelId,
        revision: current.revision, previous, target: current.decision.target, reason: input.failure.reason,
        role: current.role, category: current.category, policy: current.decision.policy, policyVersion: current.decision.policyVersion,
        effort: current.decision.effort ?? null, estimate, cacheReuse: 'unknown', acknowledged: false };
      (state.notices ??= []).push(current.pendingNotice);
      return { binding: current };
    }
    current.decision = { ...current.decision, events: [...current.decision.events, ...skipped] };
    appendInformationalNotice(state, current, 'exhausted', input.failure.reason, {
      lastAttempted: { ...current.decision.target }, attemptedCount: current.attemptedTargets.length, skippedCount: skipped.length,
    });
    return { binding: undefined };
  });
  if (!outcome.binding) return fail('routing_fallback_exhausted', 'No compatible authorized fallback remains. Check model availability and request limits.');
  return outcome.binding;
}

export interface RoutingNoticeIdentity { sessionId: string; sequence: number; modelId: string; revision: number }
export interface NoticeAcknowledgmentInput extends RoutingNoticeIdentity { leaseId: string; deadline: number; signal: AbortSignal }

function validNoticeIdentity(input: RoutingNoticeIdentity): boolean {
  return !!input && validText(input.sessionId) && typeof input.modelId === 'string'
    && /^leverframe:binding:[a-f0-9]{32}:[a-f0-9]{64}$/.test(input.modelId)
    && input.modelId.startsWith(`${PREFIX}${scope(input.sessionId)}:`)
    && Number.isSafeInteger(input.sequence) && input.sequence > 0 && Number.isSafeInteger(input.revision) && input.revision > 0;
}

function noticeMatches(notice: RoutingNotice, input: RoutingNoticeIdentity): boolean {
  return notice.sessionId === input.sessionId && notice.sequence === input.sequence
    && notice.modelId === input.modelId && notice.revision === input.revision;
}

export function listRoutingNotices(sessionId: string, after: number): RoutingNotice[] {
  if (!validText(sessionId) || !Number.isSafeInteger(after) || after < 0) {
    return fail('routing_notice_invalid', 'Invalid routing notice cursor.');
  }
  return (read(sessionId).notices ?? []).filter(notice => notice.sessionId === sessionId
    && (notice.sequence > after || !notice.acknowledged));
}

export async function acknowledgeRoutingNotice(input: RoutingNoticeIdentity): Promise<void> {
  if (!validNoticeIdentity(input)) return fail('routing_notice_invalid', 'Invalid routing notice identity.');
  update(input.sessionId, state => {
    const notice = state.notices?.find(item => noticeMatches(item, input));
    if (!notice) return fail('routing_notice_invalid', 'The routing notice does not match a saved event.');
    notice.acknowledged = true;
    const binding = state.bindings.find(item => item.id === input.modelId && item.sessionId === input.sessionId);
    if (binding?.pendingNotice && noticeMatches(binding.pendingNotice, input)) binding.pendingNotice.acknowledged = true;
  });
}

export async function awaitRoutingNotice(input: NoticeAcknowledgmentInput): Promise<void> {
  if (!validNoticeIdentity(input)) return fail('routing_notice_invalid', 'Invalid routing notice identity.');
  while (true) {
    if (input.signal.aborted || !Number.isFinite(input.deadline) || Date.now() >= input.deadline) {
      return fail('routing_notice_timeout', 'The routing notice was not acknowledged before cancellation or deadline.');
    }
    const state = read(input.sessionId);
    const binding = find(input, state);
    if (binding.lease !== input.leaseId || binding.revision !== input.revision) {
      return fail(routingBindingErrors.leaseConflict, 'The routing lease or revision is no longer active.');
    }
    const notice = state.notices?.find(item => noticeMatches(item, input));
    if (!notice) return fail('routing_notice_invalid', 'The routing notice does not match a saved event.');
    if (notice.acknowledged) {
      if (input.signal.aborted || Date.now() >= input.deadline) {
        return fail('routing_notice_timeout', 'The routing notice acknowledgment arrived after cancellation or deadline.');
      }
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); input.signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { clearTimeout(timer); input.signal.removeEventListener('abort', abort); reject(Object.assign(new Error('Routing notice wait cancelled.'), { code: 'routing_notice_timeout' })); };
      const timer = setTimeout(finish, Math.min(50, Math.max(1, input.deadline - Date.now())));
      input.signal.addEventListener('abort', abort, { once: true });
      if (input.signal.aborted) abort();
    });
  }
}

function launchIdentity(input: BindingLaunchInput) {
  const taskDigest = createHash('sha256').update(input.task).digest('hex');
  const category = input.role === 'specialist' ? input.category ?? (input.agentType ? input.config.agentCategories?.[input.agentType] : undefined) ?? input.config.defaultCategory : undefined;
  if (input.handoff && (!validHandoff(input.handoff) || input.role !== 'specialist' || (!input.resume && input.handoff.reviewedTask !== input.task)
    || input.handoff.agentType !== input.agentType || input.handoff.prefix.category !== category)) {
    return fail('routing_handoff_invalid', 'The routing handoff does not match the launch.');
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ role: input.role, category, agentType: input.agentType,
    effort: input.effort, taskDigest, handoffProvenance: input.handoff?.provenance,
    requirements: input.requirementsFromConfig === true ? undefined : input.requirements, workload: input.workload,
    selector: input.selector && { features: input.selector.features, candidateSetVersion: input.selector.candidateSetVersion,
      signatureVersion: input.selector.signatureVersion, selectorWorkload: input.selector.selectorWorkload } })).digest('hex');
  return { taskDigest, category, fingerprint };
}

function assertNewRoutingBindingAllowed(input: BindingLaunchInput): void {
  if (input.config.enabled !== true || input.acceptNewBinding?.() === false) {
    return fail(routingBindingErrors.disabled, 'Routing is disabled for new launches.');
  }
}

export async function createRoutingBinding(input: BindingLaunchInput): Promise<RoutingBinding> {
  if (input.selectorCache?.signal.aborted) return fail('routing_cache_closed', 'Routing service has closed.');
  if (!validText(input.sessionId) || !validText(input.launchId) || typeof input.task !== 'string'
    || !['router', 'specialist'].includes(input.role)
    || (input.ttlMs !== undefined && (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0))) {
    return fail('routing_launch_invalid', 'Invalid routing launch.');
  }
  const { taskDigest, category, fingerprint } = launchIdentity(input);
  const binding = update(input.sessionId, state => {
    const prior = state.bindings.find(item => item.launchId === input.launchId);
    if (prior) {
      if (prior.role !== input.role || (!input.resume && prior.launchFingerprint !== fingerprint)) {
        return fail(routingBindingErrors.launchMismatch, 'Launch identity was reused with different input.');
      }
      if (prior.pending) {
        if (ownerAlive(prior.pendingOwner!)) return fail(routingBindingErrors.pending, 'Routing launch is still being resolved. Retry shortly.');
        delete prior.pending;
        delete prior.pendingOwner;
      }
      if ((input.now ?? Date.now)() >= Date.parse(prior.expiresAt)) return fail(routingBindingErrors.expired, 'Routing binding has expired.');
      assertRoutingIdentity(prior, input.catalog);
      return prior;
    }
    if (input.resume) return fail(routingBindingErrors.resumeMissing, 'Routing state is missing. Start a new job or recover its checkpoint.');
    assertNewRoutingBindingAllowed(input);
    const arm = category && input.config.categories?.[category]?.alternatingTargets ? state.nextArm % 2 as 0 | 1 : undefined;
    const decision = decideRouting({ config: input.config, catalog: input.catalog, role: input.role, category, effort: input.effort,
      arm, requirements: input.requirements, workload: input.workload });
    if (input.handoff) decision.events.push({ reason: `category_source_${input.handoff.provenance}` });
    const { identity } = routingPolicyIdentity(input.catalog, decision.target, decision.effort, input.requirements);
    const fallbackAuthorization = freezeFallbackAuthorization(input, category, decision.effort);
    const clientPin = candidatePin(input.catalog, decision.target, decision.effort, input.requirements);
    if (input.selectorSkipReason) decision.events.push({ reason: input.selectorSkipReason });
    const id = `${PREFIX}${scope(input.sessionId)}:${randomBytes(32).toString('hex')}`;
    const created: RoutingBinding = { id, modelId: id, sessionId: input.sessionId, launchId: input.launchId, role: input.role,
      category, arm, taskDigest, decision, identity, revision: 1, selectorCalls: 0, launchFingerprint: fingerprint,
      fallbackAuthorization,
      ...(clientPin ? { clientPin } : {}), clientTarget: { ...decision.target }, attemptedTargets: [decision.target],
      ...(input.handoff ? { handoff: structuredClone(input.handoff) } : {}),
      ...(input.requirements ? { requirements: structuredClone(input.requirements) } : {}),
      expiresAt: new Date((input.now ?? Date.now)() + (input.ttlMs ?? 24 * 60 * 60 * 1000)).toISOString(),
      ...(input.selector ? { pending: true, pendingOwner: process.pid } : {}) };
    if (arm !== undefined) state.nextArm++;
    state.bindings.push(created);
    return created;
  });
  if (!binding.pending || !input.selector) return binding;
  const selector = input.selector;
  const now = (input.now ?? Date.now)();
  const sessionCache = input.selectorCache?.forSession(input.sessionId, Date.parse(binding.expiresAt), now) ?? new Map();
  const decision = await selectRoutingTie({ decision: binding.decision, config: input.config, catalog: input.catalog,
    category: category ?? 'default', effort: binding.decision.effort, requirements: binding.requirements,
    features: selector.features, taskSignature: taskDigest,
    candidateSetVersion: selector.candidateSetVersion ?? routingSelectorCandidateVersion({ decision: binding.decision,
      catalog: input.catalog, category: category ?? 'default', effort: binding.decision.effort }),
    signatureVersion: selector.signatureVersion ?? ROUTING_SIGNATURE_VERSION,
    jobId: input.launchId, deadline: selector.deadline, selectorWorkload: selector.selectorWorkload }, {
    now: input.now ?? Date.now, call: (target, payload, signal) => selector.call(target, payload,
      input.selectorCache ? AbortSignal.any([signal, input.selectorCache.signal]) : signal),
    cache: sessionCache,
    beforeCall: selector.beforeCall,
    reserveCall: async (_jobId, limit) => update(input.sessionId, state => {
      const current = state.bindings.find(item => item.id === binding.id)!;
      if (current.selectorCalls >= limit) return false;
      current.selectorCalls++;
      return true;
    }),
  });
  return update(input.sessionId, state => {
    const current = state.bindings.find(item => item.id === binding.id)!;
    current.decision = decision;
    current.identity = routingPolicyIdentity(input.catalog, decision.target, decision.effort, current.requirements).identity;
    current.clientPin = candidatePin(input.catalog, decision.target, decision.effort, current.requirements);
    current.clientTarget = { ...decision.target };
    current.attemptedTargets = [decision.target];
    delete current.pending;
    delete current.pendingOwner;
    return current;
  });
}

export async function withRoutingLease<T>(input: BindingRequestInput, action: (binding: RoutingBinding) => Promise<T>): Promise<T> {
  const token = randomUUID();
  const binding = update(input.sessionId, state => {
    const current = find(input, state, true);
    if (current.pendingNotice && !current.pendingNotice.acknowledged) {
      return fail('routing_notice_pending', 'The routing notice has not been acknowledged.');
    }
    current.lease = token;
    current.leaseOwner = process.pid;
    return current;
  });
  try { return await action(binding); }
  finally {
    update(input.sessionId, state => {
      const current = state.bindings.find(item => item.id === binding.id);
      if (current?.lease === token) {
        delete current.lease;
        delete current.leaseOwner;
      }
    });
  }
}
