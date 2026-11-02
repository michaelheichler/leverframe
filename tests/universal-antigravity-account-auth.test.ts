import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveAntigravityAuth } from '../src/antigravity/auth.js';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { emptyRegistry, saveRegistry } from '../src/registry/io.js';
import type { RegistryAccount, RegistryProvider } from '../src/registry/types.js';

const previousHome = process.env.LEVERFRAME_HOME;
const previousEnvCredential = process.env.LEVERFRAME_KEY_ANTIGRAVITY;
let home: string;
let fakeKeyring: Map<string, string>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-antigravity-account-auth-'));
  process.env.LEVERFRAME_HOME = home;
  delete process.env.LEVERFRAME_KEY_ANTIGRAVITY;
  fakeKeyring = new Map();
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => ({
    ok: true,
    value: input.operation === 'read' || input.operation === 'peek' ? fakeKeyring.get(input.account) ?? null : null,
  }));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  if (previousEnvCredential === undefined) delete process.env.LEVERFRAME_KEY_ANTIGRAVITY;
  else process.env.LEVERFRAME_KEY_ANTIGRAVITY = previousEnvCredential;
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function credential(access: string, accountId: string, projectId: string): string {
  return JSON.stringify({
    type: 'oauth', access, refresh: 'unused-refresh', expires: Date.now() + 3_600_000,
    accountId, providerData: { projectId },
  });
}

function account(id: string, authRef: string, enabled = true): RegistryAccount {
  return { id, authRef, enabled };
}

function register(accounts: RegistryAccount[]): RegistryProvider {
  for (const item of accounts) {
    const oauthId = item.id === 'primary' ? 'oauth-primary' : 'oauth-secondary';
    const projectId = item.id === 'primary' ? 'project-primary' : 'project-secondary';
    fakeKeyring.set(item.authRef.slice('keyring:'.length), credential(`${item.id}-token`, oauthId, projectId));
  }
  const entry: RegistryProvider = {
    id: 'antigravity', templateId: 'antigravity', name: 'Google Antigravity', enabled: true,
    authType: 'oauth', authRef: accounts[0]!.authRef, api: {}, addedAt: '2026-11-02', accounts,
  };
  const registry = emptyRegistry();
  registry.providers.push(entry);
  saveRegistry(registry);
  return entry;
}

it('resolves the selected account token and managed project', async () => {
  register([
    account('primary', 'keyring:oauth:provider:antigravity::credential::v1:primary'),
    account('secondary', 'keyring:oauth:provider:antigravity::credential::v1:secondary'),
  ]);

  const auth = await resolveAntigravityAuth('oauth-secondary', { registryAccountId: 'secondary' });

  expect(auth).toEqual({
    accessToken: 'secondary-token', accountId: 'oauth-secondary', projectId: 'project-secondary',
  });
});

it('rejects a selected account whose OAuth identity differs from the refreshed catalog', async () => {
  register([account('secondary', 'keyring:oauth:provider:antigravity::credential::v1:secondary')]);

  await expect(resolveAntigravityAuth('oauth-from-another-account', { registryAccountId: 'secondary' }))
    .rejects.toMatchObject({ statusCode: 409 });
});

it.each([
  { selected: 'disabled', accounts: [account('primary', 'keyring:oauth:provider:antigravity::credential::v1:primary'), account('disabled', 'keyring:oauth:provider:antigravity::credential::v1:secondary', false)] },
  { selected: 'removed', accounts: [account('primary', 'keyring:oauth:provider:antigravity::credential::v1:primary')] },
])('does not fall back to the primary when the selected account is $selected', async ({ selected, accounts }) => {
  register(accounts);

  await expect(resolveAntigravityAuth(undefined, { registryAccountId: selected }))
    .rejects.toMatchObject({ statusCode: 401 });
});
