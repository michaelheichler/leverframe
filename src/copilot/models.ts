/** Failures are tagged to prevent silent stale use. */
import type { CachedModel, ModelDiscoveryFailureKind } from '../registry/types.js';
import {
  CopilotModelValidationError,
  isChatRecord,
  mapCopilotModels,
  parseCopilotModelInfo,
} from './model-metadata.js';

export { mapCopilotModels, parseCopilotModelInfo };
export type CopilotModelFailureKind = ModelDiscoveryFailureKind;

/** Kinds differ because catalogs can be empty or denied. */
class CopilotModelDiscoveryError extends Error {
  readonly kind: CopilotModelFailureKind;

  /** Names matter because diagnostics print the error type. */
  constructor(kind: CopilotModelFailureKind, message: string) {
    super(message);
    this.name = 'CopilotModelDiscoveryError';
    this.kind = kind;
  }
}

/** Causes matter because HTTP errors may be wrapped. */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

/** Failure kinds stay stable to support saved caches. */
export function classifyCopilotModelFailure(error: unknown): CopilotModelFailureKind {
  const chain = errorChain(error);
  const discovery = chain.find(entry => entry instanceof CopilotModelDiscoveryError);
  if (discovery instanceof CopilotModelDiscoveryError) return discovery.kind;
  if (chain.some(entry => entry instanceof CopilotModelValidationError)) return 'schema';
  const messages = chain.map(entry => entry instanceof Error ? entry.message : String(entry));
  if (messages.some(message => /\b401\b|\b403\b|unauthori[sz]ed|forbidden|authentication|access token|subscription|entitlement|eligible/i.test(message))) {
    return 'authentication';
  }
  return 'runtime';
}

export type CopilotModelRefreshResult =
  | { models: CachedModel[]; source: 'live' }
  | { models: CachedModel[]; source: 'cache'; failureReason: string; failureKind: CopilotModelFailureKind };

/** Cache results are marked to prevent silent stale reuse. */
export async function refreshCopilotModels(input: {
  listModels: () => Promise<unknown>;
  cachedModels: CachedModel[];
}): Promise<CopilotModelRefreshResult> {
  try {
    const records = await input.listModels();
    const recordCount = Array.isArray(records) ? records.filter(isChatRecord).length : 0;
    const models = mapCopilotModels(records);
    if (models.length === 0 && recordCount > 0) {
      throw new CopilotModelDiscoveryError('policy', 'Copilot model discovery returned no policy-enabled models');
    }
    if (models.length === 0) {
      throw new CopilotModelDiscoveryError('empty', 'Copilot model discovery returned no models');
    }
    return { models, source: 'live' };
  } catch (error) {
    if (input.cachedModels.length === 0) throw error;
    return {
      models: input.cachedModels,
      source: 'cache',
      failureReason: error instanceof Error ? error.message : String(error),
      failureKind: classifyCopilotModelFailure(error),
    };
  }
}
