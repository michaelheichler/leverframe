import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  RECOVERY_COOLDOWN_MS,
  RESERVATION_TTL_MS,
  recordObservation,
  releaseReservation,
  reserveAccount,
  type CapacityObservation,
  type PoolAccount,
  type PoolKey,
  type ReserveAccountOptions,
  type ReserveResult,
  type Reservation,
} from '../src/account-pool.js';

let statePath: string;
let tempHome: string;

function pool(overrides: Partial<PoolKey> = {}): PoolKey {
  return { providerId: 'anthropic-api', modelId: 'model-one', billingType: 'api', ...overrides };
}

function account(id: string, enabled = true): PoolAccount {
  return { id, enabled };
}

function observation(
  accountId: string,
  status: CapacityObservation['status'],
  overrides: Partial<CapacityObservation> = {},
): CapacityObservation {
  return {
    accountId,
    scope: { kind: 'account' },
    source: 'fixture',
    observedAt: 100,
    status,
    ...overrides,
  };
}

function request(overrides: Partial<ReserveAccountOptions> = {}): ReserveAccountOptions {
  return {
    pool: pool(),
    accounts: [account('alpha'), account('beta')],
    balancing: true,
    now: 100,
    statePath,
    ...overrides,
  };
}

function reservation(result: ReserveResult): Reservation {
  if (result.kind !== 'reserved') throw new Error('Expected an account reservation');
  return result.reservation;
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'leverframe-account-pool-'));
  statePath = join(tempHome, 'pool-state.json');
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

it('rotates fairly across accounts with unknown capacity', async () => {
  const first = reservation(await reserveAccount(request()));
  await releaseReservation({ pool: pool(), reservationId: first.id, now: 101, statePath });
  const second = reservation(await reserveAccount(request({ now: 102 })));
  await releaseReservation({ pool: pool(), reservationId: second.id, now: 103, statePath });
  const third = reservation(await reserveAccount(request({ now: 104 })));

  const alphaCount = [first.accountId, second.accountId, third.accountId].filter(id => id === 'alpha').length;
  expect(new Set([first.accountId, second.accountId, third.accountId]).size).toBe(2);
  expect(Math.abs(alphaCount - 1.5)).toBeLessThanOrEqual(0.5);
});

it('keeps a healthy session on its established account', async () => {
  const sessionId = 'session-affinity-fixture';
  const first = reservation(await reserveAccount(request({ sessionId })));
  const second = reservation(await reserveAccount(request({ sessionId, now: 101 })));

  expect(second.accountId).toBe(first.accountId);
});

it('allows concurrent reservations for the same healthy single account', async () => {
  const results = await Promise.all([
    reserveAccount(request({ accounts: [account('only')], sessionId: 'healthy-concurrent-session', now: 100 })),
    reserveAccount(request({ accounts: [account('only')], sessionId: 'healthy-concurrent-session', now: 101 })),
  ]);
  const first = reservation(results[0]!);
  const second = reservation(results[1]!);

  expect(first.accountId).toBe('only');
  expect(second.accountId).toBe('only');
  expect(second.id).not.toBe(first.id);
});

it('persists session affinity without writing the raw session identifier', async () => {
  const sessionId = 'private-session-identifier-fixture';
  const selected = reservation(await reserveAccount(request({ sessionId })));

  const state = readFileSync(statePath, 'utf8');
  const repeated = await reserveAccount(request({ sessionId, now: 101 }));
  expect(state).not.toContain(sessionId);
  expect(reservation(repeated).accountId).toBe(selected.accountId);
});

it('keeps pool-scoped capacity within its provider, model and billing pool', async () => {
  await recordObservation({
    pool: pool(),
    observation: observation('alpha', 'exhausted', { scope: { kind: 'pool' } }),
    now: 100,
    statePath,
  });

  const otherModel = await reserveAccount(request({ pool: pool({ modelId: 'model-two' }), balancing: false }));
  const otherBilling = await reserveAccount(request({ pool: pool({ billingType: 'oauth' }), balancing: false }));

  expect(reservation(otherModel).accountId).toBe('alpha');
  expect(reservation(otherBilling).accountId).toBe('alpha');
});

