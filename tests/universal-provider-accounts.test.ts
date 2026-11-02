import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RegistryProvider } from '../src/registry/types.js';
import { accountTag } from '../src/account-identity.js';
import { addOAuthProviderAccount, addProviderAccount, formatProviderAccounts, renameProviderAccount } from '../src/account-management.js';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';

const credentials = vi.hoisted(() => ({ save: vi.fn(async (_authRef: string, _credential: string) => true) }));

vi.mock('../src/env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/env.js')>();
  return { ...actual, saveProviderCredential: credentials.save };
});

const previousHome = process.env.LEVERFRAME_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-provider-accounts-'));
  process.env.LEVERFRAME_HOME = home;
  credentials.save.mockReset();
  credentials.save.mockResolvedValue(true);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function account(id: string, authRef: string, enabled = true) {
  return { id, authRef, enabled };
}

function provider(id: string, authType: 'api' | 'oauth', npm = '@ai-sdk/openai'): RegistryProvider {
  return {
    id, templateId: id, name: id, enabled: true, authType,
    authRef: `keyring:provider:${id}`,
    api: { npm },
    addedAt: '2026-11-02T00:00:00Z',
    accounts: [account('primary', `keyring:provider:${id}:primary`)],
  };
}

function registerProvider(entry: RegistryProvider): void {
  const registry = emptyRegistry();
  registry.providers.push(entry);
  saveRegistry(registry);
}

it('persists account names and tags while preserving its credential reference', () => {
  registerProvider(provider('kimi', 'api'));

  expect(renameProviderAccount('kimi', 'primary', { name: 'Personal', tag: 'home' })).toBe(true);

  expect(loadRegistry().providers[0]?.accounts?.[0]).toMatchObject({
    id: 'primary', authRef: 'keyring:provider:kimi:primary', name: 'Personal', tag: 'HOME',
  });
});

it('rejects a duplicate tag without changing account metadata', () => {
  const entry = provider('kimi', 'api');
  entry.accounts?.push({ ...account('secondary', 'keyring:provider:kimi:secondary'), name: 'Team', tag: 'WORK' });
  registerProvider(entry);

  expect(renameProviderAccount('kimi', 'primary', { name: 'Other', tag: ' work ' })).toBe(false);

  expect(loadRegistry().providers[0]?.accounts).toEqual(entry.accounts);
});

it('shows the account tag and chosen name together in the provider list', () => {
  const entry = provider('kimi', 'api');
  entry.accounts![0]!.name = 'Personal';
  entry.accounts![0]!.tag = 'HOME';

  expect(formatProviderAccounts(entry)).toEqual(['[HOME] Personal (enabled)']);
});

it.each(['kimi', 'zai', 'openai', 'custom-local'])('adds API credentials without replacing the first account for %s', async providerId => {
  registerProvider(provider(providerId, 'api'));
  const initial = loadRegistry().providers[0]!;
  const primary = initial.accounts![0]!;
  const primaryTag = accountTag(primary, initial.accounts!);

  await addProviderAccount(providerId, 'api-key-value', 'secondary');

  expect(loadRegistry().providers[0]?.accounts).toMatchObject([
    expect.objectContaining({
      id: 'primary', authRef: `keyring:provider:${providerId}:primary`, enabled: true, tag: primaryTag,
    }),
    { id: 'secondary', enabled: true },
  ]);
  expect(credentials.save).toHaveBeenCalledTimes(1);
  expect(credentials.save.mock.calls[0]?.[1]).toBe('api-key-value');
});

it('rejects API credentials for an OAuth provider before storing them', async () => {
  registerProvider(provider('openai-oauth', 'oauth'));

  await expect(addProviderAccount('openai-oauth', 'api-key-value')).rejects.toThrow();

  expect(credentials.save).not.toHaveBeenCalled();
});

it('rejects Anthropic subscription credentials for the native Anthropic API provider', async () => {
  registerProvider(provider('anthropic-api', 'api', '@ai-sdk/anthropic'));

  await expect(addProviderAccount('anthropic-api', 'sk-ant-oat01-fixture')).rejects.toThrow();

  expect(credentials.save).not.toHaveBeenCalled();
});

it.each(['github-copilot', 'antigravity', 'openai-oauth'])('adds valid OAuth credentials without replacing the first account for %s', async providerId => {
  registerProvider(provider(providerId, 'oauth'));
  const credential = JSON.stringify({
    type: 'oauth', access: 'access-value', refresh: 'refresh-value', expires: Date.now() + 3_600_000,
  });

  await addOAuthProviderAccount(providerId, credential, 'secondary');

  expect(loadRegistry().providers[0]?.accounts).toMatchObject([
    account('primary', `keyring:provider:${providerId}:primary`),
    { id: 'secondary', enabled: true },
  ]);
  expect(credentials.save).toHaveBeenCalledTimes(1);
  expect(credentials.save.mock.calls[0]?.[1]).toBe(credential);
});

it('rejects malformed OAuth credentials before storing them', async () => {
  registerProvider(provider('openai-oauth', 'oauth'));

  await expect(addOAuthProviderAccount('openai-oauth', 'not-json')).rejects.toThrow();

  expect(credentials.save).not.toHaveBeenCalled();
});
