import { UnstableCredentialSnapshotError } from '../credential-store.js';
import {
  resolveProviderCredential,
  resolveProviderOAuthAccountId,
  resolveProviderOAuthProviderData,
  resolveStoredProviderCredential,
} from '../env.js';
import type { CompatibilityAgent } from '../model-compatibility.js';
import type { LocalProvider } from '../types.js';
import { materializeRegistry } from './materialize.js';
import { loadRegistry } from './io.js';

export async function loadRegistryProviders(
  diag?: (msg: string) => void,
  opts?: { agent?: CompatibilityAgent },
): Promise<LocalProvider[]> {
  const registry = loadRegistry();
  const keys = new Map<string, string>();
  const oauthAccountIds = new Map<string, string>();
  const oauthProviderData = new Map<string, Record<string, unknown>>();
  for (const provider of registry.providers) {
    try {
      const key = await resolveProviderCredential(provider.id, provider.authRef, diag);
      if (key) keys.set(provider.id, key);
    } catch (err) {
      diag?.(`${provider.id}: credential unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (provider.authType === 'oauth') {
      try {
        const accountId = await resolveProviderOAuthAccountId(provider.authRef, diag);
        if (accountId) oauthAccountIds.set(provider.id, accountId);
        const pd = await resolveProviderOAuthProviderData(provider.authRef, diag);
        if (pd) oauthProviderData.set(provider.id, pd);
      } catch {
      }
    }
  }
  return materializeRegistry(registry, provider => keys.get(provider.id) ?? null, opts)
    .map(provider => ({
      ...provider,
      oauthAccountId: oauthAccountIds.get(provider.id),
      providerData: oauthProviderData.get(provider.id),
    }));
}

export interface StoredRegistryCatalog {
  providers: LocalProvider[];
  refreshDue: string[];
  unstable: string[];
}

/** Because patch diagnostics must stay read-only and network-free. */
export async function loadStoredRegistryProviders(
  opts?: { agent?: CompatibilityAgent },
): Promise<StoredRegistryCatalog> {
  const registry = loadRegistry();
  const keys = new Map<string, string>();
  const refreshDue: string[] = [];
  const unstable: string[] = [];
  for (const provider of registry.providers) {
    const stored = await resolveStoredProviderCredential(provider.id, provider.authRef)
      .catch((error: unknown) => {
        if (error instanceof UnstableCredentialSnapshotError) unstable.push(provider.id);
        return { value: null, refreshDue: false };
      });
    if (stored.value) keys.set(provider.id, stored.value);
    if (stored.refreshDue) refreshDue.push(provider.id);
  }
  const providers = materializeRegistry(registry, provider => keys.get(provider.id) ?? null, opts);
  return { providers, refreshDue, unstable };
}

export function loadRegistryProvidersSync(
  resolveKey: (providerId: string, authRef: string) => string | null,
  opts?: { agent?: CompatibilityAgent },
): LocalProvider[] {
  const registry = loadRegistry();
  return materializeRegistry(registry, provider => resolveKey(provider.id, provider.authRef), opts);
}
