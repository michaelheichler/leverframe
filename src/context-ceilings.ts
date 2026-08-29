// src/context-ceilings.ts — opt-in maximum context windows.
//
// Some providers report two different windows for the same model: the tuned
// default they serve by default, and the maximum that model actually accepts.
// ChatGPT/Codex is the clear case, its models endpoint returns both
// `context_window` and `max_context_window`, and the gap between them is large
// (272000 against 872000 on the account this was verified with).
//
// The ceiling is read from that live provider metadata, never from a bundled
// constant, because it varies by account entitlement: the same models carry a
// different maximum in GitHub Copilot's catalog than over ChatGPT OAuth. A
// hardcoded number would be wrong for somebody.
//
// Opting in stays explicit, because the provider's lower default is a
// deliberate cost and performance choice, and a larger window is usually billed
// at a higher long-context rate.

import { loadRegistry } from './registry/io.js';
import type { CachedModel } from './registry/types.js';

export interface ContextCeilingCandidate {
  modelId: string;
  providerId: string;
  providerName: string;
  /** Window the provider serves by default. */
  contextWindow: number;
  /** Maximum the provider reports for the same model. */
  maxContextWindow: number;
}

/** A model offers a ceiling only when its reported maximum exceeds its default. */
export function modelContextCeiling(model: CachedModel): number | undefined {
  const max = model.maxContextWindow;
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return undefined;
  const current = model.contextWindow;
  if (typeof current === 'number' && current > 0 && max <= current) return undefined;
  return max;
}

/** Every model whose provider reports a maximum above the window it serves. */
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

/**
 * The live maximum for `model`, but only when the user opted that model in.
 * Returns undefined otherwise, so callers keep the window the provider serves.
 */
export function resolveContextCeilingOverride(
  model: CachedModel,
  enabledIds: readonly string[] | undefined,
): number | undefined {
  if (!enabledIds || enabledIds.length === 0) return undefined;
  const wanted = model.id.toLowerCase();
  if (!enabledIds.some(id => id.toLowerCase() === wanted)) return undefined;
  return modelContextCeiling(model);
}
