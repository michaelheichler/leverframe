import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { dispatchWithPool } from '../src/account-pool-dispatch.js';
import { recordObservation, type PoolKey } from '../src/account-pool.js';
import { readLatestPoolActivity } from '../src/account-pool-activity.js';
import { savePreferences } from '../src/config.js';
import { saveRegistry } from '../src/registry/io.js';

const pool: PoolKey = { providerId: 'anthropic-api', modelId: 'pinned-fixture', billingType: 'api' };
const alphaRef = 'keyring:provider:anthropic-api:123e4567-e89b-42d3-a456-426614174100';
const betaRef = 'keyring:provider:anthropic-api:123e4567-e89b-42d3-a456-426614174101';

let home: string;
let previousHome: string | undefined;
let fakeKeyring: Map<string, string>;

function savePinnedAccounts(): void {
  fakeKeyring.set(alphaRef.slice('keyring:'.length), 'alpha-api-sentinel');
  fakeKeyring.set(betaRef.slice('keyring:'.length), 'beta-api-sentinel');
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: pool.providerId, templateId: pool.providerId, name: 'fixture accounts', enabled: true,
      authType: 'api', authRef: alphaRef, pinnedAccountId: 'alpha', api: {}, addedAt: '2026-01-01',
      accounts: [
        { id: 'alpha', authRef: alphaRef, enabled: true },
        { id: 'beta', authRef: betaRef, enabled: true },
      ],
    }],
  });
}

async function seedPoolGenerations(): Promise<void> {
  await dispatchWithPool({
    pool,
    dispatch: async binding => ({ kind: 'success', value: binding.account.id }),
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-pinned-quota-exhaustion-'));
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

it('retains the skipped pinned quota window through exhaustion without reporting it as attempted', async () => {
  savePinnedAccounts();
  savePreferences({ accountPoolBalancing: false, accountPoolFailover: true });
  const now = 10_000_000;
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const resetAt = now + 60_000;
  await seedPoolGenerations();
  await recordObservation({
    pool, now,
    observation: {
      accountId: 'alpha', scope: { kind: 'pool' }, source: 'anthropic:rejection',
      dimension: 'anthropic:requests', observedAt: now, resetAt, status: 'rate_limited',
    },
  });
  const result = await dispatchWithPool({
    pool,
    dispatch: async binding => binding.account.id === 'beta'
      ? {
          kind: 'failure', value: { safe: 'quota rejection' },
          observation: {
            accountId: 'beta', scope: { kind: 'pool' }, source: 'anthropic:rejection',
            dimension: 'anthropic:requests', observedAt: now, resetAt, status: 'rate_limited',
          },
        }
      : { kind: 'success', value: { safe: 'unexpected pin attempt' } },
  });

  expect(result).toEqual({
    kind: 'exhausted', attempted: ['beta'],
    accounts: expect.arrayContaining([
      { accountId: 'alpha', status: 'rate_limited', resetAt },
      { accountId: 'beta', status: 'rate_limited', resetAt },
    ]),
  });
  expect(result.kind === 'exhausted' ? result.accounts : []).toHaveLength(2);
  expect(readLatestPoolActivity(pool.providerId)).toEqual({ activeAccountId: 'beta', switchReason: 'quota failover' });
});
