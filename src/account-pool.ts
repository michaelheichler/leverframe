import { randomUUID } from 'node:crypto';
import { key, poolKey, providerKey, sessionKey, updatePoolState } from './account-pool-state.js';
import type { PoolState, StoredObservation } from './account-pool-state.js';

export type PoolKey = { providerId: string; modelId: string; billingType: 'api' | 'oauth' };
export type CapacityStatus = 'healthy' | 'rate_limited' | 'exhausted' | 'auth_failure' | 'unknown';
export type CapacityObservation = {
  accountId: string;
  scope: { kind: 'pool' } | { kind: 'account' } | { kind: 'shared'; bucketId: string; evidence: 'provider' };
  source: string;
  dimension?: string;
  observedAt: number;
  status: CapacityStatus;
  resetAt?: number;
  remaining?: { value: number; unit: string };
};
export type PoolAccount = { id: string; enabled: boolean; generation?: string };
export type Reservation = { id: string; accountId: string; expiresAt: number };
export type ReserveResult =
  | { kind: 'reserved'; reservation: Reservation }
  | { kind: 'exhausted'; reason: 'no_eligible_account' | 'pinned_account_unavailable' | 'capacity_unavailable';
      accounts: Array<{ accountId: string; status: CapacityStatus; resetAt?: number }> };
export interface ReserveAccountOptions {
  pool: PoolKey;
  sessionId?: string;
  accounts: readonly PoolAccount[];
  balancing: boolean;
  pinnedAccountId?: string;
  now: number;
  excludeAccountIds?: readonly string[];
  statePath?: string;
}

export const RESERVATION_TTL_MS = 5 * 60_000;
export const RECOVERY_COOLDOWN_MS = 60_000;

function observationKey(pool: PoolKey, observation: CapacityObservation): string {
  const parts = observation.scope.kind === 'pool' ? ['pool', poolKey(pool), observation.accountId]
    : observation.scope.kind === 'account' ? ['account', providerKey(pool), observation.accountId]
      : ['shared', providerKey(pool), observation.scope.bucketId];
  return key(...parts, ...(observation.dimension === undefined ? [] : [observation.dimension]));
}

function observationsFor(state: PoolState, pool: PoolKey, accountId: string): StoredObservation[] {
  const provider = providerKey(pool);
  const keys = [key('pool', poolKey(pool), accountId), key('account', provider, accountId)];
  for (const bucket of state.memberships[key(provider, accountId)] ?? []) keys.push(key('shared', provider, bucket));
  return Object.entries(state.observations).flatMap(([id, observation]) => {
    const parts = JSON.parse(id) as string[];
    return keys.some(base => {
      const prefix = JSON.parse(base) as string[];
      return (parts.length === prefix.length || parts.length === prefix.length + 1)
        && prefix.every((part, index) => parts[index] === part);
    }) ? [observation] : [];
  });
}

function isBlocked(observation: StoredObservation, now: number): boolean {
  if (observation.status === 'healthy' || observation.status === 'unknown') return false;
  if (observation.status === 'auth_failure') return true;
  return observation.resetAt === undefined || observation.resetAt > now;
}

function blockedSummary(accountId: string, observations: StoredObservation[], now: number): {
  accountId: string; status: CapacityStatus; resetAt?: number;
} {
  const blocked = observations.filter(observation => isBlocked(observation, now));
  const status = blocked.find(observation => observation.status === 'auth_failure')?.status
    ?? blocked.find(observation => observation.status === 'exhausted')?.status
    ?? blocked[0]?.status ?? 'unknown';
  const resetAt = blocked.length > 0 && blocked.every(observation => observation.resetAt !== undefined)
    ? Math.max(...blocked.map(observation => observation.resetAt!)) : undefined;
  return { accountId, status, ...(resetAt === undefined ? {} : { resetAt }) };
}

