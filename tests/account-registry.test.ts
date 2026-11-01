import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { resolveProviderAccountAuth, saveProviderCredential } from '../src/env.js';
import * as openai from '../src/oauth/openai.js';
import type { StoredOAuthCredential } from '../src/oauth/types.js';
import { migrateProviderAccounts } from '../src/registry/migrate.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';
import { removeProviderAccount } from '../src/registry/credential-lifecycle.js';
import { getProvidersPath } from '../src/paths.js';
import * as durableIO from '../src/durable-io.js';
import type { ProviderRegistry, RegistryProvider } from '../src/registry/types.js';

let home: string;
let fakeKeyring: Map<string, string>;

function provider(overrides: Partial<RegistryProvider> = {}): RegistryProvider {
  return {
    id: 'provider-fixture', templateId: 'provider-fixture', name: 'Fixture', enabled: true,
    authRef: 'keyring:provider:provider-fixture', authType: 'api', api: {}, addedAt: '2026-01-01',
    ...overrides,
  };
}

function oauthCredential(overrides: Partial<StoredOAuthCredential> = {}): StoredOAuthCredential {
  return {
    type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: 0,
    accountId: 'old-account', providerData: { organization: 'old-organization' }, ...overrides,
  };
}

function stubAccountKeyring(account: string, initial: StoredOAuthCredential): () => StoredOAuthCredential {
  let stored = JSON.stringify(initial);
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    if (input.account !== account) throw new Error('Unexpected credential account');
    if (input.operation === 'read') return { ok: true, value: stored };
    if (input.operation === 'write') {
      stored = input.value;
      return { ok: true, value: null };
    }
    throw new Error('Unexpected credential operation');
  });
  return () => JSON.parse(stored) as StoredOAuthCredential;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-registry-'));
  fakeKeyring = new Map();
  vi.stubEnv('LEVERFRAME_HOME', home);
  vi.stubEnv('LEVERFRAME_KEY_OPENAI_OAUTH', '');
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    if (input.operation === 'read' || input.operation === 'peek') {
      return { ok: true, value: fakeKeyring.get(input.account) ?? null };
    }
    if (input.operation === 'write') {
      fakeKeyring.set(input.account, input.value);
      return { ok: true, value: null };
    }
    if (input.operation === 'delete') {
      fakeKeyring.delete(input.account);
      return { ok: true, value: null };
    }
    return { ok: true, value: null };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

it('migrates legacy API and OAuth providers idempotently with their existing credentials', () => {
  const apiAuthRef = 'keyring:provider:provider-fixture';
  const oauthAuthRef = 'keyring:oauth:provider:openai-oauth';
  const registry: ProviderRegistry = {
    schemaVersion: 1,
    providers: [
      provider({ authType: 'api', authRef: apiAuthRef }),
      provider({ id: 'openai-oauth', authType: 'oauth', authRef: oauthAuthRef }),
    ],
  };
  const secondRegistry: ProviderRegistry = {
    schemaVersion: 1,
    providers: [
      provider({ authType: 'api', authRef: apiAuthRef }),
      provider({ id: 'openai-oauth', authType: 'oauth', authRef: oauthAuthRef }),
    ],
  };

  migrateProviderAccounts(registry);
  const firstMigration = registry.providers.map(item => item.accounts);
  migrateProviderAccounts(registry);
  migrateProviderAccounts(secondRegistry);

  expect(registry.providers.map(item => item.accounts)).toEqual(firstMigration);
  expect(secondRegistry.providers.map(item => item.accounts)).toEqual(firstMigration);
  expect(registry.providers.map(item => item.accounts?.[0]?.authRef)).toEqual([apiAuthRef, oauthAuthRef]);
});

it('rejects duplicate account identifiers and credential references within one provider', () => {
  const duplicateId = provider({ accounts: [
    { id: 'account-a', authRef: 'keyring:provider:a', enabled: true },
    { id: 'account-a', authRef: 'keyring:provider:b', enabled: true },
  ] });
  const duplicateRef = provider({ accounts: [
    { id: 'account-a', authRef: 'keyring:provider:a', enabled: true },
    { id: 'account-b', authRef: 'keyring:provider:a', enabled: true },
  ] });

  expect(() => saveRegistry({ schemaVersion: 1, providers: [duplicateId] })).toThrow();
  expect(() => saveRegistry({ schemaVersion: 1, providers: [duplicateRef] })).toThrow();
});

it('allows providers to share a credential reference', () => {
  const authRef = 'keyring:provider:shared';
  const registry: ProviderRegistry = {
    schemaVersion: 1,
    providers: [provider({ id: 'first', authRef }), provider({ id: 'second', authRef })],
  };

  saveRegistry(registry);

  expect(loadRegistry().providers.map(item => item.authRef)).toEqual([authRef, authRef]);
});

it('resolves and refreshes an OAuth account with its returned metadata', async () => {
  const authRef = 'keyring:oauth:provider:openai-oauth::credential::fixture';
  const stored = stubAccountKeyring(authRef.slice('keyring:'.length), oauthCredential());
  const previous = oauthCredential();
  vi.spyOn(openai, 'refreshOpenAiAccessToken').mockResolvedValue({
    access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600,
  });

  const result = await resolveProviderAccountAuth('openai-oauth', { id: 'secondary', authRef, enabled: true });

  expect(result).toEqual({
    apiKey: 'new-access', accountId: previous.accountId, providerData: previous.providerData,
  });
  expect(stored()).toMatchObject({
    access: 'new-access', refresh: 'new-refresh', accountId: previous.accountId,
    providerData: previous.providerData,
  });
});

