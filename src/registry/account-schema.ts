import { normalizeAccountTag, validateAccountName } from '../account-identity.js';
import type { RegistryAccount } from './types.js';

export function parseAccountMetadata(raw: Record<string, unknown>): Partial<RegistryAccount> | null {
  try {
    const metadata: Partial<RegistryAccount> = {};
    if (raw.billing !== undefined) {
      if (!raw.billing || typeof raw.billing !== 'object' || Array.isArray(raw.billing)) return null;
      const billing = raw.billing as Record<string, unknown>;
      if ((billing.kind !== 'metered' && billing.kind !== 'subscription' && billing.kind !== 'none' && billing.kind !== 'unknown')
        || typeof billing.source !== 'string' || !billing.source
        || typeof billing.observedAt !== 'string' || !billing.observedAt) return null;
      metadata.billing = { kind: billing.kind, source: billing.source, observedAt: billing.observedAt };
    }
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
        ...(cache.source === 'harness' || cache.source === 'account' ? { source: cache.source } : {}),
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
