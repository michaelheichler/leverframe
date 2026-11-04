import { mkdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dispatchWithPool } from '../src/account-pool-dispatch.js';
import type { PoolKey } from '../src/account-pool.js';
import { getAppHome, getProvidersPath } from '../src/paths.js';
import { savePreferences } from '../src/config.js';
import { saveRegistry } from '../src/registry/io.js';

const credentialResolver = vi.hoisted(() => ({
  values: new Map<string, string | null | Error>(),
  calls: [] as Array<[string, string]>,
}));

vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  resolveProviderAccountAuth: vi.fn(async (providerId: string, account: { id: string }) => {
    credentialResolver.calls.push([providerId, account.id]);
    if (!providerId.startsWith('fixture-')) throw new Error('Unexpected provider credential lookup.');
    const result = credentialResolver.values.get(account.id);
    if (result instanceof Error) throw result;
    return { apiKey: result ?? null };
  }),
}));

const pool: PoolKey = {
  providerId: 'fixture-missing-credential-provider',
  modelId: 'fixture-missing-credential-model',
  billingType: 'api',
};
const outerHome = process.env['LEVERFRAME_TEST_HOME'];
let previousHome: string | undefined;
let home: string | undefined;

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function setupMissingCredentialPool(accountIds: string[], pinnedAccountId?: string): void {
  if (!outerHome) throw new Error('Isolated test home is required.');
  const provider = {
    id: pool.providerId,
    templateId: 'fixture',
    name: 'Fixture credential pool',
    enabled: true,
    authType: 'api' as const,
    authRef: `keyring:fixture:${pool.providerId}:provider`,
    ...(pinnedAccountId ? { pinnedAccountId } : {}),
    api: {},
    addedAt: '2026-10-01T00:00:00.000Z',
    accounts: accountIds.map(id => ({
      id,
      authRef: `keyring:fixture:${pool.providerId}:${id}`,
      enabled: true,
    })),
  };
  expect(isInside(outerHome, getAppHome())).toBe(true);
  expect(isInside(outerHome, dirname(getProvidersPath()))).toBe(true);
  saveRegistry({ schemaVersion: 1, providers: [provider] });
}

function mockFixtureCredentialResolution(values: Record<string, string | null | Error>): void {
  credentialResolver.values.clear();
  credentialResolver.calls.length = 0;
  for (const [accountId, value] of Object.entries(values)) credentialResolver.values.set(accountId, value);
}

function readPoolReservations(): unknown[] {
  if (!home) throw new Error('Pool state has not been created for this test.');
  const statePath = join(home, 'account-pool-state.json');
  if (!outerHome || !isInside(outerHome, statePath)) throw new Error('Pool state escaped the isolated test home.');
  return (JSON.parse(readFileSync(statePath, 'utf8')) as { reservations: unknown[] }).reservations;
}

beforeEach(() => {
  if (!outerHome) throw new Error('LEVERFRAME_TEST_HOME must be set before test imports.');
  previousHome = process.env['LEVERFRAME_HOME'];
  mkdirSync(outerHome, { recursive: true });
  home = mkdtempSync(join(outerHome, 'account-pool-missing-credentials-'));
  process.env['LEVERFRAME_HOME'] = home;
  expect(isInside(outerHome, getAppHome())).toBe(true);
  credentialResolver.values.clear();
  credentialResolver.calls.length = 0;
  savePreferences({ accountPoolBalancing: false, accountPoolFailover: true });
});

afterEach(() => {
  try {
    if (outerHome && home) expect(isInside(outerHome, home)).toBe(true);
    vi.restoreAllMocks();
  } finally {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
    if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
    else process.env['LEVERFRAME_HOME'] = previousHome;
  }
});

it('returns missing accounts without dispatching when every eligible credential is empty', async () => {
  setupMissingCredentialPool(['alpha', 'beta']);
  mockFixtureCredentialResolution({ alpha: null, beta: null });
  const dispatch = vi.fn(async () => ({ kind: 'success' as const, value: 'unexpected' }));

  const result = await dispatchWithPool({
    pool,
    skipMissingCredentials: true,
    dispatch,
  });

  expect(result).toEqual({
    kind: 'exhausted', attempted: [], accounts: [], missingCredentialAccounts: ['alpha', 'beta'],
  });
  expect(dispatch).not.toHaveBeenCalled();
  expect(credentialResolver.calls).toEqual([
    [pool.providerId, 'alpha'], [pool.providerId, 'beta'],
  ]);
});

