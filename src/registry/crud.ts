// src/registry/crud.ts — serialized provider mutations with crash-safe credential cleanup

import { parseAuthRef } from '../env.js';
import {
  credentialIsReferenced,
  journalCredentialWrite,
  reconcilePendingCredentialDeletes,
} from './credential-lifecycle.js';
import { updateRegistry, updateRegistryAsync } from './io.js';
import type { RegistryProvider } from './types.js';

export interface RemoveProviderResult {
  removed: boolean;
  id: string;
  name?: string;
  credentialDeleted: boolean;
  error?: string;
}

function storedRef(provider: RegistryProvider): string | null {
  const parsed = parseAuthRef(provider.authRef);
  return parsed?.kind === 'keyring' ? provider.authRef : null;
}

/** Queue before orphaning, commit under lock, then reconcile outside it. */
export async function removeProviderFromRegistry(
  id: string,
  opts?: { deleteCredential?: boolean },
): Promise<RemoveProviderResult> {
  let removedProvider: RegistryProvider | undefined;
  let queuedRef: string | null = null;
  let mutation = false;
  let cleanup: Awaited<ReturnType<typeof reconcilePendingCredentialDeletes>>;
  try {
    mutation = await updateRegistryAsync(async registry => {
      const index = registry.providers.findIndex(provider => provider.id === id);
      if (index < 0) return false;
      removedProvider = registry.providers[index];
      if (opts?.deleteCredential !== false) {
        const candidate = storedRef(removedProvider);
        const remaining = registry.providers.filter((_, candidateIndex) => candidateIndex !== index);
        if (candidate && !credentialIsReferenced({ ...registry, providers: remaining }, candidate)) {
          await journalCredentialWrite(candidate);
          queuedRef = candidate;
        }
      }
      registry.providers.splice(index, 1);
      return true;
    });
  } finally {
    // A failed registry publication leaves the queued reference active; the
    // strict re-read in reconciliation cancels it rather than deleting it.
    cleanup = await reconcilePendingCredentialDeletes();
  }
  if (!mutation || !removedProvider) {
    return { removed: false, id, credentialDeleted: false, error: `Provider not found: ${id}` };
  }


  return {
    removed: true,
    id,
    name: removedProvider.name,
    credentialDeleted: queuedRef !== null && cleanup.deleted.includes(queuedRef),
    ...(cleanup.persistenceError ? { error: cleanup.persistenceError } : {}),
  };
}

export function toggleProviderEnabled(id: string): { toggled: boolean; enabled?: boolean; error?: string } {
  try {
    return updateRegistry(registry => {
      const provider = registry.providers.find(candidate => candidate.id === id);
      if (!provider) return { toggled: false, error: `Provider not found: ${id}` };
      provider.enabled = !provider.enabled;
      return { toggled: true, enabled: provider.enabled };
    });
  } finally {
    void reconcilePendingCredentialDeletes();
  }
}
