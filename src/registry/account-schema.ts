import { normalizeAccountTag, validateAccountName } from '../account-identity.js';
import type { RegistryAccount } from './types.js';

export function parseAccountMetadata(raw: Record<string, unknown>): Partial<RegistryAccount> | null {
  try {
    const metadata: Partial<RegistryAccount> = {};
    if (raw.name !== undefined) {
      if (typeof raw.name !== 'string') return null;
      metadata.name = validateAccountName(raw.name);
    }
    if (raw.tag !== undefined) {
      if (typeof raw.tag !== 'string') return null;
      metadata.tag = normalizeAccountTag(raw.tag);
    }
    const cache = raw.modelsCache as Record<string, unknown> | undefined;
    if (cache !== undefined) {
      if (!cache || typeof cache !== 'object' || typeof cache.fetchedAt !== 'string' || !Array.isArray(cache.models)) return null;
      metadata.modelsCache = {
        fetchedAt: cache.fetchedAt,
        models: cache.models.filter(model => model && typeof model === 'object' && !Array.isArray(model)),
        ...(typeof cache.oauthAccountId === 'string' ? { oauthAccountId: cache.oauthAccountId } : {}),
      };
    }
    if (typeof raw.modelDiscoveryError === 'string') metadata.modelDiscoveryError = raw.modelDiscoveryError;
    if (typeof raw.modelDiscoveryGeneration === 'string') metadata.modelDiscoveryGeneration = raw.modelDiscoveryGeneration;
    return metadata;
  } catch {
    return null;
  }
}
