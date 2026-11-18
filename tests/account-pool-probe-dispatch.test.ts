import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RECOVERY_COOLDOWN_MS, type CapacityObservation, type PoolKey } from '../src/account-pool.js';
import { dispatchWithPool, poolExhaustionMessage, type PoolAttempt } from '../src/account-pool-dispatch.js';
import { savePreferences } from '../src/config.js';
import { saveRegistry } from '../src/registry/io.js';

const pool: PoolKey = { providerId: 'anthropic-api', modelId: 'probe-model', billingType: 'api' };
const START = 1_800_000_000_000;
const previousHome = process.env.LEVERFRAME_HOME;
const previousAlpha = process.env.ACCOUNT_ALPHA_FIXTURE;
const previousBeta = process.env.ACCOUNT_BETA_FIXTURE;
let home: string;
let now: number;

function rejected(accountId: string, status: 'rate_limited' | 'auth_failure'): PoolAttempt<string> {
  const observation: CapacityObservation = status === 'auth_failure'
    ? { accountId, scope: { kind: 'account' }, source: 'anthropic-api:authentication', dimension: 'authentication',
      observedAt: now, status }
    : { accountId, scope: { kind: 'pool' }, source: 'anthropic-api:rejection', observedAt: now, status };
  return { kind: 'failure', value: `${accountId} ${status}`, observation };
}

async function rateLimitEveryAccount(): Promise<void> {
  await dispatchWithPool({ pool, dispatch: async binding => rejected(binding.account.id, 'rate_limited') });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-probe-dispatch-'));
  process.env.LEVERFRAME_HOME = home;
  process.env.ACCOUNT_ALPHA_FIXTURE = 'alpha-credential';
  process.env.ACCOUNT_BETA_FIXTURE = 'beta-credential';
  now = START;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  savePreferences({ accountPoolBalancing: false, accountPoolFailover: true });
  saveRegistry({ schemaVersion: 1, providers: [{
    id: 'anthropic-api', templateId: 'anthropic-api', name: 'Anthropic API', enabled: true,
    authType: 'api', authRef: 'env:ACCOUNT_ALPHA_FIXTURE', api: {}, addedAt: '2026-11-18',
    accounts: [
      { id: 'alpha', authRef: 'env:ACCOUNT_ALPHA_FIXTURE', enabled: true },
      { id: 'beta', authRef: 'env:ACCOUNT_BETA_FIXTURE', enabled: true },
    ],
  }] });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  if (previousAlpha === undefined) delete process.env.ACCOUNT_ALPHA_FIXTURE;
  else process.env.ACCOUNT_ALPHA_FIXTURE = previousAlpha;
  if (previousBeta === undefined) delete process.env.ACCOUNT_BETA_FIXTURE;
  else process.env.ACCOUNT_BETA_FIXTURE = previousBeta;
  rmSync(home, { recursive: true, force: true });
});

it('fails over to the next account when a recovery probe meets an authentication failure', async () => {
  await rateLimitEveryAccount();
  now = START + RECOVERY_COOLDOWN_MS;
  const seen: string[] = [];

  const result = await dispatchWithPool({
    pool,
    dispatch: async binding => {
      seen.push(binding.account.id);
      return binding.account.id === 'alpha' ? rejected('alpha', 'auth_failure') : { kind: 'success', value: 'beta answered' };
    },
  });

  expect(seen).toEqual(['alpha', 'beta']);
  expect(result).toEqual({ kind: 'result', value: 'beta answered' });
});

it('returns an authentication failure from an unblocked account to the client', async () => {
  const seen: string[] = [];

  const result = await dispatchWithPool({
    pool,
    dispatch: async binding => {
      seen.push(binding.account.id);
      return binding.account.id === 'alpha' ? rejected('alpha', 'auth_failure') : { kind: 'success', value: 'beta answered' };
    },
  });

  expect(seen).toEqual(['alpha']);
  expect(result).toEqual({ kind: 'result', value: 'alpha auth_failure' });
});

it('labels provider resets and names the next upstream retry time in the exhaustion message', () => {
  const resetAt = Date.parse('2026-11-18T18:09:00.000Z');
  const retryAt = Date.parse('2026-11-18T02:06:00.000Z');

  const message = poolExhaustionMessage({
    kind: 'exhausted', attempted: [],
    accounts: [{ accountId: 'alpha', status: 'rate_limited', resetAt, retryAt }],
  });

  expect(message).toContain('Provider-reported resets: alpha: 2026-11-18T18:09:00.000Z.');
  expect(message).toContain('Next upstream retry: alpha: 2026-11-18T02:06:00.000Z.');
  expect(message).not.toContain('Confirmed resets');
});
