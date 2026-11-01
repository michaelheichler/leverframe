import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJsonSync } from './atomic-file.js';
import { getAppHome } from './paths.js';
import { assertRegistryWriteOwnership, withRegistryWriteLock } from './registry/lock.js';
import type { CapacityObservation, PoolKey, Reservation } from './account-pool.js';

export interface StoredObservation extends CapacityObservation {
  probeAfter?: number;
}

export interface PoolState {
  observations: Record<string, StoredObservation>;
  memberships: Record<string, string[]>;
  reservations: Array<Reservation & { pool: string; probeKeys?: string[] }>;
  affinity: Record<string, { accountId: string; usedAt: number }>;
  rotations: Record<string, { next: number; usedAt: number }>;
  accounts: Record<string, string[]>;
  generations?: Record<string, string>;
}

export const key = (...parts: string[]): string => JSON.stringify(parts);
export const poolKey = (pool: PoolKey): string => key(pool.providerId, pool.billingType, pool.modelId);
export const providerKey = (pool: PoolKey): string => key(pool.providerId, pool.billingType);
export const sessionKey = (pool: PoolKey, session: string): string =>
  createHash('sha256').update(key(poolKey(pool), session)).digest('hex');

function emptyState(): PoolState {
  return { observations: {}, memberships: {}, reservations: [], affinity: {}, rotations: {}, accounts: {} };
}

function readState(path: string): PoolState {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as PoolState;
    if (!state || !state.observations || !state.memberships || !Array.isArray(state.reservations)
      || !state.affinity || !state.rotations || !state.accounts) throw new Error('Invalid account pool state');
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }
}

export async function updatePoolState<T>(path: string | undefined, now: number, update: (state: PoolState) => T): Promise<T> {
  const statePath = path ?? join(getAppHome(), 'account-pool-state.json');
  return withRegistryWriteLock(() => {
    const state = readState(statePath);
    state.reservations = state.reservations.filter(reservation => reservation.expiresAt > now);
    const result = update(state);
    const affinity = Object.entries(state.affinity).sort((a, b) => b[1].usedAt - a[1].usedAt).slice(0, 2048);
    state.affinity = Object.fromEntries(affinity);
    const rotations = Object.entries(state.rotations).sort((a, b) => b[1].usedAt - a[1].usedAt).slice(0, 1024);
    state.rotations = Object.fromEntries(rotations);
    if (state.reservations.length > 4096) throw new Error('Too many active account reservations');
    if (Object.keys(state.observations).length > 8192 || Object.keys(state.memberships).length > 4096
      || Object.keys(state.accounts).length > 1024) throw new Error('Account pool state limit exceeded');
    assertRegistryWriteOwnership(statePath);
    atomicWriteJsonSync(statePath, state);
    return result;
  }, { lockPath: `${statePath}.lock` });
}
