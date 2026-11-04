import type { ModelRef, RoutingConfig } from './model-routing.js';
import type { RoutingCatalogSnapshot } from './model-routing-catalog.js';
import { estimateWorkload, type RoutingWorkload } from './routing-estimate.js';
import { decideRouting, sameRef, type RoutingDecision, type RoutingRequirements } from './routing-policy.js';
import type { SelectorTrace } from './routing-selector-log.js';

export interface SelectorFeatures {
  size: 'small' | 'medium' | 'large';
  turns: 'few' | 'many';
  tools: 'none' | 'few' | 'many';
  recentFailures: number;
}
export interface SelectorInput {
  decision: RoutingDecision;
  config: RoutingConfig;
  catalog: RoutingCatalogSnapshot;
  category: string;
  effort?: string;
  requirements?: RoutingRequirements;
  features: SelectorFeatures;
  taskSignature: string;
  candidateSetVersion: string;
  signatureVersion: string;
  jobId: string;
  deadline?: number;
  selectorWorkload: RoutingWorkload;
}
export interface SelectorPayload {
  category: string;
  effort?: string;
  requirements?: RoutingRequirements;
  features: SelectorFeatures;
  taskSignature: string;
  candidates: { ref: ModelRef; amount: number }[];
  maxOutputTokens: number;
}
export interface SelectorDependencies {
  now: () => number;
  call: (target: ModelRef, payload: SelectorPayload, signal: AbortSignal, context?: SelectorCallContext, trace?: SelectorTrace) => Promise<ModelRef>;
  beforeCall?: () => boolean;
  cache: Map<string, Promise<ModelRef | undefined>>;
  reserveCall: (jobId: string, limit: number) => boolean | Promise<boolean>;
}
export interface SelectorCallContext { sessionId: string; consumerId: string; connectionId: string; signal: AbortSignal }

export const selectorReasons = {
  timeout: 'selector_timeout', invalidResult: 'selector_invalid_result', callCap: 'selector_call_cap',
  transportFailure: 'selector_transport_failure', skippedNoMeasuredBenefit: 'selector_skipped_no_measured_benefit',
  cacheHit: 'selector_cache_hit', selected: 'selector_selected', invalidSignature: 'selector_invalid_signature',
  noticeUnavailable: 'selector_notice_unavailable',
} as const;

export function routingSelectorTargets(config: RoutingConfig, catalog: RoutingCatalogSnapshot, workload: RoutingWorkload): ModelRef[] {
  const options = config.selector;
  if (!options?.enabled) return [];
  let primary = options.target;
  if (!primary) {
    try { primary = decideRouting({ config, catalog, role: 'router', workload }).target; }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'routing_unresolved_target') throw error;
      primary = undefined;
    }
  }
  const targets: ModelRef[] = [];
  for (const ref of [primary, ...(options.fallbacks ?? [])]) {
    if (ref && !targets.some(target => sameRef(target, ref))) targets.push({ providerId: ref.providerId, modelId: ref.modelId });
  }
  return targets;
}

function result(input: SelectorInput, reason: string, target?: ModelRef): RoutingDecision {
  const candidate = target && input.decision.ordered.find(item => sameRef(item.ref, target));
  return { ...input.decision, ...(candidate ? { target: candidate.ref, estimate: candidate.estimate, source: 'selector' as const } : {}),
    reason, events: [...input.decision.events, { reason, ...(target ? { target } : {}) }] };
}

function evidenceAllows(input: SelectorInput, target: ModelRef, now: number): boolean {
  if (input.selectorWorkload.output === undefined) return false;
  const profile = input.config.selector?.evaluationEvidence?.find(item => item.category === input.category && item.effort === input.effort
    && item.candidateSetVersion === input.candidateSetVersion && item.signatureVersion === input.signatureVersion
    && Number.isSafeInteger(item.sampleSize) && item.sampleSize > 0 && !!item.sourceEvaluationId
    && Number.isFinite(Date.parse(item.measuredAt)) && Date.parse(item.measuredAt) <= now
    && Number.isFinite(Date.parse(item.expiresAt)) && Date.parse(item.expiresAt) > now);
  if (!profile) return false;
  const selectorModel = input.catalog.models.find(model => sameRef(model.ref, target) && model.credential.available
    && model.discovery.confirmed && model.discovery.state === 'current' && model.capacity?.available !== false);
  if (!selectorModel) return false;
  const cost = estimateWorkload(selectorModel.estimate, { ...input.selectorWorkload,
    output: Math.max(input.selectorWorkload.output, input.config.selector?.maxOutputTokens ?? 128) });
  if (cost.kind !== 'known') return false;
  const avoided = profile.avoidedTokens;
  const workload = { input: avoided.input ?? 0, output: avoided.output ?? 0, cacheRead: avoided.cacheRead, cacheWrite: avoided.cacheWrite };
  const savings = input.decision.ordered.filter(item => item.estimate.kind === 'known').map(item => {
    const model = input.catalog.models.find(entry => sameRef(entry.ref, item.ref));
    return model ? estimateWorkload(model.estimate, workload) : undefined;
  });
  return savings.length > 0 && savings.every(item => item?.kind === 'known' && item.amount! > cost.amount!);
}

