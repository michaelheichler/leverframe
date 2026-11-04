import { recordRoutingRequestEstimate, type RoutingBinding } from './routing-bindings.js';
import type { RoutingCatalogSnapshot } from './model-routing-catalog.js';
import { estimateWorkload, type WorkloadEstimate } from './routing-estimate.js';

function requestEstimateEvidence(body: Record<string, unknown>): { inputBytes: number; maxOutputTokens: number; cacheUsageUnknown: boolean } | undefined {
  const maxOutputTokens = body['max_tokens'];
  if (typeof maxOutputTokens !== 'number' || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) return undefined;
  const serialized = JSON.stringify(body);
  return { inputBytes: Buffer.byteLength(serialized), maxOutputTokens, cacheUsageUnknown: serialized.includes('"cache_control":') };
}

export function estimateCurrentRoutingRequest(binding: RoutingBinding, body: Record<string, unknown>): WorkloadEstimate {
  const snapshot = binding.decision.estimate.snapshot;
  let evidence: ReturnType<typeof requestEstimateEvidence>;
  try { evidence = requestEstimateEvidence(body); } catch { return { kind: 'unknown', snapshot }; }
  return !evidence || evidence.cacheUsageUnknown ? { kind: 'unknown', snapshot }
    : estimateWorkload(snapshot, { input: evidence.inputBytes, output: evidence.maxOutputTokens });
}

export async function recordFirstRoutingRequest(binding: RoutingBinding, body: Record<string, unknown>, catalog: RoutingCatalogSnapshot): Promise<void> {
  if (!binding.lease) return;
  const evidence = requestEstimateEvidence(body);
  if (!evidence) return;
  await recordRoutingRequestEstimate({ sessionId: binding.sessionId, modelId: binding.modelId, leaseId: binding.lease,
    ...evidence, catalog });
}