it('continues past an empty credential and releases the successful account reservation', async () => {
  setupMissingCredentialPool(['alpha', 'beta']);
  mockFixtureCredentialResolution({ alpha: null, beta: 'synthetic-account-credential' });
  const dispatched: string[] = [];

  const result = await dispatchWithPool({
    pool,
    skipMissingCredentials: true,
    dispatch: async binding => {
      dispatched.push(binding.account.id);
      return { kind: 'success', value: binding.account.id };
    },
  });

  expect(result).toEqual({ kind: 'result', value: 'beta' });
  expect(dispatched).toEqual(['beta']);
  expect(credentialResolver.calls).toEqual([
    [pool.providerId, 'alpha'], [pool.providerId, 'beta'],
  ]);
  expect(readPoolReservations()).toEqual([]);
});

it('stops at the explicitly selected account when its credential is empty', async () => {
  setupMissingCredentialPool(['alpha', 'beta']);
  mockFixtureCredentialResolution({ alpha: null, beta: 'synthetic-account-credential' });
  const dispatch = vi.fn(async () => ({ kind: 'success' as const, value: 'unexpected' }));

  const result = await dispatchWithPool({
    pool,
    accountId: 'alpha',
    skipMissingCredentials: true,
    dispatch,
  });

  expect(result).toEqual({ kind: 'exhausted', attempted: [], accounts: [], missingCredentialAccounts: ['alpha'] });
  expect(dispatch).not.toHaveBeenCalled();
  expect(credentialResolver.calls).toEqual([[pool.providerId, 'alpha']]);
});

it('stops at the first missing credential when automatic failover is disabled', async () => {
  setupMissingCredentialPool(['alpha', 'beta']);
  savePreferences({ accountPoolBalancing: false, accountPoolFailover: false });
  mockFixtureCredentialResolution({ alpha: null, beta: 'synthetic-account-credential' });
  const dispatch = vi.fn(async () => ({ kind: 'success' as const, value: 'unexpected' }));

  const result = await dispatchWithPool({
    pool,
    skipMissingCredentials: true,
    dispatch,
  });

  expect(result).toEqual({ kind: 'exhausted', attempted: [], accounts: [], missingCredentialAccounts: ['alpha'] });
  expect(dispatch).not.toHaveBeenCalled();
  expect(credentialResolver.calls).toEqual([[pool.providerId, 'alpha']]);
});

it('keeps a credential resolver error terminal instead of treating it as missing', async () => {
  setupMissingCredentialPool(['alpha', 'beta']);
  const resolverError = new Error('Fixture credential resolver failed.');
  mockFixtureCredentialResolution({ alpha: resolverError, beta: 'synthetic-account-credential' });
  const dispatch = vi.fn(async () => ({ kind: 'success' as const, value: 'unexpected' }));

  await expect(dispatchWithPool({
    pool,
    skipMissingCredentials: true,
    dispatch,
  })).rejects.toBe(resolverError);

  expect(dispatch).not.toHaveBeenCalled();
  expect(credentialResolver.calls).toEqual([[pool.providerId, 'alpha']]);
});

it('does not treat mixed missing and quota-blocked accounts as all credentials missing', async () => {
  setupMissingCredentialPool(['alpha', 'beta']);
  mockFixtureCredentialResolution({ alpha: null, beta: 'synthetic-account-credential' });
  const resetAt = Date.now() + 60_000;
  const dispatched: string[] = [];

  const result = await dispatchWithPool({
    pool,
    skipMissingCredentials: true,
    dispatch: async binding => {
      dispatched.push(binding.account.id);
      return { kind: 'failure', value: 'quota rejected', observation: {
        accountId: binding.account.id,
        scope: { kind: 'pool' },
        source: 'fixture:rejection',
        observedAt: Date.now(),
        resetAt,
        status: 'rate_limited',
      } };
    },
  });

  expect(result).toEqual({
    kind: 'exhausted', attempted: ['beta'],
    accounts: [{ accountId: 'beta', status: 'rate_limited', resetAt }],
    missingCredentialAccounts: ['alpha'],
  });
  expect(dispatched).toEqual(['beta']);
});

it('preserves the existing terminal error when missing credentials are not deferred', async () => {
  setupMissingCredentialPool(['alpha']);
  mockFixtureCredentialResolution({ alpha: null });
  const dispatch = vi.fn(async () => ({ kind: 'success' as const, value: 'unexpected' }));

  await expect(dispatchWithPool({ pool, dispatch })).rejects.toThrow();

  expect(dispatch).not.toHaveBeenCalled();
  expect(credentialResolver.calls).toEqual([[pool.providerId, 'alpha']]);
});