it('does not let a pool-scope recovery probe block another model', async () => {
  const affectedPool = pool();
  const probeTime = 100 + RECOVERY_COOLDOWN_MS;
  await recordObservation({
    pool: affectedPool,
    observation: observation('alpha', 'exhausted', { scope: { kind: 'pool' } }),
    now: 100,
    statePath,
  });
  const probe = reservation(await reserveAccount(request({
    pool: affectedPool, accounts: [account('alpha')], now: probeTime,
  })));

  const otherModel = await reserveAccount(request({
    pool: pool({ modelId: 'model-two' }), accounts: [account('alpha')], now: probeTime + 1,
  }));

  expect(probe.accountId).toBe('alpha');
  expect(reservation(otherModel).accountId).toBe('alpha');
});

it('applies account-scoped exhaustion across models for that account', async () => {
  await recordObservation({
    pool: pool(),
    observation: observation('alpha', 'exhausted'),
    now: 100,
    statePath,
  });

  const result = await reserveAccount(request({ pool: pool({ modelId: 'model-two' }), balancing: false }));

  expect(reservation(result).accountId).toBe('beta');
});

it('applies a provider-evidenced shared bucket across accounts and models', async () => {
  const shared = { kind: 'shared', bucketId: 'bucket-fixture', evidence: 'provider' } as const;
  await recordObservation({
    pool: pool(),
    observation: observation('alpha', 'healthy', { scope: shared }),
    now: 100,
    statePath,
  });
  await recordObservation({
    pool: pool(),
    observation: observation('beta', 'healthy', { scope: shared }),
    now: 100,
    statePath,
  });
  await recordObservation({
    pool: pool(),
    observation: observation('alpha', 'exhausted', { scope: shared, observedAt: 101 }),
    now: 101,
    statePath,
  });

  const result = await reserveAccount(request({ pool: pool({ modelId: 'model-two' }), now: 102 }));

  expect(result.kind).toBe('exhausted');
});

it('prefers greater remaining capacity when observed units are comparable', async () => {
  await recordObservation({
    pool: pool(),
    observation: observation('alpha', 'healthy', { remaining: { value: 2, unit: 'requests' } }),
    now: 100,
    statePath,
  });
  await recordObservation({
    pool: pool(),
    observation: observation('beta', 'healthy', { remaining: { value: 8, unit: 'requests' } }),
    now: 100,
    statePath,
  });

  expect(reservation(await reserveAccount(request())).accountId).toBe('beta');
});

it('does not compare remaining values expressed in different units', async () => {
  await recordObservation({
    pool: pool(),
    observation: observation('alpha', 'healthy', { remaining: { value: 90, unit: 'requests' } }),
    now: 100,
    statePath,
  });
  await recordObservation({
    pool: pool(),
    observation: observation('beta', 'healthy', { remaining: { value: 3, unit: 'tokens' } }),
    now: 100,
    statePath,
  });

  const result = await reserveAccount(request({ balancing: false }));

  expect(reservation(result).accountId).toBe('alpha');
});

it('uses the first enabled account when balancing is off and no account is pinned', async () => {
  const result = await reserveAccount(request({
    accounts: [account('unavailable', false), account('first-ready'), account('next-ready')],
    balancing: false,
  }));

  expect(reservation(result).accountId).toBe('first-ready');
});

it.each([
  { pinnedAccountId: 'missing' },
  { pinnedAccountId: 'disabled' },
])('reports an unavailable pin while balancing is off', async ({ pinnedAccountId }) => {
  const result = await reserveAccount(request({
    accounts: [account('alpha'), account('disabled', false)],
    balancing: false,
    pinnedAccountId,
  }));

  expect(result).toMatchObject({ kind: 'exhausted', reason: 'pinned_account_unavailable' });
});

it('uses an alternate for an excluded pin without changing the explicit pin', async () => {
  const options = request({ balancing: false, pinnedAccountId: 'alpha' });
  const alternate = reservation(await reserveAccount({ ...options, excludeAccountIds: ['alpha'] }));
  const pinned = reservation(await reserveAccount({ ...options, now: 101 }));

  expect(alternate.accountId).toBe('beta');
  expect(pinned.accountId).toBe('alpha');
});

it('reconciles removed accounts before reusing an established session', async () => {
  const sessionId = 'removed-account-session-fixture';
  const first = reservation(await reserveAccount(request({ sessionId, balancing: false })));
  const remainingAccount = first.accountId === 'alpha' ? 'beta' : 'alpha';
  const afterRemoval = reservation(await reserveAccount(request({
    sessionId,
    balancing: false,
    accounts: [account(remainingAccount)],
    now: 101,
  })));

  expect(afterRemoval.accountId).toBe(remainingAccount);
});