function reconcile(state: PoolState, pool: PoolKey, accounts: readonly PoolAccount[]): void {
  const provider = providerKey(pool);
  state.generations ??= {};
  for (const account of accounts) {
    if (account.generation === undefined) continue;
    const identity = key(provider, account.id);
    if (state.generations[identity] !== account.generation) {
      delete state.memberships[identity];
      for (const [id, observation] of Object.entries(state.observations)) {
        const parts = JSON.parse(id) as string[];
        const belongs = parts[0] === 'account' ? parts[1] === provider
          : parts[0] === 'pool' && (JSON.parse(parts[1]) as string[]).slice(0, 2).join('\0')
            === [pool.providerId, pool.billingType].join('\0');
        if (belongs && observation.accountId === account.id) delete state.observations[id];
      }
      state.generations[identity] = account.generation;
    }
  }
  const ids = accounts.map(account => account.id);
  const keep = new Set(ids);
  state.accounts[provider] = ids;
  for (const id of Object.keys(state.memberships)) {
    const parts = JSON.parse(id) as string[];
    if (parts[0] === provider && !keep.has(parts[1])) delete state.memberships[id];
  }
  for (const id of Object.keys(state.generations)) {
    const parts = JSON.parse(id) as string[];
    if (parts[0] === provider && !keep.has(parts[1])) delete state.generations[id];
  }
  for (const [id, observation] of Object.entries(state.observations)) {
    const parts = JSON.parse(id) as string[];
    const belongs = parts[0] === 'account' ? parts[1] === provider
      : parts[0] === 'pool' && (JSON.parse(parts[1]) as string[]).slice(0, 2).join('\0')
        === [pool.providerId, pool.billingType].join('\0');
    if (belongs && !keep.has(observation.accountId)) delete state.observations[id];
  }
  state.reservations = state.reservations.flatMap(reservation => {
    const parts = JSON.parse(reservation.pool) as string[];
    if (key(parts[0], parts[1]) !== provider || keep.has(reservation.accountId)) return [reservation];
    const probeKeys = reservation.probeKeys?.filter(id => (JSON.parse(id) as string[])[0] === 'shared');
    return probeKeys?.length ? [{ ...reservation, probeKeys }] : [];
  });
}

function available(state: PoolState, pool: PoolKey, observations: StoredObservation[], now: number): boolean {
  return observations.every(observation => !isBlocked(observation, now)
    || (observation.status !== 'auth_failure' && observation.resetAt === undefined
      && (observation.probeAfter ?? observation.observedAt + RECOVERY_COOLDOWN_MS) <= now
      && !state.reservations.some(reservation => reservation.probeKeys?.includes(observationKey(pool, observation)))));
}

function capacity(observations: StoredObservation[]): Map<string, number> | undefined {
  if (!observations.length) return undefined;
  const values = new Map<string, number>();
  for (const item of observations) {
    if (item.source === 'pool:recovery' && item.status === 'healthy') continue;
    const remaining = item.remaining;
    if (item.status !== 'healthy' || !remaining || !Number.isFinite(remaining.value)
      || remaining.value < 0 || !remaining.unit) return undefined;
    const scope = item.scope.kind === 'shared' ? key('shared', item.scope.bucketId) : item.scope.kind;
    const dimension = key(scope, item.dimension ?? '', remaining.unit);
    if (values.has(dimension)) return undefined;
    values.set(dimension, remaining.value);
  }
  return values.size ? values : undefined;
}

function dominates(candidate: Map<string, number>, other: Map<string, number>): boolean {
  let greater = false;
  for (const [dimension, value] of candidate) {
    const comparison = other.get(dimension);
    if (comparison === undefined || value < comparison) return false;
    if (value > comparison) greater = true;
  }
  return greater;
}

