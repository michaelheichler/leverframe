import type { ModelRef, RoutingConfig } from './model-routing.js';
import type { RoutingCatalogModel, RoutingCatalogSnapshot } from './model-routing-catalog.js';
import { estimateWorkload, type RoutingWorkload, type WorkloadEstimate } from './routing-estimate.js';

export type RoutingCapability = 'tools' | 'images' | 'reasoning' | 'promptCache' | 'websocket';
export interface RoutingRequirements { capabilities?: RoutingCapability[]; contextTokens?: number; requireExternalBounds?: true }
export interface RoutingPolicyInput {
  config: RoutingConfig;
  catalog: RoutingCatalogSnapshot;
  role: 'router' | 'specialist';
  category?: string;
  effort?: string;
  arm?: 0 | 1;
  requirements?: RoutingRequirements;
  workload: RoutingWorkload;
}
export interface RoutingEvent { reason: string; target?: ModelRef }
export interface RoutingCandidate { ref: ModelRef; estimate: WorkloadEstimate }
export interface RoutingDecision {
  target: ModelRef;
  effort?: string;
  ordered: RoutingCandidate[];
  estimate: WorkloadEstimate;
  policy: 'execution';
  policyVersion: '1';
  source: 'category' | 'pool' | 'router_floor' | 'router_fallback' | 'selector';
  reason: string;
  events: RoutingEvent[];
}

export function routingCategoryRequirements(config: RoutingConfig, category?: string): RoutingRequirements {
  const configured = category ? config.categories?.[category]?.requirements : undefined;
  return { capabilities: [...new Set<RoutingCapability>(['tools', ...(configured?.capabilities ?? [])])], requireExternalBounds: true,
    ...(configured?.contextTokens === undefined ? {} : { contextTokens: configured.contextTokens }) };
}

export function sameRef(a: ModelRef, b: ModelRef): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

export function eligible(model: RoutingCatalogModel, effort: string | undefined, requirements: RoutingRequirements | undefined): boolean {
  return model.credential.available && model.discovery.state === 'current' && model.discovery.confirmed
    && model.capacity?.available !== false
    && (!effort || !!model.supportedReasoningEfforts?.includes(effort))
    && (requirements?.capabilities ?? []).every(cap => model.confirmedCapabilities.includes(cap) && model.capabilities[cap])
    && (requirements?.requireExternalBounds !== true || model.credential.source === 'claude-code'
      || (model.contextWindowConfirmed && Number.isSafeInteger(model.contextWindow) && model.contextWindow! > 0
        && Number.isSafeInteger(model.maxOutputTokens) && model.maxOutputTokens! > 0))
    && (requirements?.contextTokens === undefined || (model.contextWindowConfirmed && (model.contextWindow ?? 0) >= requirements.contextTokens));
}

function routingError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function resolve(input: RoutingPolicyInput, ref: ModelRef, path: string, effort?: string): RoutingCatalogModel {
  const models = input.catalog.models.filter(model => sameRef(model.ref, ref));
  if (!models.length) throw routingError('routing_unresolved_target', `${path}: ${ref.providerId}/${ref.modelId} is unresolved. Run provider discovery and setup.`);
  const model = models.find(item => eligible(item, effort, input.requirements));
  if (!model) throw routingError('routing_ineligible_target', `${path}: ${ref.providerId}/${ref.modelId} is unavailable or lacks required capability, context, or effort. Check discovery and setup.`);
  return model;
}

