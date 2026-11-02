import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dispatchWithPool } from '../src/account-pool-dispatch.js';
import { readLatestPoolActivity } from '../src/account-pool-activity.js';
import { recordObservation, type CapacityStatus, type PoolKey } from '../src/account-pool.js';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { savePreferences } from '../src/config.js';
import { saveRegistry } from '../src/registry/io.js';

const pool: PoolKey = { providerId: 'anthropic-api', modelId: 'affinity-quota-fixture', billingType: 'api' };
const alphaRef = 'keyring:provider:anthropic-api:123e4567-e89b-42d3-a456-426614174200';
const betaRef = 'keyring:provider:anthropic-api:123e4567-e89b-42d3-a456-426614174201';
const sessionId = 'fixture-coding-session';

let home: string;
let previousHome: string | undefined;
let fakeKeyring: Map<string, string>;

function saveAccounts(alphaEnabled = true, includeAlpha = true): void {
  fakeKeyring.set(alphaRef.slice('keyring:'.length), 'alpha-api-sentinel');
  fakeKeyring.set(betaRef.slice('keyring:'.length), 'beta-api-sentinel');
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: pool.providerId, templateId: pool.providerId, name: 'fixture accounts', enabled: true,
      authType: 'api', authRef: alphaRef, api: {}, addedAt: '2026-01-01',
      accounts: [
        ...(includeAlpha ? [{ id: 'alpha', authRef: alphaRef, enabled: alphaEnabled }] : []),
        { id: 'beta', authRef: betaRef, enabled: true },
      ],
    }],
  });
}

function activityRecord(): { switchReason: string; selectedAt: number } | undefined {
  const entries = JSON.parse(readFileSync(join(home, 'account-pool-activity.json'), 'utf8')) as Array<{
    pool: PoolKey; switchReason: string; selectedAt: number;
  }>;
  return entries.find(entry => entry.pool.providerId === pool.providerId
    && entry.pool.modelId === pool.modelId && entry.pool.billingType === pool.billingType);
}

function makeDispatch(seen: string[]) {
  return () => dispatchWithPool({
    pool, sessionId,
    dispatch: async binding => {
      seen.push(binding.account.id);
      return { kind: 'success', value: binding.account.id };
    },
  });
}

async function recordAccountBlock(status: CapacityStatus, observedAt: number): Promise<void> {
  await recordObservation({
    pool,
    now: observedAt,
    observation: {
      accountId: 'alpha', scope: { kind: 'pool' }, source: 'anthropic:rejection',
      dimension: 'anthropic:requests', observedAt, resetAt: observedAt + 60_000, status,
    },
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-affinity-quota-activity-'));
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

it('records quota failover when a session affinity moves away from a quota-blocked account', async () => {
  saveAccounts();
  savePreferences({ accountPoolFailover: true, accountPoolBalancing: true });
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => ++now);
  const seen: string[] = [];
  const dispatch = makeDispatch(seen);
  await dispatch();
  await recordAccountBlock('rate_limited', now + 1);

  const moved = await dispatch();
  const switchRecord = activityRecord();
  await dispatch();
  const followupRecord = activityRecord();

  expect(moved).toEqual({ kind: 'result', value: 'beta' });
  expect(seen).toEqual(['alpha', 'beta', 'beta']);
  expect(readLatestPoolActivity(pool.providerId)).toEqual({ activeAccountId: 'beta', switchReason: 'quota failover' });
  expect(followupRecord?.switchReason).toBe('quota failover');
  expect(followupRecord?.selectedAt).toBe(switchRecord?.selectedAt);
});

it('does not call an authentication failure a quota failover', async () => {
  saveAccounts();
  savePreferences({ accountPoolFailover: true, accountPoolBalancing: true });
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => ++now);
  const seen: string[] = [];
  const dispatch = makeDispatch(seen);
  await dispatch();
  await recordAccountBlock('auth_failure', now + 1);

  const result = await dispatch();

  expect(result).toEqual({ kind: 'result', value: 'beta' });
  expect(seen).toEqual(['alpha', 'beta']);
  expect(readLatestPoolActivity(pool.providerId)).toEqual({ activeAccountId: 'beta', switchReason: 'account selected' });
});

it.each([
  { label: 'disabled', alphaEnabled: false, includeAlpha: true },
  { label: 'removed', alphaEnabled: true, includeAlpha: false },
])('does not call a $label affinity account a quota failover', async ({ alphaEnabled, includeAlpha }) => {
  saveAccounts();
  savePreferences({ accountPoolFailover: true, accountPoolBalancing: true });
  const seen: string[] = [];
  const dispatch = makeDispatch(seen);
  await dispatch();
  saveAccounts(alphaEnabled, includeAlpha);

  const result = await dispatch();

  expect(result).toEqual({ kind: 'result', value: 'beta' });
  expect(seen).toEqual(['alpha', 'beta']);
  expect(readLatestPoolActivity(pool.providerId)).toEqual({ activeAccountId: 'beta', switchReason: 'account selected' });
});
