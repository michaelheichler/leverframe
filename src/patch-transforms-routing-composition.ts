import { applyModelRoutingTransform } from './patch-transforms-model-routing.js';
import { applyMainRoutingTransform } from './patch-transforms-main-routing.js';
import { applyMainRoutingWireGuard } from './patch-transforms-main-wire.js';
import { applyRoutingBoundsTransform } from './patch-transforms-routing-bounds.js';
import { applyRoutingSidecarTransform } from './patch-transforms-routing-sidecar.js';
import { applyRoutingRecoveryTransform } from './patch-transforms-routing-recovery.js';
import { applyRoutingNoticeWriterTransform } from './patch-transforms-routing-notice-writer.js';
import { applyRoutingNoticeFrameTransform } from './patch-transforms-routing-notice-frame.js';
import { applyRoutingNoticeStartupTransform } from './patch-transforms-routing-notice-startup.js';
import { applyRoutingNoticeHostTransform } from './patch-transforms-routing-notice-host.js';
import { applyRoutingAuxiliaryGuardTransform } from './patch-transforms-routing-auxiliary-guard.js';
import type { ApplyPatchesOutcome, PatchScriptModelConfig, PatchScriptModelEntry } from './patch-transforms.js';

export const ROUTING_RECOVERY_ENTRY = '__leverframe_routing_recovery__';

function applyRoutingNoticeComposition(source: string): ApplyPatchesOutcome {
  let content = source;
  const results: ApplyPatchesOutcome['results'] = [];
  for (const apply of [applyRoutingNoticeWriterTransform, applyRoutingNoticeFrameTransform, applyRoutingNoticeStartupTransform,
    applyRoutingNoticeHostTransform, applyRoutingAuxiliaryGuardTransform]) {
    const outcome = apply(content, { enabled: true });
    results.push(...outcome.results);
    if (outcome.results.some(result => result.status === 'FAIL')) return { content: source, results };
    content = outcome.content;
  }
  return { content, results };
}

export function applyRoutingPatchComposition(source: string, visibleModelId: string, entry: PatchScriptModelEntry): ApplyPatchesOutcome {
  if (!entry.routingPolicyModelId) return { content: source, results: [{ name: 'Main router identity', status: 'FAIL', extra: 'routing preflight is unavailable' }] };
  if (entry.routingPolicyModelId.startsWith('leverframe:') && (!entry.routingMetadata?.contextWindow || !entry.routingMetadata.maxOutputTokens)) return { content: source,
    results: [{ name: 'Main router identity', status: 'FAIL', extra: 'confirmed router context and output limits are required' }] };
  const routing = applyModelRoutingTransform(source, { enabled: true, promptPolicy: entry.routingPromptPolicy });
  if (routing.results.some(result => result.status === 'FAIL')) return routing;
  const main = applyMainRoutingTransform(routing.content, { enabled: true, visibleModelId,
    policyModelId: entry.routingPolicyModelId, metadata: entry.routingMetadata, targetMetadata: entry.routingTargetMetadata });
  if (main.results.some(result => result.status === 'FAIL')) return { ...main, content: source };
  const wire = applyMainRoutingWireGuard(main.content, { enabled: true, visibleModelId });
  if (wire.results.some(result => result.status === 'FAIL')) return { ...wire, content: source };
  const bounds = applyRoutingBoundsTransform(wire.content, { enabled: true, visibleModelId });
  if (bounds.results.some(result => result.status === 'FAIL')) return { ...bounds, content: source };
  const sidecar = applyRoutingSidecarTransform(bounds.content, { enabled: true });
  if (sidecar.results.some(result => result.status === 'FAIL')) return { ...sidecar, content: source };
  const notice = applyRoutingNoticeComposition(sidecar.content);
  return { content: notice.results.some(result => result.status === 'FAIL') ? source : notice.content,
    results: [...sidecar.results, ...notice.results] };
}

export function prepareRoutingPatch(source: string, config: PatchScriptModelConfig) {
  const routingModelId = Object.keys(config).find(key => config[key]?.routingEnabled === true);
  const recoveryOnly = config[ROUTING_RECOVERY_ENTRY]?.routingRecoveryOnly === true;
  if (recoveryOnly && routingModelId) throw new Error('Routing recovery and active routing cannot be patched together.');
  if (recoveryOnly && Object.keys(config[ROUTING_RECOVERY_ENTRY]!).some(key => key !== 'routingRecoveryOnly')) {
    throw new Error('Routing recovery config conflicts with a model name.');
  }
  const modelConfig = recoveryOnly ? Object.fromEntries(Object.entries(config).filter(([key]) => key !== ROUTING_RECOVERY_ENTRY)) : config;
  if (recoveryOnly) {
    const recovery = applyRoutingRecoveryTransform(source, { enabled: true });
    const notice = recovery.results.some(result => result.status === 'FAIL') ? recovery : applyRoutingNoticeComposition(recovery.content);
    const outcome = { content: notice.results.some(result => result.status === 'FAIL') ? source : notice.content,
      results: notice === recovery ? recovery.results : [...recovery.results, ...notice.results] };
    return { ...outcome, config: modelConfig, routingModelId, done: outcome.results.some(result => result.status === 'FAIL')
      || Object.keys(modelConfig).length === 0 };
  }
  if (routingModelId) {
    const outcome = applyRoutingPatchComposition(source, routingModelId, config[routingModelId]!);
    return { content: outcome.content, results: outcome.results.some(result => result.status === 'FAIL') ? outcome.results : [],
      config: modelConfig, routingModelId, done: outcome.results.some(result => result.status === 'FAIL') };
  }
  return { content: source, results: [], config: modelConfig, routingModelId, done: false };
}