export function decideRouting(input: RoutingPolicyInput): RoutingDecision {
  const categoryName = input.role === 'specialist' ? input.category ?? input.config.defaultCategory : undefined;
  const category = categoryName ? input.config.categories?.[categoryName] : undefined;
  if (input.role === 'specialist' && categoryName && !category) throw routingError('routing_invalid_category', `routing.categories.${categoryName} is not configured. Run routing setup.`);
  const arm = category?.alternatingTargets ? input.arm === undefined ? undefined : category.alternatingTargets[input.arm] : undefined;
  if (category?.alternatingTargets && !arm) throw routingError('routing_missing_arm', `routing.categories.${categoryName}.alternatingTargets requires an allocated arm.`);
  const effort = arm?.effort ?? input.effort ?? category?.effort;
  const refs = input.config.pool ?? [];
  const candidates: RoutingCandidate[] = [];
  for (const ref of refs) {
    if (candidates.some(candidate => sameRef(candidate.ref, ref))) continue;
    const model = input.catalog.models.find(item => sameRef(item.ref, ref) && eligible(item, effort, input.requirements));
    if (model) candidates.push({ ref, estimate: estimateWorkload(model.estimate, input.workload) });
  }
  const unknownWorkload = typeof input.workload.input !== 'number' || !Number.isFinite(input.workload.input) || input.workload.input < 0
    || typeof input.workload.output !== 'number' || !Number.isFinite(input.workload.output) || input.workload.output < 0;
  candidates.sort((a, b) => (a.estimate.kind === 'known' ? 0 : 1) - (b.estimate.kind === 'known' ? 0 : 1)
    || (unknownWorkload ? (a.estimate.snapshot.kind === 'known' ? 0 : 1) - (b.estimate.snapshot.kind === 'known' ? 0 : 1) : 0)
    || (a.estimate.amount ?? 0) - (b.estimate.amount ?? 0)
    || a.ref.providerId.localeCompare(b.ref.providerId) || a.ref.modelId.localeCompare(b.ref.modelId));
  let source: RoutingDecision['source'] = 'pool';
  let reason = 'pool_lowest_cost';
  const events: RoutingEvent[] = [];
  let explicit: ModelRef | undefined = input.role === 'specialist' ? arm ?? category?.target : undefined;
  if (input.role === 'router') {
    const floor = input.config.cheapFloor;
    if (floor) {
      const resolved = input.catalog.models.filter(item => sameRef(item.ref, floor));
      if (!resolved.length) resolve(input, floor, 'routing.cheapFloor', effort);
      if (resolved.some(item => eligible(item, effort, input.requirements))) { explicit = floor; source = 'router_floor'; reason = 'router_floor'; }
      else events.push({ reason: 'floor_unavailable', target: floor });
    } else events.push({ reason: 'floor_not_configured' });
    if (!explicit) {
      source = 'router_fallback'; reason = 'router_fallback';
      for (const ref of [input.config.cheapFallback, ...(input.config.routerFallbacks ?? [])]) {
        if (!ref) continue;
        const models = input.catalog.models.filter(item => sameRef(item.ref, ref));
        if (!models.length) resolve(input, ref, 'routing.routerFallbacks', effort);
        if (models.some(item => eligible(item, effort, input.requirements))) { explicit = ref; break; }
        events.push({ reason: 'router_target_unavailable', target: ref });
      }
      if (!explicit) throw routingError('routing_no_eligible_target', 'No eligible router target. Check routing setup.');
    }
  } else if (explicit) { source = 'category'; reason = 'category_target'; }
  let selected = candidates[0];
  if (explicit) {
    let model = resolve(input, explicit, input.role === 'router' ? 'routing.router' : `routing.categories.${categoryName}.target`, effort);
    const preferred = input.config.subscriptionPreference === 'subscription-first' ? 'subscription'
      : input.config.subscriptionPreference === 'api-first' ? 'metered' : undefined;
    if (input.role === 'specialist' && preferred && model.billing.kind !== preferred) {
      for (const alternative of category?.servingAlternatives ?? []) {
        const rows = input.catalog.models.filter(item => sameRef(item.ref, alternative));
        if (!rows.length) resolve(input, alternative, `routing.categories.${categoryName}.servingAlternatives`, effort);
        const match = rows.find(item => !!model.upstreamModelId?.trim() && item.upstreamModelId === model.upstreamModelId
          && eligible(item, effort, input.requirements) && item.billing.kind === preferred);
        if (match) {
          explicit = alternative;
          model = match;
          reason = 'category_billing_preference';
          break;
        }
      }
    }
    selected = { ref: { providerId: explicit.providerId, modelId: explicit.modelId }, estimate: estimateWorkload(model.estimate, input.workload) };
    if (!candidates.some(candidate => sameRef(candidate.ref, explicit!))) candidates.push(selected);
  }
  if (!selected) throw routingError('routing_no_eligible_target', 'No eligible model in routing.pool. Check discovery and setup.');
  if (source === 'pool' && unknownWorkload) {
    reason = 'pool_workload_unknown';
    events.push({ reason: 'workload_unavailable' });
  }
  events.push({ reason, target: selected.ref });
  return { target: selected.ref, effort, ordered: candidates, estimate: selected.estimate, policy: 'execution', policyVersion: '1', source, reason, events };
}