it('recovers from known exhaustion when the confirmed reset time arrives', async () => {
  await recordObservation({
    pool: pool(),
    observation: observation('alpha', 'exhausted', { resetAt: 200 }),
    now: 100,
    statePath,
  });

  const beforeReset = await reserveAccount(request({ balancing: false, pinnedAccountId: 'alpha', now: 199 }));
  const atReset = await reserveAccount(request({ balancing: false, pinnedAccountId: 'alpha', now: 200 }));

  expect(beforeReset.kind).toBe('exhausted');
  expect(reservation(atReset).accountId).toBe('alpha');
});

it('allows a later incoming request to probe unknown-reset exhaustion after cooldown', async () => {
  await recordObservation({
    pool: pool(),
    observation: observation('alpha', 'exhausted'),
    now: 100,
    statePath,
  });
  await recordObservation({
    pool: pool(),
    observation: observation('beta', 'exhausted'),
    now: 100,
    statePath,
  });
  const options = request({ balancing: false, pinnedAccountId: 'alpha', now: 100 });

  const inCooldown = await reserveAccount({ ...options, now: 100 + RECOVERY_COOLDOWN_MS - 1 });
  const afterCooldown = await reserveAccount({ ...options, now: 100 + RECOVERY_COOLDOWN_MS });

  expect(inCooldown.kind).toBe('exhausted');
  expect(reservation(afterCooldown).accountId).toBe('alpha');
});

it('limits pool-scope recovery to the probed account', async () => {
  const affectedPool = pool();
  const probeTime = 100 + RECOVERY_COOLDOWN_MS;
  const laterRequest = probeTime + RECOVERY_COOLDOWN_MS;
  await recordObservation({
    pool: affectedPool,
    observation: observation('alpha', 'exhausted', { scope: { kind: 'pool' } }),
    now: 100,
    statePath,
  });
  await recordObservation({
    pool: affectedPool,
    observation: observation('beta', 'exhausted', { scope: { kind: 'pool' } }),
    now: 100,
    statePath,
  });
  const probe = reservation(await reserveAccount(request({
    pool: affectedPool, now: probeTime,
  })));
  const repeatedProbe = await reserveAccount(request({
    pool: affectedPool, excludeAccountIds: ['beta'], now: laterRequest,
  }));
  const independentProbe = await reserveAccount(request({
    pool: affectedPool, excludeAccountIds: ['alpha'], now: laterRequest,
  }));
  await releaseReservation({ pool: affectedPool, reservationId: probe.id, now: laterRequest, statePath });
  const recovered = await reserveAccount(request({
    pool: affectedPool, excludeAccountIds: ['beta'], now: laterRequest,
  }));

  expect(repeatedProbe).toMatchObject({ kind: 'exhausted', reason: 'capacity_unavailable' });
  expect(reservation(independentProbe).accountId).toBe('beta');
  expect(recovered.kind).toBe('reserved');
});

it('exclusively reserves account-scope recovery across models until release', async () => {
  const affectedPool = pool();
  const otherModel = pool({ modelId: 'model-two' });
  const probeTime = 100 + RECOVERY_COOLDOWN_MS;
  const laterRequest = probeTime + RECOVERY_COOLDOWN_MS;
  await recordObservation({
    pool: affectedPool,
    observation: observation('alpha', 'exhausted'),
    now: 100,
    statePath,
  });
  const probe = reservation(await reserveAccount(request({
    pool: affectedPool, accounts: [account('alpha')], now: probeTime,
  })));
  const concurrentProbe = await reserveAccount(request({
    pool: otherModel, accounts: [account('alpha')], now: laterRequest,
  }));
  await releaseReservation({ pool: affectedPool, reservationId: probe.id, now: laterRequest, statePath });
  const recovered = await reserveAccount(request({
    pool: otherModel, accounts: [account('alpha')], now: laterRequest,
  }));

  expect(concurrentProbe).toMatchObject({ kind: 'exhausted', reason: 'capacity_unavailable' });
  expect(reservation(recovered).accountId).toBe('alpha');
});

