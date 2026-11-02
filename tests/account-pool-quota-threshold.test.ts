/** Because healthy session affinity must yield to verified better quota. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  recordObservation,
  releaseReservation,
  reserveAccount,
  type CapacityObservation,
  type PoolKey,
  type ReserveAccountOptions,
} from '../src/account-pool.js';

let home: string;
let previousHome: string | undefined;

const pool: PoolKey = { providerId: 'openai-oauth', modelId: 'fixture-model', billingType: 'oauth' };
const accounts = [{ id: 'alpha', enabled: true }, { id: 'beta', enabled: true }];
const sessionId = 'fixture-session';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-quota-threshold-'));
  previousHome = process.env.LEVERFRAME_HOME;
  process.env.LEVERFRAME_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function weeklyObservation(accountId: string, value: number, observedAt: number): CapacityObservation {
  return {
    accountId, scope: { kind: 'pool' }, source: 'codex:event', observedAt, status: 'healthy',
    dimension: 'codex:fixture:secondary:10080',
    remaining: { value, limit: 100, unit: 'codex:fixture:secondary:10080' },
  } as unknown as CapacityObservation;
}

function windowObservation(input: {
  accountId: string; dimension: string; value: number; observedAt: number;
  limit?: number; resetAt?: number;
}): CapacityObservation {
  return {
    accountId: input.accountId, scope: { kind: 'pool' }, source: 'codex:event', observedAt: input.observedAt, status: 'healthy',
    dimension: input.dimension,
    remaining: { value: input.value, unit: input.dimension, ...(input.limit === undefined ? {} : { limit: input.limit }) },
    ...(input.resetAt === undefined ? {} : { resetAt: input.resetAt }),
  };
}

async function seedAffinity(statePath: string, options: Partial<ReserveAccountOptions> = {}): Promise<void> {
  const result = await reserveAccount({
    pool, accounts, sessionId, balancing: true, now: 1_000, statePath, ...options,
  });
  if (result.kind !== 'reserved') throw new Error('Expected initial reservation');
  await releaseReservation({ pool, reservationId: result.reservation.id, now: 1_001, statePath });
}

async function recordWindows(statePath: string, windows: CapacityObservation[]): Promise<void> {
  await Promise.all(windows.map(observation => recordObservation({
    pool, observation, now: observation.observedAt, statePath,
  })));
}

function reserveOptions(statePath: string, overrides: Partial<ReserveAccountOptions> = {}): ReserveAccountOptions {
  return {
    pool, accounts, sessionId, balancing: true, now: 1_500, statePath,
    ...overrides,
  };
}

function expectedAccount(result: Awaited<ReturnType<typeof reserveAccount>>): string {
  if (result.kind !== 'reserved') throw new Error('Expected a usable capacity reservation');
  return result.reservation.accountId;
}

it('moves an existing weekly session to a healthier account below its quota threshold', async () => {
  const statePath = join(home, 'account-pool.json');
  const initial = await reserveAccount({
    pool, accounts, sessionId: 'fixture-session', balancing: true, now: 1_000, statePath,
  });
  if (initial.kind !== 'reserved') throw new Error('Expected initial reservation');
  await releaseReservation({ pool, reservationId: initial.reservation.id, now: 1_001, statePath });
  await recordObservation({ pool, observation: weeklyObservation('alpha', 8, 1_002), now: 1_002, statePath });
  await recordObservation({ pool, observation: weeklyObservation('beta', 70, 1_002), now: 1_002, statePath });

  const next = await reserveAccount({
    pool, accounts, sessionId: 'fixture-session', balancing: true, now: 1_003, statePath,
  });

  expect(expectedAccount(next)).toBe('beta');
  expect((next as { switchReason?: string }).switchReason).toBe('quota threshold');
});

it.each([
  { remaining: 10, expectedAccount: 'beta', expectedReason: 'quota threshold' },
  { remaining: 10.01, expectedAccount: 'alpha', expectedReason: undefined },
])('switches at the threshold boundary only ($remaining%)', async ({ remaining, expectedAccount: expected, expectedReason }) => {
  const statePath = join(home, 'threshold-boundary.json');
  await seedAffinity(statePath);
  await recordWindows(statePath, [
    windowObservation({ accountId: 'alpha', dimension: 'codex:fixture:secondary:10080', value: remaining, limit: 100, observedAt: 1_010 }),
    windowObservation({ accountId: 'beta', dimension: 'codex:fixture:secondary:10080', value: 70, limit: 100, observedAt: 1_010 }),
  ]);

  const next = await reserveAccount(reserveOptions(statePath, { quotaThresholdPercent: 10 }));

  expect(expectedAccount(next)).toBe(expected);
  expect(next.kind === 'reserved' ? next.switchReason : undefined).toBe(expectedReason);
});

it('keeps a usable affinity when the threshold is explicitly disabled', async () => {
  const statePath = join(home, 'threshold-disabled.json');
  await seedAffinity(statePath);
  await recordWindows(statePath, [
    windowObservation({ accountId: 'alpha', dimension: 'week', value: 1, limit: 100, observedAt: 1_010 }),
    windowObservation({ accountId: 'beta', dimension: 'week', value: 80, limit: 100, observedAt: 1_010 }),
  ]);

  const next = await reserveAccount(reserveOptions(statePath, { quotaThresholdPercent: 0 }));

  expect(expectedAccount(next)).toBe('alpha');
});

it('keeps a pinned affinity when account balancing is disabled', async () => {
  const statePath = join(home, 'threshold-balancing-disabled.json');
  await seedAffinity(statePath, { balancing: false, pinnedAccountId: 'alpha' });
  await recordWindows(statePath, [
    windowObservation({ accountId: 'alpha', dimension: 'week', value: 1, limit: 100, observedAt: 1_010 }),
    windowObservation({ accountId: 'beta', dimension: 'week', value: 80, limit: 100, observedAt: 1_010 }),
  ]);

  const next = await reserveAccount(reserveOptions(statePath, { balancing: false, pinnedAccountId: 'alpha' }));

  expect(expectedAccount(next)).toBe('alpha');
});

it('does not switch from an observation whose provider window has expired', async () => {
  const statePath = join(home, 'threshold-expired-window.json');
  await seedAffinity(statePath);
  await recordWindows(statePath, [
    windowObservation({ accountId: 'alpha', dimension: 'week', value: 1, limit: 100, resetAt: 1_200, observedAt: 1_010 }),
    windowObservation({ accountId: 'beta', dimension: 'week', value: 80, limit: 100, observedAt: 1_010 }),
  ]);

  const next = await reserveAccount(reserveOptions(statePath, { now: 1_500 }));

  expect(expectedAccount(next)).toBe('alpha');
});

it.each(['not-a-reset-time', null])('treats a malformed persisted reset as unknown for switching (%s)', async malformedReset => {
  const statePath = join(home, 'threshold-malformed-reset.json');
  await seedAffinity(statePath);
  await recordWindows(statePath, [
    windowObservation({ accountId: 'alpha', dimension: 'week', value: 1, limit: 100, observedAt: 1_010 }),
    windowObservation({ accountId: 'beta', dimension: 'week', value: 80, limit: 100, observedAt: 1_010 }),
  ]);
  type SavedState = { observations: Record<string, { accountId: string; status: string; resetAt?: unknown }> };
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as SavedState;
  const alphaKey = Object.keys(state.observations).find(key => state.observations[key]!.accountId === 'alpha')!;
  state.observations[alphaKey]!.resetAt = malformedReset;
  writeFileSync(statePath, JSON.stringify(state));

  const next = await reserveAccount(reserveOptions(statePath));
  const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as SavedState;

  expect(expectedAccount(next)).toBe('alpha');
  expect(persisted.observations[alphaKey]!.status).toBe('healthy');
  expect(persisted.observations[alphaKey]!.resetAt).toBe(malformedReset);
});

it('does not switch from a verified percentage older than the local freshness window', async () => {
  const statePath = join(home, 'threshold-stale-percentage.json');
  await seedAffinity(statePath);
  await recordWindows(statePath, [
    windowObservation({ accountId: 'alpha', dimension: 'week', value: 1, limit: 100, observedAt: 39_999 }),
    windowObservation({ accountId: 'beta', dimension: 'week', value: 80, limit: 100, observedAt: 39_999 }),
  ]);

  const next = await reserveAccount(reserveOptions(statePath, { now: 100_000 }));

  expect(expectedAccount(next)).toBe('alpha');
});

it('accepts a verified percentage exactly at the local freshness boundary', async () => {
  const statePath = join(home, 'threshold-fresh-boundary.json');
  await seedAffinity(statePath);
  await recordWindows(statePath, [
    windowObservation({ accountId: 'alpha', dimension: 'week', value: 1, limit: 100, observedAt: 40_000 }),
    windowObservation({ accountId: 'beta', dimension: 'week', value: 80, limit: 100, observedAt: 40_000 }),
  ]);

  const next = await reserveAccount(reserveOptions(statePath, { now: 100_000 }));

  expect(expectedAccount(next)).toBe('beta');
});

it('does not switch from a capacity observation timestamped in the future', async () => {
  const statePath = join(home, 'threshold-future-percentage.json');
  await seedAffinity(statePath);
  await recordWindows(statePath, [
    windowObservation({ accountId: 'alpha', dimension: 'week', value: 1, limit: 100, observedAt: 100_001 }),
    windowObservation({ accountId: 'beta', dimension: 'week', value: 80, limit: 100, observedAt: 100_001 }),
  ]);

  const next = await reserveAccount(reserveOptions(statePath, { now: 100_000 }));

  expect(expectedAccount(next)).toBe('alpha');
});

it('does not infer percentages from persisted observations that have no verified limit', async () => {
  const statePath = join(home, 'threshold-old-observation.json');
  await seedAffinity(statePath);
  await recordWindows(statePath, [
    windowObservation({ accountId: 'alpha', dimension: 'week', value: 1, observedAt: 1_010 }),
    windowObservation({ accountId: 'beta', dimension: 'week', value: 80, limit: 100, observedAt: 1_010 }),
  ]);

  const next = await reserveAccount(reserveOptions(statePath));

  expect(expectedAccount(next)).toBe('alpha');
});

it('keeps affinity when the other account has no verified capacity observation', async () => {
  const statePath = join(home, 'threshold-unknown-candidate.json');
  await seedAffinity(statePath);
  await recordWindows(statePath, [
    windowObservation({ accountId: 'alpha', dimension: 'week', value: 5, limit: 100, observedAt: 1_010 }),
  ]);

  const next = await reserveAccount(reserveOptions(statePath));

  expect(expectedAccount(next)).toBe('alpha');
});

it('keeps affinity when a candidate has unknown or incomparable capacity', async () => {
  const statePath = join(home, 'threshold-incomparable.json');
  await seedAffinity(statePath);
  await recordWindows(statePath, [
    windowObservation({ accountId: 'alpha', dimension: 'week', value: 1, limit: 100, observedAt: 1_010 }),
    windowObservation({ accountId: 'beta', dimension: 'day', value: 80, limit: 100, observedAt: 1_010 }),
  ]);

  const next = await reserveAccount(reserveOptions(statePath));

  expect(expectedAccount(next)).toBe('alpha');
});

it('keeps affinity when a candidate improves one window but worsens another', async () => {
  const statePath = join(home, 'threshold-multidimensional-worse.json');
  await seedAffinity(statePath);
  await recordWindows(statePath, [
    windowObservation({ accountId: 'alpha', dimension: 'week', value: 5, limit: 100, observedAt: 1_010 }),
    windowObservation({ accountId: 'alpha', dimension: 'day', value: 80, limit: 100, observedAt: 1_010 }),
    windowObservation({ accountId: 'beta', dimension: 'week', value: 70, limit: 100, observedAt: 1_010 }),
    windowObservation({ accountId: 'beta', dimension: 'day', value: 4, limit: 100, observedAt: 1_010 }),
  ]);

  const next = await reserveAccount(reserveOptions(statePath));

  expect(expectedAccount(next)).toBe('alpha');
});

it('switches when every comparable candidate window is above threshold and no worse', async () => {
  const statePath = join(home, 'threshold-multidimensional-better.json');
  await seedAffinity(statePath);
  await recordWindows(statePath, [
    windowObservation({ accountId: 'alpha', dimension: 'week', value: 5, limit: 100, observedAt: 1_010 }),
    windowObservation({ accountId: 'alpha', dimension: 'day', value: 80, limit: 100, observedAt: 1_010 }),
    windowObservation({ accountId: 'beta', dimension: 'week', value: 70, limit: 100, observedAt: 1_010 }),
    windowObservation({ accountId: 'beta', dimension: 'day', value: 80, limit: 100, observedAt: 1_010 }),
  ]);

  const next = await reserveAccount(reserveOptions(statePath));

  expect(expectedAccount(next)).toBe('beta');
  expect(next.kind === 'reserved' ? next.switchReason : undefined).toBe('quota threshold');
});

it('continues on an available affinity when every account remains below threshold', async () => {
  const statePath = join(home, 'threshold-all-low.json');
  await seedAffinity(statePath);
  await recordWindows(statePath, [
    windowObservation({ accountId: 'alpha', dimension: 'week', value: 5, limit: 100, observedAt: 1_010 }),
    windowObservation({ accountId: 'beta', dimension: 'week', value: 8, limit: 100, observedAt: 1_010 }),
  ]);

  const next = await reserveAccount(reserveOptions(statePath));

  expect(next.kind).toBe('reserved');
  expect(expectedAccount(next)).toBe('alpha');
});

it('keeps affinity when another account has the same limiting percentage', async () => {
  const statePath = join(home, 'threshold-equally-constrained.json');
  await seedAffinity(statePath);
  await recordWindows(statePath, [
    windowObservation({ accountId: 'alpha', dimension: 'week', value: 5, limit: 100, observedAt: 1_010 }),
    windowObservation({ accountId: 'beta', dimension: 'week', value: 5, limit: 100, observedAt: 1_010 }),
  ]);

  const next = await reserveAccount(reserveOptions(statePath));

  expect(expectedAccount(next)).toBe('alpha');
  expect(next.kind === 'reserved' ? next.switchReason : undefined).toBeUndefined();
});

it('keeps the new affinity after one proactive switch', async () => {
  const statePath = join(home, 'threshold-sticky-after-switch.json');
  await seedAffinity(statePath);
  await recordWindows(statePath, [
    windowObservation({ accountId: 'alpha', dimension: 'week', value: 5, limit: 100, observedAt: 1_010 }),
    windowObservation({ accountId: 'beta', dimension: 'week', value: 70, limit: 100, observedAt: 1_010 }),
  ]);
  const switched = await reserveAccount(reserveOptions(statePath));

  const next = await reserveAccount(reserveOptions(statePath, { now: 1_600 }));

  expect(expectedAccount(switched)).toBe('beta');
  expect(expectedAccount(next)).toBe('beta');
});

it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 100, 100.1])('rejects an invalid quota threshold %s', async threshold => {
  const statePath = join(home, 'threshold-invalid.json');

  await expect(reserveAccount(reserveOptions(statePath, { quotaThresholdPercent: threshold })))
    .rejects.toThrow('Invalid quota threshold');
});
