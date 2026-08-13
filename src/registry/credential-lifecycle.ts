import { deleteProviderCredential } from '../env.js';
import {
  cancelCredentialDelete,
  isStoredCredentialRef,
  loadPendingCredentialDeletes,
  queueCredentialDelete,
} from './credential-cleanup-journal.js';
import { loadRegistryStrict } from './io.js';
import { withCredentialMutationLock, withRegistryWriteLock } from './lock.js';
import type { ProviderRegistry } from './types.js';

export { cancelCredentialDelete, queueCredentialDelete } from './credential-cleanup-journal.js';

export interface CredentialCleanupResult {
  deleted: string[];
  pending: string[];
  persistenceError?: string;
}

const warnedFailures = new Set<string>();

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warnOnce(key: string, text: string, diag?: (message: string) => void): void {
  if (warnedFailures.has(key)) return;
  warnedFailures.add(key);
  if (diag) diag(text);
  else console.warn(`leverframe: ${text}`);
}

export function credentialIsReferenced(registry: ProviderRegistry, authRef: string): boolean {
  return registry.providers.some(provider => provider.authRef === authRef);
}

/** Persist cleanup intent before a registry mutation can orphan this reference. */
export async function journalCredentialWrite(authRef: string): Promise<void> {
  if (!await queueCredentialDelete(authRef)) {
    throw new Error('Credential reference is not managed by Leverframe.');
  }
}

interface SingleCleanupResult {
  deleted: boolean;
  cleared: boolean;
  error?: string;
}

/** Reconcile outside the registry lock, under a lock scoped to this reference. */
async function reconcileOne(authRef: string): Promise<SingleCleanupResult> {
  if (!isStoredCredentialRef(authRef)) {
    try {
      await cancelCredentialDelete(authRef);
      return { deleted: false, cleared: true };
    } catch (error) {
      return { deleted: false, cleared: false, error: message(error) };
    }
  }

  try {
    return await withCredentialMutationLock(authRef, async () => {
      // Strictly re-read under the registry lock immediately before deletion.
      try {
        const activeAgain = await withRegistryWriteLock(async () => {
          const active = credentialIsReferenced(loadRegistryStrict(), authRef);
          if (active) await cancelCredentialDelete(authRef);
          return active;
        });
        if (activeAgain) return { deleted: false, cleared: true };
      } catch (error) {
        return { deleted: false, cleared: false, error: message(error) };
      }

      let deleted = false;
      let deletionError: string | undefined;
      let backendError: string | undefined;
      try {
        deleted = await deleteProviderCredential(authRef, diagnostic => { backendError = diagnostic; });
      } catch (error) {
        deletionError = message(error);
      }
      if (!deleted) {
        return {
          deleted: false,
          cleared: false,
          error: deletionError ?? backendError ?? 'credential deletion could not be confirmed',
        };
      }

      try {
        await cancelCredentialDelete(authRef);
        return { deleted: true, cleared: true };
      } catch (error) {
        return { deleted: true, cleared: false, error: message(error) };
      }
    });
  } catch (error) {
    return { deleted: false, cleared: false, error: message(error) };
  }
}

/** Restart-safe, sequential and idempotent cleanup reconciliation. */
export async function reconcilePendingCredentialDeletes(
  diag?: (message: string) => void,
): Promise<CredentialCleanupResult> {
  let queued: string[];
  try {
    queued = await loadPendingCredentialDeletes();
  } catch (error) {
    const persistenceError = `Could not read pending credential cleanup: ${message(error)}`;
    warnOnce(persistenceError, persistenceError, diag);
    return { deleted: [], pending: [], persistenceError };
  }

  const knownPending = new Set(queued);
  const deleted: string[] = [];
  const errors: Array<{ key: string; text: string }> = [];
  const resolvedReferences = new Set<string>();
  for (const authRef of queued) {
    const result = await reconcileOne(authRef);
    if (result.deleted) deleted.push(authRef);
    if (result.cleared) {
      knownPending.delete(authRef);
      resolvedReferences.add(authRef);
    }
    if (result.error) {
      errors.push({
        key: `${authRef}\0${result.error}`,
        text: `Cleanup for ${authRef}: ${result.error}`,
      });
    }
  }

  let pending = [...knownPending];
  try {
    pending = await loadPendingCredentialDeletes();
  } catch (error) {
    const text = `Could not confirm pending credential cleanup: ${message(error)}`;
    errors.push({ key: text, text });
  }
  const persistenceError = errors.length > 0 ? errors.map(error => error.text).join('; ') : undefined;
  for (const authRef of resolvedReferences) {
    for (const key of warnedFailures) {
      if (key.startsWith(`${authRef}\0`)) warnedFailures.delete(key);
    }
  }
  for (const error of errors) warnOnce(error.key, error.text, diag);
  return {
    deleted,
    pending,
    ...(persistenceError ? { persistenceError } : {}),
  };
}

export const _credentialLifecycleInternals = {
  resetWarningsForTests(): void {
    warnedFailures.clear();
  },
};