export async function reserveAccount(options: ReserveAccountOptions): Promise<ReserveResult> {
  validatePool(options.pool);
  if (!Number.isFinite(options.now) || options.accounts.length > 1024) throw new Error('Invalid account pool request');
  for (const account of options.accounts) {
    validateText(account.id);
    if (account.generation !== undefined) validateText(account.generation);
  }
  return updatePoolState(options.statePath, options.now, state => {
    const { pool, now } = options;
    reconcile(state, pool, options.accounts);
    const enabled = options.accounts.filter(account => account.enabled);
    if (options.pinnedAccountId && !enabled.some(account => account.id === options.pinnedAccountId)) {
      return { kind: 'exhausted', reason: 'pinned_account_unavailable', accounts: [] };
    }
    const candidates = enabled.filter(account => !options.excludeAccountIds?.includes(account.id));
    if (!candidates.length) return { kind: 'exhausted', reason: 'no_eligible_account', accounts: [] };
    const statuses = candidates.map(account => ({ account, observations: observationsFor(state, pool, account.id) }));
    const eligible = statuses.filter(item => available(state, pool, item.observations, now));
    if (!eligible.length) return {
      kind: 'exhausted', reason: 'capacity_unavailable',
      accounts: statuses.map(item => blockedSummary(item.account.id, item.observations, now)),
    };
    const affinityId = options.sessionId ? sessionKey(pool, options.sessionId) : undefined;
    const affinity = affinityId && state.affinity[affinityId]?.accountId;
    const pinned = options.pinnedAccountId && !options.excludeAccountIds?.includes(options.pinnedAccountId)
      ? eligible.find(item => item.account.id === options.pinnedAccountId) : undefined;
    if (!options.balancing && options.pinnedAccountId && !options.excludeAccountIds?.includes(options.pinnedAccountId) && !pinned) {
      const item = statuses.find(entry => entry.account.id === options.pinnedAccountId);
      return { kind: 'exhausted', reason: 'capacity_unavailable',
        accounts: [blockedSummary(options.pinnedAccountId, item?.observations ?? [], now)] };
    }
    let chosen = (!options.balancing && pinned) || eligible.find(item => item.account.id === affinity);
    if (!chosen && !options.balancing) chosen = eligible[0];
    if (!chosen) {
      const measures = eligible.map(item => capacity(item.observations));
      const first = measures[0];
      const comparable = first !== undefined && measures.every(item => item !== undefined
        && item.size === first.size && [...first.keys()].every(dimension => item.has(dimension)));
      const tied = comparable ? eligible.filter((_, index) => !measures.some((other, otherIndex) =>
        otherIndex !== index && dominates(other!, measures[index]!))) : eligible;
      const counts = tied.map(item => state.reservations.filter(reservation =>
        reservation.pool === poolKey(pool) && reservation.accountId === item.account.id).length);
      const minimum = Math.min(...counts);
      const leastBusy = tied.filter((_, index) => counts[index] === minimum);
      const rotation = state.rotations[poolKey(pool)]?.next ?? 0;
      chosen = leastBusy[rotation % leastBusy.length];
      state.rotations[poolKey(pool)] = { next: (rotation + 1) % 1_000_000, usedAt: now };
    }
    if (affinityId) state.affinity[affinityId] = { accountId: chosen.account.id, usedAt: now };
    const probeKeys = chosen.observations.filter(observation => isBlocked(observation, now))
      .map(observation => observationKey(pool, observation));
    const recoveryProbes = Object.fromEntries(chosen.observations.filter(observation =>
      isBlocked(observation, now) && observation.resetAt === undefined && observation.dimension === undefined
      && observation.scope.kind === 'pool' && observation.status === 'rate_limited'
      && observation.source.endsWith(':rejection'))
      .map(observation => [observationKey(pool, observation), observation.observedAt]));
    for (const observation of chosen.observations) {
      if (isBlocked(observation, now) && observation.resetAt === undefined) observation.probeAfter = now + RECOVERY_COOLDOWN_MS;
    }
    const reservation = { id: randomUUID(), accountId: chosen.account.id, expiresAt: now + RESERVATION_TTL_MS };
    state.reservations.push({ ...reservation, pool: poolKey(pool), ...(probeKeys.length ? { probeKeys } : {}),
      ...(Object.keys(recoveryProbes).length ? { recoveryProbes } : {}) });
    return { kind: 'reserved', reservation };
  });
}

