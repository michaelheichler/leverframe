export interface CacheTtlEvidence {
  cache_creation_5m_input_tokens?: number;
  cache_creation_1h_input_tokens?: number;
}

export function cacheTtlEvidence(metadata: unknown): CacheTtlEvidence {
  if (!metadata || typeof metadata !== 'object' || !('leverframeCacheUsage' in metadata)) return {};
  const value = metadata.leverframeCacheUsage;
  if (!value || typeof value !== 'object') return {};
  const evidence = value as Record<string, unknown>;
  const valid = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0;
  return {
    ...(valid(evidence.cacheCreation5mInputTokens) ? { cache_creation_5m_input_tokens: evidence.cacheCreation5mInputTokens } : {}),
    ...(valid(evidence.cacheCreation1hInputTokens) ? { cache_creation_1h_input_tokens: evidence.cacheCreation1hInputTokens } : {}),
  };
}