export async function selectRoutingTie(input: SelectorInput, dependencies: SelectorDependencies): Promise<RoutingDecision> {
  const options = input.config.selector;
  const first = input.decision.ordered[0];
  const tolerance = input.config.costTierTolerance ?? 0;
  const tier = first?.estimate.kind === 'known' ? input.decision.ordered.filter(item => item.estimate.kind === 'known'
    && item.estimate.amount! <= first.estimate.amount! * (1 + tolerance)) : [];
  if (!options?.enabled || input.decision.source !== 'pool' || tier.length < 2) return input.decision;
  const validCapabilities = ['tools', 'images', 'reasoning', 'promptCache', 'websocket'];
  if (!/^[a-f0-9]{64}$/.test(input.taskSignature)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(input.category)
    || (input.effort !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(input.effort))
    || !['small', 'medium', 'large'].includes(input.features.size)
    || !['few', 'many'].includes(input.features.turns) || !['none', 'few', 'many'].includes(input.features.tools)
    || (input.requirements?.capabilities ?? []).some(cap => !validCapabilities.includes(cap))
    || !Number.isSafeInteger(input.features.recentFailures)
    || input.features.recentFailures < 0 || input.features.recentFailures > 1000) return result(input, selectorReasons.invalidSignature);
  let targets: ModelRef[];
  try { targets = routingSelectorTargets(input.config, input.catalog, input.selectorWorkload); }
  catch { return result(input, selectorReasons.transportFailure); }
  const now = dependencies.now();
  const qualified = targets.filter(target => evidenceAllows(input, target, now));
  if (!qualified.length) return result(input, selectorReasons.skippedNoMeasuredBenefit);
  const timeout = Math.min(options.timeoutMs ?? 1500, input.deadline === undefined ? Infinity : input.deadline - now);
  if (!Number.isFinite(timeout) || timeout <= 0) return result(input, selectorReasons.timeout);
  const payload: SelectorPayload = { category: input.category, effort: input.effort,
    requirements: input.requirements ? { capabilities: input.requirements.capabilities, contextTokens: input.requirements.contextTokens } : undefined,
    features: { size: input.features.size, turns: input.features.turns, tools: input.features.tools, recentFailures: input.features.recentFailures },
    taskSignature: input.taskSignature,
    candidates: tier.map(item => ({ ref: { providerId: item.ref.providerId, modelId: item.ref.modelId }, amount: item.estimate.amount! })), maxOutputTokens: options.maxOutputTokens ?? 128 };
  const key = JSON.stringify({ payload, candidateSetVersion: input.candidateSetVersion, signatureVersion: input.signatureVersion,
    config: input.config, prices: input.catalog.models.map(model => ({ ref: model.ref, estimate: model.estimate })) });
  const cached = dependencies.cache.get(key);
  if (cached) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([cached.then(selected => ({ selected, timedOut: false })), new Promise<{ selected: undefined; timedOut: true }>(resolve => {
        timer = setTimeout(() => resolve({ selected: undefined, timedOut: true }), timeout);
      })]);
      return outcome.selected ? result(input, selectorReasons.cacheHit, outcome.selected)
        : result(input, outcome.timedOut ? selectorReasons.timeout : selectorReasons.transportFailure);
    } catch {
      return result(input, selectorReasons.transportFailure);
    } finally { if (timer) clearTimeout(timer); }
  }
  let failure: string = selectorReasons.transportFailure;
  const run = async (): Promise<ModelRef | undefined> => {
    const end = now + timeout;
    for (const target of qualified) {
      if (dependencies.beforeCall && !dependencies.beforeCall()) { failure = selectorReasons.noticeUnavailable; return undefined; }
      if (!await dependencies.reserveCall(input.jobId, options.maxExtraCallsPerTask ?? 1)) { failure = selectorReasons.callCap; return undefined; }
      const remaining = end - dependencies.now();
      if (remaining <= 0) { failure = selectorReasons.timeout; return undefined; }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const selected = await Promise.race([dependencies.call(target, payload, controller.signal), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, remaining);
        })]);
        if (tier.some(item => selected && sameRef(item.ref, selected))) return selected;
        failure = selectorReasons.invalidResult;
      } catch {
        failure = controller.signal.aborted ? selectorReasons.timeout : selectorReasons.transportFailure;
      } finally { if (timer) clearTimeout(timer); }
      if (failure === selectorReasons.timeout || failure === selectorReasons.invalidResult) break;
    }
    return undefined;
  };
  const pending = run();
  dependencies.cache.set(key, pending);
  try {
    const selected = await pending;
    if (!selected) dependencies.cache.delete(key);
    return selected ? result(input, selectorReasons.selected, selected) : result(input, failure);
  } catch {
    dependencies.cache.delete(key);
    return result(input, selectorReasons.transportFailure);
  }
}