export async function confirmRecovery(options: {
  pool: PoolKey; reservationId: string; generation?: string; now: number; statePath?: string;
}): Promise<void> {
  await updatePoolState(options.statePath, options.now, state => {
    const reservation = state.reservations.find(item => item.id === options.reservationId && item.pool === poolKey(options.pool));
    if (!reservation || (options.generation !== undefined
      && state.generations?.[key(providerKey(options.pool), reservation.accountId)] !== options.generation)) return;
    for (const [id, observedAt] of Object.entries(reservation.recoveryProbes ?? {})) {
      const current = state.observations[id];
      if (!current || current.observedAt !== observedAt || current.status !== 'rate_limited'
        || current.resetAt !== undefined || current.dimension !== undefined) continue;
      state.observations[id] = { ...current, source: 'pool:recovery', status: 'healthy',
        observedAt: Math.max(options.now, current.observedAt + 1), probeAfter: undefined };
    }
  });
}

export async function recordObservation(options: {
  pool: PoolKey; observation: CapacityObservation; now: number; statePath?: string; generation?: string;
}): Promise<void> {
  validatePool(options.pool);
  validateText(options.observation.accountId);
  validateText(options.observation.source);
  if (options.observation.dimension !== undefined) validateText(options.observation.dimension);
  if (!Number.isFinite(options.now)) throw new Error('Invalid observation time');
  await updatePoolState(options.statePath, options.now, state => {
    const { pool, observation } = options;
    if (options.generation !== undefined
      && state.generations?.[key(providerKey(pool), observation.accountId)] !== options.generation) return;
    const accounts = state.accounts[providerKey(pool)];
    if (accounts && !accounts.includes(observation.accountId)) return;
    if (!Number.isFinite(observation.observedAt) || !observation.source) throw new Error('Invalid capacity observation');
    if (observation.resetAt !== undefined && !Number.isFinite(observation.resetAt)) throw new Error('Invalid capacity reset');
    if (observation.scope.kind === 'shared') {
      if (observation.scope.evidence !== 'provider' || !observation.scope.bucketId) throw new Error('Shared bucket needs provider evidence');
      validateText(observation.scope.bucketId);
      const membership = key(providerKey(pool), observation.accountId);
      const buckets = state.memberships[membership] ?? [];
      if (!buckets.includes(observation.scope.bucketId)) buckets.push(observation.scope.bucketId);
      if (buckets.length > 128) throw new Error('Too many shared buckets for account');
      state.memberships[membership] = buckets;
    }
    const id = observationKey(pool, observation);
    if ((state.observations[id]?.observedAt ?? -Infinity) >= observation.observedAt) return;
    const remaining = observation.remaining;
    const safeRemaining = remaining && Number.isFinite(remaining.value) && remaining.value >= 0 && remaining.unit && remaining.unit.length <= 256
      ? { value: remaining.value, unit: remaining.unit } : undefined;
    const scope = observation.scope.kind === 'shared'
      ? { kind: 'shared' as const, bucketId: observation.scope.bucketId, evidence: 'provider' as const }
      : { kind: observation.scope.kind };
    state.observations[id] = {
      accountId: observation.accountId, scope, source: observation.source,
      observedAt: observation.observedAt, status: observation.status,
      ...(observation.dimension === undefined ? {} : { dimension: observation.dimension }),
      ...(observation.resetAt === undefined ? {} : { resetAt: observation.resetAt }),
      ...(safeRemaining ? { remaining: safeRemaining } : {}),
    };
  });
}

function validateText(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new Error('Invalid account pool identifier');
}

function validatePool(pool: PoolKey): void {
  validateText(pool.providerId);
  validateText(pool.modelId);
  if (pool.billingType !== 'api' && pool.billingType !== 'oauth') throw new Error('Invalid account pool billing type');
}

export async function releaseReservation(options: {
  pool: PoolKey; reservationId: string; now: number; statePath?: string;
}): Promise<void> {
  await updatePoolState(options.statePath, options.now, state => {
    state.reservations = state.reservations.filter(item => item.id !== options.reservationId || item.pool !== poolKey(options.pool));
  });
}
