import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dispatchWithPool } from '../src/account-pool-dispatch.js';
import { savePreferences } from '../src/config.js';
import { saveRegistry } from '../src/registry/io.js';
import type { PoolKey } from '../src/account-pool.js';

const pool: PoolKey = { providerId: 'anthropic-api', modelId: 'shared-model', billingType: 'api' };
const previousHome = process.env.LEVERFRAME_HOME;
const previousAlpha = process.env.ACCOUNT_ALPHA_FIXTURE;
const previousBeta = process.env.ACCOUNT_BETA_FIXTURE;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-dispatch-'));
  process.env.LEVERFRAME_HOME = home;
  process.env.ACCOUNT_ALPHA_FIXTURE = 'alpha-credential';
  process.env.ACCOUNT_BETA_FIXTURE = 'beta-credential';
  savePreferences({ accountPoolBalancing: false, accountPoolFailover: true });
  saveRegistry({ schemaVersion: 1, providers: [{
    id: 'anthropic-api', templateId: 'anthropic-api', name: 'Anthropic API', enabled: true,
    authType: 'api', authRef: 'env:ACCOUNT_ALPHA_FIXTURE', api: {}, addedAt: '2026-11-02',
    accounts: [
      { id: 'alpha', authRef: 'env:ACCOUNT_ALPHA_FIXTURE', enabled: true },
      { id: 'beta', authRef: 'env:ACCOUNT_BETA_FIXTURE', enabled: true },
    ],
  }] });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  if (previousAlpha === undefined) delete process.env.ACCOUNT_ALPHA_FIXTURE;
  else process.env.ACCOUNT_ALPHA_FIXTURE = previousAlpha;
  if (previousBeta === undefined) delete process.env.ACCOUNT_BETA_FIXTURE;
  else process.env.ACCOUNT_BETA_FIXTURE = previousBeta;
  rmSync(home, { recursive: true, force: true });
});

it('keeps an account-specific request off the session affinity used by later automatic requests', async () => {
  const seen: string[] = [];
  const dispatch = (accountId?: string) => dispatchWithPool({
    pool, sessionId: 'shared-session', accountId,
    dispatch: async binding => {
      seen.push(binding.account.id);
      return { kind: 'success', value: 'ok' };
    },
  });

  await dispatch('beta');
  await dispatch();

  expect(seen).toEqual(['beta', 'alpha']);
});

it('does not fail over from a selected account after its quota is exhausted', async () => {
  const seen: string[] = [];

  await dispatchWithPool({
    pool, accountId: 'beta',
    dispatch: async binding => {
      seen.push(binding.account.id);
      return {
        kind: 'failure', value: 'quota exhausted',
        observation: {
          accountId: binding.account.id, scope: { kind: 'pool' }, source: 'anthropic:rejection',
          observedAt: Date.now(), status: 'rate_limited',
        },
      };
    },
  });

  expect(seen).toEqual(['beta']);
});
