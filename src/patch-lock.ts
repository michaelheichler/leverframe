// src/patch-lock.ts — per-target patch lock.
//
// Reuses the token-owned lock primitive from src/registry/lock.ts (its
// acquisition already never evicts a live PID's lock purely by age, and its
// release only removes a lock the caller's own token still owns). Scoping the
// lock path by installation identity keeps two different Claude Code targets
// from blocking each other.

import { getPatchLockPathV2 } from './patch-state.js';
import {
  tryAcquireRegistryLock,
  withRegistryWriteLock,
  type RegistryLockLease,
  type RegistryLockOptions,
} from './registry/lock.js';

export type { RegistryLockLease as PatchLockLease };

export function getPatchTargetLockPath(identity: string): string {
  return getPatchLockPathV2(identity);
}

/** Non-blocking acquire: returns null immediately if another live owner holds the lock. */
export function tryAcquirePatchTargetLock(
  identity: string,
  options: Pick<RegistryLockOptions, 'now' | 'isAlive'> = {},
): RegistryLockLease | null {
  return tryAcquireRegistryLock(getPatchTargetLockPath(identity), options);
}

/** Run `operation` while holding the per-target patch lock, waiting up to `waitMs`. */
export function withPatchTargetLock<T>(
  identity: string,
  operation: () => Promise<T> | T,
  options: RegistryLockOptions = {},
): Promise<T> {
  return withRegistryWriteLock(operation, { ...options, lockPath: getPatchTargetLockPath(identity) });
}