it('exclusively reserves an evidenced shared-bucket recovery across accounts and models', async () => {
  const affectedPool = pool();
  const otherModel = pool({ modelId: 'model-two' });
  const shared = { kind: 'shared', bucketId: 'shared-probe-fixture', evidence: 'provider' } as const;
  const probeTime = 100 + RECOVERY_COOLDOWN_MS;
  const laterRequest = probeTime + RECOVERY_COOLDOWN_MS;
  await recordObservation({
    pool: affectedPool,
    observation: observation('alpha', 'exhausted', { scope: shared }),
    now: 100,
    statePath,
  });
  await recordObservation({
    pool: affectedPool,
    observation: observation('beta', 'exhausted', { scope: shared }),
    now: 100,
    statePath,
  });
  const probe = reservation(await reserveAccount(request({ pool: affectedPool, now: probeTime })));
  const concurrentProbe = await reserveAccount(request({ pool: otherModel, now: laterRequest }));
  await releaseReservation({ pool: affectedPool, reservationId: probe.id, now: laterRequest, statePath });
  const recovered = await reserveAccount(request({ pool: otherModel, now: laterRequest }));

  expect(concurrentProbe).toMatchObject({ kind: 'exhausted', reason: 'capacity_unavailable' });
  expect(reservation(recovered).accountId).toBe('alpha');
});

it('keeps a shared-bucket probe exclusive after its selected account is removed', async () => {
  const affectedPool = pool();
  const otherModel = pool({ modelId: 'model-two' });
  const shared = { kind: 'shared', bucketId: 'removed-probe-fixture', evidence: 'provider' } as const;
  const probeTime = 100 + RECOVERY_COOLDOWN_MS;
  const laterRequest = probeTime + RECOVERY_COOLDOWN_MS;
  await recordObservation({
    pool: affectedPool,
    observation: observation('alpha', 'exhausted', { scope: shared }),
    now: 100,
    statePath,
  });
  await recordObservation({
    pool: affectedPool,
    observation: observation('beta', 'exhausted', { scope: shared }),
    now: 100,
    statePath,
  });
  const probe = reservation(await reserveAccount(request({ pool: affectedPool, now: probeTime })));
  const afterRemoval = await reserveAccount(request({
    pool: otherModel, accounts: [account('beta')], now: laterRequest,
  }));
  await releaseReservation({ pool: affectedPool, reservationId: probe.id, now: laterRequest, statePath });
  const afterRelease = await reserveAccount(request({
    pool: otherModel, accounts: [account('beta')], now: laterRequest,
  }));

  expect(afterRemoval).toMatchObject({ kind: 'exhausted', reason: 'capacity_unavailable' });
  expect(reservation(afterRelease).accountId).toBe('beta');
});

it('allows a recovery probe after its prior reservation expires', async () => {
  const affectedPool = pool();
  await recordObservation({
    pool: affectedPool,
    observation: observation('alpha', 'exhausted', { scope: { kind: 'pool' } }),
    now: 100,
    statePath,
  });
  const probe = reservation(await reserveAccount(request({
    pool: affectedPool, accounts: [account('alpha')], now: 100 + RECOVERY_COOLDOWN_MS,
  })));
  const afterExpiry = await reserveAccount(request({
    pool: affectedPool, accounts: [account('alpha')], now: probe.expiresAt,
  }));

  expect(reservation(afterExpiry).accountId).toBe('alpha');
});

it('keeps an authentication failure unavailable without a confirmed reset', async () => {
  await recordObservation({
    pool: pool(),
    observation: observation('alpha', 'auth_failure'),
    now: 100,
    statePath,
  });

  const result = await reserveAccount(request({
    accounts: [account('alpha')],
    now: 100 + RECOVERY_COOLDOWN_MS * 5,
  }));

  expect(result).toMatchObject({ kind: 'exhausted', reason: 'capacity_unavailable' });
});

it('reuses the account whose reservation expired while another remains active', async () => {
  const first = reservation(await reserveAccount(request({ now: 100 })));
  const second = reservation(await reserveAccount(request({ now: 101 })));
  const afterExpiry = reservation(await reserveAccount(request({ now: first.expiresAt })));

  expect(second.accountId).not.toBe(first.accountId);
  expect(second.expiresAt).toBeGreaterThan(first.expiresAt);
  expect(afterExpiry.accountId).toBe(first.accountId);
  expect(afterExpiry.expiresAt).toBe(first.expiresAt + RESERVATION_TTL_MS);
});
