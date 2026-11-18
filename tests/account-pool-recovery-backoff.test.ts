import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  RECOVERY_COOLDOWN_MS,
  confirmRecovery,
  recordObservation,
  recoveryCooldownMs,
  releaseReservation,
  reserveAccount,
  type CapacityObservation,
  type PoolKey,
  type ReserveAccountOptions,
  type ReserveResult,
  type Reservation,
} from '../src/account-pool.js';

const INCIDENT_START = Date.parse('2026-11-18T02:05:00Z');
const SIXTEEN_HOURS = 16 * 3_600_000;

let home: string;
let statePath: string;

const codexPool: PoolKey = { providerId: 'codex', modelId: 'gpt-sol-fixture', billingType: 'oauth' };
const anthropicPool: PoolKey = { providerId: 'anthropic-api', modelId: 'claude-fixture', billingType: 'api' };

type BlockedCase = { label: string; pool: PoolKey; observation: CapacityObservation };

function weeklyCodexWindowFull(accountId = 'alpha', observedAt = INCIDENT_START): CapacityObservation {
  return {
    accountId, scope: { kind: 'pool' }, source: 'codex:headers', dimension: 'codex:codex:primary:10080',
    observedAt, status: 'rate_limited', resetAt: observedAt + SIXTEEN_HOURS,
    remaining: { value: 0, unit: 'codex:codex:primary:10080', limit: 100 },
  };
}

const blockedCases: BlockedCase[] = [
  { label: 'codex weekly window reported full by response headers', pool: codexPool, observation: weeklyCodexWindowFull() },
  {
    label: 'codex usage event reporting a full window', pool: codexPool,
    observation: {
      accountId: 'alpha', scope: { kind: 'pool' }, source: 'codex:event', dimension: 'codex:codex:secondary:300',
      observedAt: INCIDENT_START, status: 'rate_limited', resetAt: INCIDENT_START + SIXTEEN_HOURS,
      remaining: { value: 0, unit: 'codex:codex:secondary:300', limit: 100 },
    },
  },
  {
    label: 'anthropic request window reported empty by headers', pool: anthropicPool,
    observation: {
      accountId: 'alpha', scope: { kind: 'pool' }, source: 'anthropic:headers', dimension: 'anthropic:requests',
      observedAt: INCIDENT_START, status: 'rate_limited', resetAt: INCIDENT_START + 86_400_000,
      remaining: { value: 0, unit: 'anthropic:requests' },
    },
  },
  {
    label: 'anthropic billing exhaustion without a reset', pool: anthropicPool,
    observation: {
      accountId: 'alpha', scope: { kind: 'account' }, source: 'anthropic-api:billing',
      observedAt: INCIDENT_START, status: 'exhausted',
    },
  },
  {
    label: 'authentication failure', pool: anthropicPool,
    observation: {
      accountId: 'alpha', scope: { kind: 'account' }, source: 'anthropic-api:authentication',
      dimension: 'authentication', observedAt: INCIDENT_START, status: 'auth_failure',
    },
  },
];

function reserve(pool: PoolKey, now: number, overrides: Partial<ReserveAccountOptions> = {}): Promise<ReserveResult> {
  return reserveAccount({
    pool, accounts: [{ id: 'alpha', enabled: true }], balancing: false, now, statePath, ...overrides,
  });
}

function block(pool: PoolKey, observation: CapacityObservation): Promise<void> {
  return recordObservation({ pool, observation, now: observation.observedAt, statePath });
}

function reservation(result: ReserveResult): Reservation {
  if (result.kind !== 'reserved') throw new Error(`Expected an account reservation, got ${JSON.stringify(result)}`);
  return result.reservation;
}

async function succeedProbe(pool: PoolKey, now: number): Promise<void> {
  const probe = reservation(await reserve(pool, now));
  await confirmRecovery({ pool, reservationId: probe.id, now: now + 1, statePath });
  await releaseReservation({ pool, reservationId: probe.id, now: now + 1, statePath });
}

const FAILED_PROBE_OFFSETS = [60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_840_000];

