/** Because automatic failover must gate proactive affinity switching. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { dispatchWithPool } from '../src/account-pool-dispatch.js';
import { recordObservation, type PoolKey } from '../src/account-pool.js';
import { readLatestPoolActivity } from '../src/account-pool-activity.js';
import { loadPreferences, savePreferences } from '../src/config.js';
import { saveRegistry } from '../src/registry/io.js';

let home: string;
let previousHome: string | undefined;
let fakeKeyring: Map<string, string>;

const pool: PoolKey = { providerId: 'openai-oauth', modelId: 'quota-fixture', billingType: 'oauth' };
const alphaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000001';
const betaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000002';

function saveAccounts(): void {
  const credential = (access: string, accountId: string) => JSON.stringify({
    type: 'oauth', access, refresh: 'unused-refresh-fixture', expires: Date.now() + 3_600_000, accountId,
  });
  fakeKeyring.set(alphaRef.slice('keyring:'.length), credential('alpha-access-sentinel', 'alpha-account-fixture'));
  fakeKeyring.set(betaRef.slice('keyring:'.length), credential('beta-access-sentinel', 'beta-account-fixture'));
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: 'openai-oauth', templateId: 'openai-oauth', name: 'fixture accounts', enabled: true,
      authType: 'oauth', authRef: alphaRef, api: {}, addedAt: '2026-01-01',
      accounts: [
        { id: 'alpha', authRef: alphaRef, enabled: true },
        { id: 'beta', authRef: betaRef, enabled: true },
      ],
    }],
  });
}

function latestActivity(): { switchReason: string; selectedAt: number } | undefined {
  const entries = JSON.parse(readFileSync(join(home, 'account-pool-activity.json'), 'utf8')) as Array<{
    pool: PoolKey; switchReason: string; selectedAt: number;
  }>;
  return entries.find(entry => entry.pool.providerId === pool.providerId
    && entry.pool.modelId === pool.modelId && entry.pool.billingType === pool.billingType);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-quota-dispatch-'));
  previousHome = process.env.LEVERFRAME_HOME;
  process.env.LEVERFRAME_HOME = home;
  fakeKeyring = new Map();
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    if (input.operation === 'read' || input.operation === 'peek') {
      return { ok: true, value: fakeKeyring.get(input.account) ?? null };
    }
    if (input.operation === 'write') fakeKeyring.set(input.account, input.value);
    if (input.operation === 'delete') fakeKeyring.delete(input.account);
    return { ok: true, value: null };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

it.each([
  { failover: true, expectedAccounts: ['alpha', 'beta', 'beta'], expectedReason: 'quota threshold' },
  { failover: false, expectedAccounts: ['alpha', 'alpha', 'alpha'], expectedReason: 'account selected' },
])('uses automatic failover preference to gate quota switching (failover=$failover)', async ({ failover, expectedAccounts, expectedReason }) => {
  saveAccounts();
  savePreferences({ accountPoolFailover: failover, accountPoolQuotaThresholdPercent: 10 });
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => ++now);
  const seen: string[] = [];
  const dispatch = () => dispatchWithPool({
    pool, sessionId: 'fixture-coding-session',
    dispatch: async binding => {
      seen.push(binding.account.id);
      return { kind: 'success', value: 'offline' };
    },
  });
  await dispatch();
  await recordObservation({
    pool,
    observation: {
      accountId: 'alpha', scope: { kind: 'pool' }, source: 'codex:event', observedAt: now + 1,
      status: 'healthy', dimension: 'codex:weekly:secondary:10080',
      remaining: { value: 5, limit: 100, unit: 'codex:weekly:secondary:10080' },
    },
    now: now + 1,
  });
  await recordObservation({
    pool,
    observation: {
      accountId: 'beta', scope: { kind: 'pool' }, source: 'codex:event', observedAt: now + 1,
      status: 'healthy', dimension: 'codex:weekly:secondary:10080',
      remaining: { value: 70, limit: 100, unit: 'codex:weekly:secondary:10080' },
    },
    now: now + 1,
  });

  const next = await dispatch();
  await dispatch();

  expect(next).toMatchObject({ kind: 'result', value: 'offline' });
  expect(seen).toEqual(expectedAccounts);
  expect(readLatestPoolActivity(pool.providerId)?.switchReason).toBe(expectedReason);
  expect(loadPreferences().accountPoolFailover).toBe(failover);
});

it('retains the actual switch time after the new affinity handles a follow-up', async () => {
  saveAccounts();
  savePreferences({ accountPoolFailover: true, accountPoolQuotaThresholdPercent: 10 });
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => ++now);
  const seen: string[] = [];
  const dispatch = () => dispatchWithPool({
    pool, sessionId: 'stable-fixture-session',
    dispatch: async binding => {
      seen.push(binding.account.id);
      return { kind: 'success', value: 'offline' };
    },
  });
  await dispatch();
  await recordObservation({
    pool,
    observation: {
      accountId: 'alpha', scope: { kind: 'pool' }, source: 'codex:event', observedAt: now + 1,
      status: 'healthy', dimension: 'codex:weekly:secondary:10080',
      remaining: { value: 5, limit: 100, unit: 'codex:weekly:secondary:10080' },
    },
    now: now + 1,
  });
  await recordObservation({
    pool,
    observation: {
      accountId: 'beta', scope: { kind: 'pool' }, source: 'codex:event', observedAt: now + 1,
      status: 'healthy', dimension: 'codex:weekly:secondary:10080',
      remaining: { value: 70, limit: 100, unit: 'codex:weekly:secondary:10080' },
    },
    now: now + 1,
  });
  await dispatch();
  const whenSwitched = latestActivity();

  await dispatch();
  const afterFollowup = latestActivity();

  expect(seen).toEqual(['alpha', 'beta', 'beta']);
  expect(afterFollowup?.switchReason).toBe('quota threshold');
  expect(afterFollowup?.selectedAt).toBe(whenSwitched?.selectedAt);
});
