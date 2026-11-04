import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { dispatchWithPool } from '../src/account-pool-dispatch.js';
import type { PoolKey } from '../src/account-pool.js';
import { getAppHome } from '../src/paths.js';
import { savePreferences } from '../src/config.js';
import { saveRegistry } from '../src/registry/io.js';
import type { RegistryAccount, RegistryProvider } from '../src/registry/types.js';

const pool: PoolKey = { providerId: 'fixture-filtered-provider', modelId: 'fixture-filtered-model', billingType: 'api' };
const outerHome = process.env['LEVERFRAME_TEST_HOME'];
const previousEnv = new Map<string, string | undefined>();
let previousHome: string | undefined;
let home: string;

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function accounts(ids: string[]): RegistryAccount[] {
  return ids.map(id => ({
    id,
    authRef: `env:LEVERFRAME_POOL_${id.toUpperCase()}_CREDENTIAL`,
    enabled: true,
    modelsCache: {
      source: 'account',
      fetchedAt: '2026-10-01T00:00:00.000Z',
      models: [{ id: pool.modelId, name: pool.modelId, upstreamModelId: pool.modelId, modelFormat: 'openai' }],
    },
  }));
}

function savePool(ids: string[], pinnedAccountId?: string): RegistryProvider {
  const provider: RegistryProvider = {
    id: pool.providerId,
    templateId: 'fixture',
    name: 'Fixture pool',
    enabled: true,
    authType: 'api',
    authRef: `env:LEVERFRAME_POOL_${ids[0]!.toUpperCase()}_CREDENTIAL`,
    api: {},
    addedAt: '2026-10-01T00:00:00.000Z',
    pinnedAccountId,
    accounts: accounts(ids),
  };
  expect(outerHome).toBeTruthy();
  expect(isInside(outerHome!, getAppHome())).toBe(true);
  saveRegistry({ schemaVersion: 1, providers: [provider] });
  return provider;
}

beforeEach(() => {
  expect(outerHome).toBeTruthy();
  expect(isInside(outerHome!, getAppHome())).toBe(true);
  previousHome = process.env['LEVERFRAME_HOME'];
  mkdirSync(getAppHome(), { recursive: true });
  home = mkdtempSync(join(getAppHome(), 'pool-eligibility-'));
  process.env['LEVERFRAME_HOME'] = home;
  for (const id of ['EXCLUDED', 'ALPHA', 'BETA', 'GAMMA']) {
    const name = `LEVERFRAME_POOL_${id}_CREDENTIAL`;
    previousEnv.set(name, process.env[name]);
    process.env[name] = `synthetic-${id.toLowerCase()}-credential`;
  }
  expect(isInside(outerHome!, home)).toBe(true);
  savePreferences({ accountPoolBalancing: false, accountPoolFailover: true });
});

afterEach(() => {
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  previousEnv.clear();
  expect(outerHome).toBeTruthy();
  expect(isInside(outerHome!, home)).toBe(true);
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousHome;
  if (outerHome) expect(isInside(outerHome, getAppHome())).toBe(true);
});

it('does not dispatch to an account rejected by the eligibility predicate', async () => {
  savePool(['excluded', 'alpha'], 'excluded');
  const dispatched: string[] = [];

  const result = await dispatchWithPool({
    pool,
    eligibleAccount: account => account.id !== 'excluded',
    dispatch: async binding => {
      dispatched.push(binding.account.id);
      return { kind: 'success', value: binding.account.id };
    },
  });

  expect(result).toEqual({ kind: 'result', value: 'alpha' });
  expect(dispatched).toEqual(['alpha']);
});

it('preserves legacy account selection when no eligibility predicate is supplied', async () => {
  savePool(['excluded', 'alpha'], 'excluded');
  const dispatched: string[] = [];

  const result = await dispatchWithPool({
    pool,
    dispatch: async binding => {
      dispatched.push(binding.account.id);
      return { kind: 'success', value: binding.account.id };
    },
  });

  expect(result).toEqual({ kind: 'result', value: 'excluded' });
  expect(dispatched).toEqual(['excluded']);
});

it('keeps balancing and quota failover within eligible accounts', async () => {
  savePool(['alpha', 'beta', 'gamma'], 'alpha');
  savePreferences({ accountPoolBalancing: true, accountPoolFailover: true });
  const dispatched: string[] = [];

  const result = await dispatchWithPool({
    pool,
    sessionId: 'session-eligible-pool',
    eligibleAccount: account => account.id !== 'beta',
    dispatch: async binding => {
      dispatched.push(binding.account.id);
      return binding.account.id === 'alpha'
        ? { kind: 'failure', value: 'quota-limited', observation: {
            accountId: binding.account.id, scope: { kind: 'pool' }, source: 'fixture:rejection',
            observedAt: Date.now(), resetAt: Date.now() + 60_000, status: 'rate_limited',
          } }
        : { kind: 'success', value: binding.account.id };
    },
  });

  expect(result).toEqual({ kind: 'result', value: 'gamma' });
  expect(dispatched).toEqual(['alpha', 'gamma']);
});
