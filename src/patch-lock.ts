

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

export function tryAcquirePatchTargetLock(
  identity: string,
  options: Pick<RegistryLockOptions, 'now' | 'isAlive'> = {},
): RegistryLockLease | null {
  return tryAcquireRegistryLock(getPatchTargetLockPath(identity), options);
}

export function withPatchTargetLock<T>(
  identity: string,
  operation: () => Promise<T> | T,
  options: RegistryLockOptions = {},
): Promise<T> {
  return withRegistryWriteLock(operation, { ...options, lockPath: getPatchTargetLockPath(identity) });
}
