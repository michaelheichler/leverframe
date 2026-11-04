import { createHash } from 'node:crypto';
import type { RoutingCatalogSnapshot } from './model-routing-catalog.js';
import type { RoutingDecision } from './routing-policy.js';

export const ROUTING_SIGNATURE_VERSION = 'task-sha256-v1';

export function routingSelectorCandidateVersion(input: {
  decision: RoutingDecision; catalog: RoutingCatalogSnapshot; category: string; effort?: string;
}): string {
  const refs = input.decision.ordered.map(candidate => ({ providerId: candidate.ref.providerId, modelId: candidate.ref.modelId }))
    .sort((a, b) => {
      const left = JSON.stringify([a.providerId, a.modelId]);
      const right = JSON.stringify([b.providerId, b.modelId]);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const candidates = refs.map(ref => ({ ref, models: [...new Set(input.catalog.models
    .filter(model => model.ref.providerId === ref.providerId && model.ref.modelId === ref.modelId
      && model.credential.available && model.discovery.confirmed && model.discovery.state === 'current'
      && model.capacity?.available !== false
      && (!input.effort || model.supportedReasoningEfforts?.includes(input.effort)))
    .map(model => JSON.stringify({ upstreamModelId: model.upstreamModelId ?? null,
      capabilities: [...model.confirmedCapabilities].sort(),
      efforts: [...(model.supportedReasoningEfforts ?? [])].sort(),
      contextWindow: model.contextWindowConfirmed ? model.contextWindow ?? null : null })))].sort() }));
  return createHash('sha256').update(JSON.stringify({ schema: 1, policy: input.decision.policy,
    policyVersion: input.decision.policyVersion, signatureVersion: ROUTING_SIGNATURE_VERSION,
    category: input.category, effort: input.effort ?? null, candidates })).digest('hex');
}
