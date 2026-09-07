

import { loadRegistry } from './registry/io.js';
import type { CachedModel } from './registry/types.js';

export interface ContextCeilingCandidate {
  modelId: string;
  providerId: string;
  providerName: string;

  contextWindow: number;

  maxContextWindow: number;
}

export function modelContextCeiling(model: CachedModel): number | undefined {
  const max = model.maxContextWindow;
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return undefined;
  const current = model.contextWindow;
  if (typeof current === 'number' && current > 0 && max <= current) return undefined;
  return max;
}

export function contextCeilingCandidates(): ContextCeilingCandidate[] {
  const candidates: ContextCeilingCandidate[] = [];
  for (const provider of loadRegistry().providers) {
    for (const model of provider.modelsCache?.models ?? []) {
      const ceiling = modelContextCeiling(model);
      if (ceiling === undefined) continue;
      candidates.push({
        modelId: model.id,
        providerId: provider.id,
        providerName: provider.name,
        contextWindow: model.contextWindow ?? 0,
        maxContextWindow: ceiling,
      });
    }
  }
  return candidates;
}

export function findContextCeilingCandidate(modelId: string): ContextCeilingCandidate | undefined {
  const wanted = modelId.trim().toLowerCase();
  return contextCeilingCandidates().find(entry => entry.modelId.toLowerCase() === wanted);
}

export function resolveContextCeilingOverride(
  model: CachedModel,
  enabledIds: readonly string[] | undefined,
): number | undefined {
  if (!enabledIds || enabledIds.length === 0) return undefined;
  const wanted = model.id.toLowerCase();
  if (!enabledIds.some(id => id.toLowerCase() === wanted)) return undefined;
  return modelContextCeiling(model);
}