async function failProbes(pool: PoolKey, count: number): Promise<void> {
  for (const offset of FAILED_PROBE_OFFSETS.slice(0, count)) {
    const probe = reservation(await reserve(pool, INCIDENT_START + offset));
    await releaseReservation({ pool, reservationId: probe.id, now: INCIDENT_START + offset, statePath });
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-pool-backoff-'));
  statePath = join(home, 'pool-state.json');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

it.each(blockedCases)('withholds an account blocked by $label during the recovery cooldown', async ({ pool, observation }) => {
  await block(pool, observation);

  const result = await reserve(pool, INCIDENT_START + RECOVERY_COOLDOWN_MS - 1);

  expect(result).toMatchObject({ kind: 'exhausted', reason: 'capacity_unavailable' });
});

it.each(blockedCases)('lets one real request probe an account blocked by $label after the cooldown', async ({ pool, observation }) => {
  await block(pool, observation);

  const result = await reserve(pool, INCIDENT_START + RECOVERY_COOLDOWN_MS);

  expect(result).toMatchObject({ kind: 'reserved', probe: true, reservation: { accountId: 'alpha' } });
});

it.each(blockedCases)('serves the next request normally after a probe of $label succeeds', async ({ pool, observation }) => {
  await block(pool, observation);
  await succeedProbe(pool, INCIDENT_START + RECOVERY_COOLDOWN_MS);

  const result = await reserve(pool, INCIDENT_START + RECOVERY_COOLDOWN_MS + 2);

  expect(result).toMatchObject({ kind: 'reserved', reservation: { accountId: 'alpha' } });
  expect(result).not.toMatchObject({ probe: true });
});

it.each([
  { failures: 0, expected: 60_000 },
  { failures: 1, expected: 120_000 },
  { failures: 2, expected: 240_000 },
  { failures: 3, expected: 480_000 },
  { failures: 4, expected: 960_000 },
  { failures: 5, expected: 1_920_000 },
  { failures: 9, expected: 1_920_000 },
  { failures: -2, expected: 60_000 },
])('waits $expected ms before probing again after $failures failed probes', ({ failures, expected }) => {
  expect(recoveryCooldownMs(failures)).toBe(expected);
});

it.each([
  { failures: 1, readyAt: 120_000 },
  { failures: 2, readyAt: 240_000 },
  { failures: 5, readyAt: 1_920_000 },
])('withholds the next probe until the doubled wait after $failures failed probes', async ({ failures, readyAt }) => {
  await block(codexPool, weeklyCodexWindowFull());
  await failProbes(codexPool, failures);

  const result = await reserve(codexPool, INCIDENT_START + readyAt - 1);

  expect(result).toMatchObject({ kind: 'exhausted', reason: 'capacity_unavailable' });
});

it.each([
  { failures: 1, readyAt: 120_000 },
  { failures: 2, readyAt: 240_000 },
  { failures: 5, readyAt: 1_920_000 },
])('allows the next probe once the doubled wait after $failures failed probes has passed', async ({ failures, readyAt }) => {
  await block(codexPool, weeklyCodexWindowFull());
  await failProbes(codexPool, failures);

  const result = await reserve(codexPool, INCIDENT_START + readyAt);

  expect(result).toMatchObject({ kind: 'reserved', probe: true });
});

it('caps the wait between failed probes at 32 minutes', async () => {
  await block(codexPool, weeklyCodexWindowFull());
  await failProbes(codexPool, 7);

  const result = await reserve(codexPool, INCIDENT_START + 3_840_000 + 1_920_000);

  expect(result).toMatchObject({ kind: 'reserved', probe: true });
});

it('restarts the backoff at one cooldown after a probe succeeds', async () => {
  await block(codexPool, weeklyCodexWindowFull());
  await failProbes(codexPool, 3);
  await succeedProbe(codexPool, INCIDENT_START + 480_000);
  const reblockedAt = INCIDENT_START + 600_000;
  await block(codexPool, weeklyCodexWindowFull('alpha', reblockedAt));

  const result = await reserve(codexPool, reblockedAt + RECOVERY_COOLDOWN_MS);

  expect(result).toMatchObject({ kind: 'reserved', probe: true });
});

it('lets only one probe through while the probe reservation is still live', async () => {
  await block(codexPool, weeklyCodexWindowFull());
  const probeAt = INCIDENT_START + RECOVERY_COOLDOWN_MS;
  reservation(await reserve(codexPool, probeAt));

  const concurrent = await reserve(codexPool, probeAt + 2 * RECOVERY_COOLDOWN_MS);

  expect(concurrent).toMatchObject({ kind: 'exhausted', reason: 'capacity_unavailable' });
});

it('prefers a clear account over a probe-ready account while balancing', async () => {
  await block(anthropicPool, {
    accountId: 'alpha', scope: { kind: 'pool' }, source: 'anthropic-api:rejection',
    observedAt: INCIDENT_START, status: 'rate_limited',
  });

  const result = await reserve(anthropicPool, INCIDENT_START + RECOVERY_COOLDOWN_MS, {
    accounts: [{ id: 'alpha', enabled: true }, { id: 'beta', enabled: true }], balancing: true,
  });

  expect(result).toMatchObject({ kind: 'reserved', reservation: { accountId: 'beta' } });
  expect(result).not.toMatchObject({ probe: true });
});

it('still probes a pinned account when balancing is off and another account is clear', async () => {
  await block(codexPool, weeklyCodexWindowFull());

  const result = await reserve(codexPool, INCIDENT_START + RECOVERY_COOLDOWN_MS, {
    accounts: [{ id: 'alpha', enabled: true }, { id: 'beta', enabled: true }], pinnedAccountId: 'alpha',
  });

  expect(result).toMatchObject({ kind: 'reserved', probe: true, reservation: { accountId: 'alpha' } });
});

it('loads a state file written before probe backoff existed', async () => {
  await block(codexPool, weeklyCodexWindowFull());
  const olderState = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
  delete olderState.probes;
  writeFileSync(statePath, JSON.stringify(olderState));

  const result = await reserve(codexPool, INCIDENT_START + RECOVERY_COOLDOWN_MS);

  expect(result).toMatchObject({ kind: 'reserved', probe: true });
});