it('uses the selected account credential instead of the provider environment override', async () => {
  vi.stubEnv('LEVERFRAME_KEY_OPENAI_OAUTH', 'provider-level-credential');
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockResolvedValue({
    ok: true, value: 'selected-account-credential',
  });

  const result = await resolveProviderAccountAuth('openai-oauth', {
    id: 'secondary', authRef: 'keyring:oauth:provider:openai-oauth::credential::fixture', enabled: true,
  });

  expect(result).toEqual({ apiKey: 'selected-account-credential' });
});

it('keeps credential material out of the published registry JSON', async () => {
  const secret = 'credential-value-that-must-stay-out-of-the-registry';
  const authRef = 'keyring:provider:opaque-reference';
  const registry: ProviderRegistry = {
    schemaVersion: 1,
    providers: [provider({ authRef })],
  };
  const path = join(home, 'providers.json');

  await expect(saveProviderCredential(authRef, secret)).resolves.toBe(true);
  await expect(resolveProviderAccountAuth('provider-fixture', {
    id: 'default', authRef, enabled: true,
  })).resolves.toEqual({ apiKey: secret });
  saveRegistry(registry, path);
  loadRegistry(path);

  const serialized = readFileSync(path, 'utf8');
  expect(serialized).not.toContain(secret);
  const persistedProvider = JSON.parse(serialized).providers[0];
  expect(persistedProvider.authRef).toBe(authRef);
  expect(persistedProvider.accounts[0].authRef).toBe(authRef);
});

it('removes an unshared account credential after its durable registry removal', async () => {
  const authRef = 'keyring:provider:provider-fixture:123e4567-e89b-42d3-a456-426614174000';
  const registry: ProviderRegistry = {
    schemaVersion: 1,
    providers: [provider({ accounts: [
      { id: 'default', authRef: 'keyring:provider:provider-fixture', enabled: true },
      { id: 'secondary', authRef, enabled: true },
    ] })],
  };
  saveRegistry(registry, getProvidersPath());
  const operations: string[] = [];
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    operations.push(input.operation);
    if (input.operation === 'read') return { ok: true, value: 'account-secret' };
    if (input.operation === 'delete') return { ok: true, value: null };
    throw new Error('Unexpected credential operation');
  });

  const result = await removeProviderAccount('provider-fixture', 'secondary');

  expect(result).toEqual({ removed: true, credentialDeleted: true });
  expect(loadRegistry().providers[0]!.accounts?.map(account => account.id)).toEqual(['default']);
  expect(operations).toContain('delete');
});

it('retains a credential still referenced by another provider account', async () => {
  const sharedRef = 'keyring:provider:provider-fixture:123e4567-e89b-42d3-a456-426614174000';
  saveRegistry({
    schemaVersion: 1,
    providers: [
      provider({ accounts: [
        { id: 'default', authRef: 'keyring:provider:provider-fixture', enabled: true },
        { id: 'secondary', authRef: sharedRef, enabled: true },
      ] }),
      provider({ id: 'second-provider', authRef: sharedRef }),
    ],
  }, getProvidersPath());
  let credential = 'shared-account-secret';
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    if (input.operation === 'read') return { ok: true, value: credential };
    if (input.operation === 'delete') {
      credential = '';
      return { ok: true, value: null };
    }
    throw new Error('Unexpected credential operation');
  });

  const result = await removeProviderAccount('provider-fixture', 'secondary');
  const remaining = await resolveProviderAccountAuth('second-provider', {
    id: 'default', authRef: sharedRef, enabled: true,
  });

  expect(result).toEqual({ removed: true, credentialDeleted: false });
  expect(remaining).toEqual({ apiKey: 'shared-account-secret' });
});

it('retains the old account and credential when registry publication fails', async () => {
  const authRef = 'keyring:provider:provider-fixture:123e4567-e89b-42d3-a456-426614174000';
  saveRegistry({
    schemaVersion: 1,
    providers: [provider({ accounts: [
      { id: 'default', authRef: 'keyring:provider:provider-fixture', enabled: true },
      { id: 'secondary', authRef, enabled: true },
    ] })],
  }, getProvidersPath());
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockResolvedValue({
    ok: true, value: 'account-secret',
  });
  const durableWrite = durableIO.durableAtomicWrite;
  vi.spyOn(durableIO, 'durableAtomicWrite').mockImplementation((path, content, options) => {
    if (path === getProvidersPath()) throw new Error('Registry publication failed');
    durableWrite(path, content, options);
  });

  await expect(removeProviderAccount('provider-fixture', 'secondary')).rejects.toThrow();

  expect(loadRegistry().providers[0]!.accounts?.map(account => account.id)).toEqual(['default', 'secondary']);
  await expect(resolveProviderAccountAuth('provider-fixture', {
    id: 'secondary', authRef, enabled: true,
  })).resolves.toEqual({ apiKey: 'account-secret' });
});
