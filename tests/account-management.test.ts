import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as prompts from '@clack/prompts';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { loadPreferences, savePreferences } from '../src/config.js';
import { getProvidersPath } from '../src/paths.js';
import { resolveProviderAccountAuth } from '../src/env.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';
import { removeProviderFromRegistry } from '../src/registry/crud.js';
import * as durableIO from '../src/durable-io.js';
import { saveNativeOAuthCredential } from '../src/registry/provider-auth.js';
import {
  addProviderAccount,
  formatProviderAccounts,
  importProviderAccount,
  pinProviderAccount,
} from '../src/account-management.js';
import { runAccountPoolSettings } from '../src/account-management-prompts.js';
import { runAccountManagement } from '../src/account-management-prompts.js';
import { runProvidersRemove } from '../src/providers-command-crud.js';
import type { ProviderRegistry, RegistryProvider } from '../src/registry/types.js';

const settingsPrompt = vi.hoisted(() => ({
  responses: [] as string[],
  textResponses: [] as string[],
  confirmations: [] as boolean[],
  warnings: [] as string[],
  infos: [] as string[],
  successes: [] as string[],
  errors: [] as string[],
}));

vi.mock('@clack/prompts', async importOriginal => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return {
    ...actual,
    select: vi.fn(async (_options: unknown) => settingsPrompt.responses.shift()),
    text: vi.fn(async (_options: unknown) => settingsPrompt.textResponses.shift()),
    confirm: vi.fn(async (_options: unknown) => settingsPrompt.confirmations.shift()),
    log: {
      ...actual.log,
      warn: vi.fn((message: string) => settingsPrompt.warnings.push(message)),
      info: vi.fn((message: string) => settingsPrompt.infos.push(message)),
      success: vi.fn((message: string) => settingsPrompt.successes.push(message)),
      error: vi.fn((message: string) => settingsPrompt.errors.push(message)),
    },
  };
});

let home: string;
let keyring: Map<string, string>;
let failedDeletes: Set<string>;

function provider(overrides: Partial<RegistryProvider> = {}): RegistryProvider {
  return {
    id: 'anthropic-api', templateId: 'anthropic-api', name: 'Anthropic API', enabled: true,
    authRef: 'keyring:provider:anthropic-api', authType: 'api', api: {}, addedAt: '2026-01-01',
    accounts: [{ id: 'default', authRef: 'keyring:provider:anthropic-api', enabled: true }],
    ...overrides,
  };
}

function registry(providers: RegistryProvider[]): ProviderRegistry {
  return { schemaVersion: 1, providers };
}

function oauthProvider(overrides: Partial<RegistryProvider> = {}): RegistryProvider {
  return provider({
    id: 'openai-oauth', templateId: 'openai-oauth', name: 'OpenAI (ChatGPT)', authType: 'oauth',
    authRef: 'keyring:oauth:provider:openai-oauth',
    accounts: [{ id: 'primary', authRef: 'keyring:oauth:provider:openai-oauth', enabled: true }],
    ...overrides,
  });
}

async function resolveAddedAccount(account: { id: string; authRef: string; enabled: boolean }): Promise<string | null> {
  return (await resolveProviderAccountAuth('anthropic-api', account)).apiKey;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-management-'));
  keyring = new Map();
  failedDeletes = new Set();
  vi.stubEnv('HOME', home);
  vi.stubEnv('LEVERFRAME_HOME', join(home, '.leverframe'));
  settingsPrompt.responses = [];
  settingsPrompt.textResponses = [];
  settingsPrompt.confirmations = [];
  settingsPrompt.warnings = [];
  settingsPrompt.infos = [];
  settingsPrompt.successes = [];
  settingsPrompt.errors = [];
  vi.mocked(prompts.select).mockClear();
  vi.mocked(prompts.text).mockClear();
  vi.mocked(prompts.confirm).mockClear();
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    const account = input.account;
    if (input.operation === 'read' || input.operation === 'peek') {
      return { ok: true, value: keyring.get(account) ?? null };
    }
    if (input.operation === 'write') {
      keyring.set(account, input.value);
      return { ok: true, value: null };
    }
    if (input.operation === 'delete') {
      if (failedDeletes.has(account)) return { ok: false, error: 'fixture credential deletion failed' };
      keyring.delete(account);
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

it('defaults account balancing and quota failover to enabled', () => {
  expect(loadPreferences()).toMatchObject({ accountPoolBalancing: true, accountPoolFailover: true });
});

it.each([
  { selection: 'balancing', expected: { accountPoolBalancing: false, accountPoolFailover: true } },
  { selection: 'failover', expected: { accountPoolBalancing: true, accountPoolFailover: false } },
])('persists the $selection terminal setting independently', async ({ selection, expected }) => {
  settingsPrompt.responses = [selection, 'back'];

  await runAccountPoolSettings();

  expect(prompts.select).toHaveBeenCalledTimes(2);
  expect(loadPreferences()).toMatchObject(expected);
});

it('persists paid summary opt-in from the account settings menu', async () => {
  settingsPrompt.responses = ['summary-toggle', 'back'];

  await runAccountPoolSettings();

  expect(loadPreferences().summarySettings?.enabled).toBe(true);
});

it('saves the selected summary engine and explicit lifetime spending limit', async () => {
  settingsPrompt.responses = ['summary-configure', 'back'];
  settingsPrompt.textResponses = ['openai:fixture-model', '0.008', '0.002', '0.003', 'fixture-rate-card'];

  await runAccountPoolSettings();

  expect(loadPreferences().summarySettings).toEqual({
    enabled: false,
    engineId: 'openai:fixture-model',
    lifetimeLimitMicros: 8_000,
    pricing: { inputMicrosPerMillion: 2_000, outputMicrosPerMillion: 3_000, provenance: 'fixture-rate-card' },
  });
});

it('converts USD settings to exact micros before persisting them', async () => {
  settingsPrompt.responses = ['summary-configure', 'back'];
  settingsPrompt.textResponses = ['openai:fixture-model', '0.000001', '0.123456', '1.000001', 'fixture-rate-card'];

  await runAccountPoolSettings();

  expect(loadPreferences().summarySettings).toEqual({
    enabled: false,
    engineId: 'openai:fixture-model',
    lifetimeLimitMicros: 1,
    pricing: { inputMicrosPerMillion: 123_456, outputMicrosPerMillion: 1_000_001, provenance: 'fixture-rate-card' },
  });
});

it.each(['0', '-1', '1.0000001', '9007199254.740992', 'not-a-price'])('does not save unsupported lifetime USD input %s', async lifetime => {
  settingsPrompt.responses = ['summary-configure', 'back'];
  settingsPrompt.textResponses = ['openai:fixture-model', lifetime];

  await runAccountPoolSettings();

  expect(loadPreferences().summarySettings).toEqual({ enabled: false });
});

it('accepts zero input and output prices', async () => {
  settingsPrompt.responses = ['summary-configure', 'back'];
  settingsPrompt.textResponses = ['openai:fixture-model', '0.000001', '0', '0', 'fixture-rate-card'];

  await runAccountPoolSettings();

  expect(loadPreferences().summarySettings).toEqual({
    enabled: false,
    engineId: 'openai:fixture-model',
    lifetimeLimitMicros: 1,
    pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, provenance: 'fixture-rate-card' },
  });
});

it('adds an API account without replacing the provider first account', async () => {
  const original = provider();
  const accountId = 'secondary';
  saveRegistry(registry([original]), getProvidersPath());

  const added = await addProviderAccount('anthropic-api', 'new-api-key', accountId);
  const saved = loadRegistry().providers[0]!;

  expect(saved.accounts?.[0]).toEqual(original.accounts?.[0]);
  expect(saved.accounts).toContainEqual(added);
  expect(added.id).toBe(accountId);
  expect(added.authRef).not.toBe(original.accounts?.[0]?.authRef);
  await expect(resolveAddedAccount(added)).resolves.toBe('new-api-key');
});

it('does not retain an API credential when account publication fails', async () => {
  saveRegistry(registry([provider()]), getProvidersPath());
  const durableWrite = durableIO.durableAtomicWrite;
  vi.spyOn(durableIO, 'durableAtomicWrite').mockImplementation((path, content, options) => {
    if (path === getProvidersPath()) throw new Error('Registry publication failed');
    durableWrite(path, content, options);
  });

  await expect(addProviderAccount('anthropic-api', 'unpublished-api-key')).rejects.toThrow();

  expect(loadRegistry().providers[0]?.accounts).toEqual(provider().accounts);
  expect(keyring.size).toBe(0);
});

it('pins an existing account while balancing is disabled', () => {
  savePreferences({ accountPoolBalancing: false });
  saveRegistry(registry([provider({ accounts: [
    { id: 'default', authRef: 'keyring:provider:anthropic-api', enabled: true },
    { id: 'secondary', authRef: 'keyring:provider:anthropic-api:123e4567-e89b-42d3-a456-426614174000', enabled: true },
  ] })]), getProvidersPath());

  expect(pinProviderAccount('anthropic-api', 'secondary')).toBe(true);
  expect(loadRegistry().providers[0]?.pinnedAccountId).toBe('secondary');
  expect(loadPreferences().accountPoolBalancing).toBe(false);
});

it('does not publish a pin when registry persistence fails', () => {
  saveRegistry(registry([provider({ accounts: [
    { id: 'primary', authRef: 'keyring:provider:anthropic-api', enabled: true },
    { id: 'secondary', authRef: 'keyring:provider:anthropic-api:123e4567-e89b-42d3-a456-426614174000', enabled: true },
  ] })]), getProvidersPath());
  const durableWrite = durableIO.durableAtomicWrite;
  vi.spyOn(durableIO, 'durableAtomicWrite').mockImplementation((path, content, options) => {
    if (path === getProvidersPath()) throw new Error('Registry publication failed');
    durableWrite(path, content, options);
  });

  expect(() => pinProviderAccount('anthropic-api', 'secondary')).toThrow();

  expect(loadRegistry().providers[0]?.pinnedAccountId).toBeUndefined();
});

it('imports a Codex OAuth account without replacing the existing ChatGPT account', async () => {
  saveRegistry(registry([oauthProvider()]), getProvidersPath());
  const authPath = join(homedir(), '.codex', 'auth.json');
  mkdirSync(join(homedir(), '.codex'), { recursive: true });
  writeFileSync(authPath, JSON.stringify({
    tokens: { access_token: 'codex-import-access', refresh_token: 'codex-import-refresh', account_id: 'codex-account' },
    last_refresh: new Date().toISOString(),
  }));

  const imported = await importProviderAccount('openai-oauth', 'codex');
  const saved = loadRegistry().providers.find(item => item.id === 'openai-oauth')!;
  const resolved = await resolveProviderAccountAuth('openai-oauth', imported);

  expect(saved.accounts?.[0]).toEqual(oauthProvider().accounts?.[0]);
  expect(saved.accounts).toContainEqual(imported);
  expect(imported.authRef).not.toBe(saved.accounts?.[0]?.authRef);
  expect(resolved).toMatchObject({ apiKey: 'codex-import-access', accountId: 'codex-account' });
});

it('routes a second ChatGPT sign-in to a distinct account credential', async () => {
  saveRegistry(registry([oauthProvider()]), getProvidersPath());
  const firstAccount = oauthProvider().accounts![0]!;

  await saveNativeOAuthCredential('openai-oauth', {
    access_token: 'second-login-access', refresh_token: 'second-login-refresh', expires_in: 3600,
  }, 'second-login-account');

  const saved = loadRegistry().providers[0]!;
  const secondAccount = saved.accounts!.find(account => account.id !== firstAccount.id)!;
  const resolved = await resolveProviderAccountAuth('openai-oauth', secondAccount);

  expect(saved.accounts).toHaveLength(2);
  expect(saved.accounts).toContainEqual(firstAccount);
  expect(secondAccount.authRef).not.toBe(firstAccount.authRef);
  expect(resolved).toMatchObject({ apiKey: 'second-login-access', accountId: 'second-login-account' });
});

it('imports an Anthropic API key only through explicit environment import', async () => {
  saveRegistry(registry([provider()]), getProvidersPath());
  vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-environment-key');

  const imported = await importProviderAccount('anthropic-api', 'anthropic-env');
  const saved = loadRegistry().providers[0]!;

  expect(saved.accounts).toContainEqual(imported);
  expect(imported.authRef).not.toBe(saved.accounts?.[0]?.authRef);
  await expect(resolveAddedAccount(imported)).resolves.toBe('anthropic-environment-key');
});

it('rejects account pools for the Claude subscription provider', async () => {
  saveRegistry(registry([provider({
    id: 'anthropic', templateId: 'anthropic', name: 'Anthropic subscription',
    authRef: 'keyring:provider:anthropic',
    accounts: [{ id: 'subscription', authRef: 'keyring:provider:anthropic', enabled: true }],
  })]), getProvidersPath());

  await expect(addProviderAccount('anthropic', 'subscription-token')).rejects.toThrow();
  expect(loadRegistry().providers[0]?.accounts).toHaveLength(1);
});

it('rejects a Claude subscription token when adding an Anthropic API account', async () => {
  saveRegistry(registry([provider()]), getProvidersPath());

  await expect(addProviderAccount('anthropic-api', 'sk-ant-oat01-test-fixture')).rejects.toThrow();

  expect(loadRegistry().providers[0]?.accounts).toEqual(provider().accounts);
  expect(keyring.size).toBe(0);
});

it('rejects a Claude subscription token during explicit Anthropic environment import', async () => {
  saveRegistry(registry([provider()]), getProvidersPath());
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-oat01-test-fixture');

  await expect(importProviderAccount('anthropic-api', 'anthropic-env')).rejects.toThrow();

  expect(loadRegistry().providers[0]?.accounts).toEqual(provider().accounts);
  expect(keyring.size).toBe(0);
});

it('removes every unshared account credential while retaining a cross-provider reference', async () => {
  const primaryRef = 'keyring:provider:anthropic-api:123e4567-e89b-42d3-a456-426614174000';
  const sharedRef = 'keyring:provider:anthropic-api:123e4567-e89b-42d3-a456-426614174001';
  keyring.set(primaryRef.slice('keyring:'.length), 'primary-api-key');
  keyring.set(sharedRef.slice('keyring:'.length), 'shared-api-key');
  saveRegistry(registry([
    provider({
      authRef: primaryRef,
      accounts: [
        { id: 'primary', authRef: primaryRef, enabled: true },
        { id: 'secondary', authRef: sharedRef, enabled: true },
      ],
    }),
    provider({
      id: 'openai', templateId: 'openai', name: 'OpenAI', authRef: sharedRef,
      accounts: [{ id: 'shared', authRef: sharedRef, enabled: true }],
    }),
  ]), getProvidersPath());

  const result = await removeProviderFromRegistry('anthropic-api');
  const remaining = loadRegistry().providers[0]!;

  expect(result.removed).toBe(true);
  expect(loadRegistry().providers.map(item => item.id)).toEqual(['openai']);
  await expect(resolveProviderAccountAuth('anthropic-api', {
    id: 'primary', authRef: primaryRef, enabled: true,
  })).resolves.toMatchObject({ apiKey: null });
  await expect(resolveProviderAccountAuth('openai', remaining.accounts![0]!))
    .resolves.toMatchObject({ apiKey: 'shared-api-key' });
});

it('retains provider credentials when provider removal cannot be published', async () => {
  const authRef = 'keyring:provider:anthropic-api:123e4567-e89b-42d3-a456-426614174000';
  keyring.set(authRef.slice('keyring:'.length), 'api-key-before-removal');
  saveRegistry(registry([provider({
    authRef,
    accounts: [{ id: 'primary', authRef, enabled: true }],
  })]), getProvidersPath());
  const durableWrite = durableIO.durableAtomicWrite;
  vi.spyOn(durableIO, 'durableAtomicWrite').mockImplementation((path, content, options) => {
    if (path === getProvidersPath()) throw new Error('Registry publication failed');
    durableWrite(path, content, options);
  });

  await expect(removeProviderFromRegistry('anthropic-api')).rejects.toThrow();

  expect(loadRegistry().providers).toHaveLength(1);
  await expect(resolveAddedAccount({ id: 'primary', authRef, enabled: true }))
    .resolves.toBe('api-key-before-removal');
});

it('shows account status and switch reason without credential references', () => {
  const entry = oauthProvider({ accounts: [
    { id: 'main-account', authRef: 'keyring:oauth:provider:openai-oauth::credential::fixture', enabled: true },
  ] });

  const display = formatProviderAccounts(entry, {
    activeAccountId: 'main-account', switchReason: 'Quota reset completed',
  }).join('\n');

  expect(display).toContain('main-account');
  expect(display).toContain('Quota reset completed');
  expect(display).not.toContain(entry.accounts![0]!.authRef);
});

it('offers only enabled accounts in the pin chooser', async () => {
  saveRegistry(registry([provider({ accounts: [
    { id: 'primary', authRef: 'keyring:provider:anthropic-api', enabled: true },
    { id: 'dormant', authRef: 'keyring:provider:anthropic-api:123e4567-e89b-42d3-a456-426614174000', enabled: false },
  ] })]), getProvidersPath());
  settingsPrompt.responses = ['pin', 'primary', 'back'];

  await runAccountManagement('anthropic-api');

  const accountOptions = vi.mocked(prompts.select).mock.calls[1]![0] as { options: Array<{ value: string }> };
  expect(accountOptions.options.map(option => option.value)).toEqual(['primary']);
});

it('warns when a selected account can no longer be pinned', async () => {
  saveRegistry(registry([provider({ accounts: [
    { id: 'primary', authRef: 'keyring:provider:anthropic-api', enabled: true },
    { id: 'dormant', authRef: 'keyring:provider:anthropic-api:123e4567-e89b-42d3-a456-426614174000', enabled: false },
  ] })]), getProvidersPath());
  settingsPrompt.responses = ['pin', 'dormant', 'back'];

  await runAccountManagement('anthropic-api');

  expect(settingsPrompt.warnings).toHaveLength(1);
});

it('warns when account removal reports that no account was removed', async () => {
  saveRegistry(registry([provider()]), getProvidersPath());
  settingsPrompt.responses = ['remove', 'stale-selection', 'back'];
  settingsPrompt.confirmations = [true];

  await runAccountManagement('anthropic-api');

  expect(settingsPrompt.warnings).toHaveLength(1);
});

it('warns when account removal leaves a credential cleanup error', async () => {
  const accountRef = 'keyring:provider:anthropic-api:123e4567-e89b-42d3-a456-426614174000';
  saveRegistry(registry([provider({ accounts: [
    { id: 'primary', authRef: 'keyring:provider:anthropic-api', enabled: true },
    { id: 'secondary', authRef: accountRef, enabled: true },
  ] })]), getProvidersPath());
  keyring.set(accountRef.slice('keyring:'.length), 'secondary-api-key');
  failedDeletes.add(accountRef.slice('keyring:'.length));
  settingsPrompt.responses = ['remove', 'secondary', 'back'];
  settingsPrompt.confirmations = [true];

  await runAccountManagement('anthropic-api');

  expect(loadRegistry().providers[0]?.accounts?.map(account => account.id)).toEqual(['primary']);
  expect(settingsPrompt.warnings).toHaveLength(1);
});

it('reports successful account removal and confirmed credential cleanup', async () => {
  const accountRef = 'keyring:provider:anthropic-api:123e4567-e89b-42d3-a456-426614174000';
  saveRegistry(registry([provider({
    authRef: accountRef,
    accounts: [{ id: 'secondary', authRef: accountRef, enabled: true }],
  })]), getProvidersPath());
  keyring.set(accountRef.slice('keyring:'.length), 'secondary-api-key');
  settingsPrompt.responses = ['remove', 'secondary', 'back'];
  settingsPrompt.confirmations = [true];

  await runAccountManagement('anthropic-api');

  expect(settingsPrompt.successes).toHaveLength(1);
  expect(settingsPrompt.infos).toHaveLength(2);
  expect(settingsPrompt.warnings).toHaveLength(0);
});

it('reports partial provider credential cleanup without claiming full deletion', async () => {
  const firstRef = 'keyring:provider:anthropic-api:123e4567-e89b-42d3-a456-426614174000';
  const secondRef = 'keyring:provider:anthropic-api:123e4567-e89b-42d3-a456-426614174001';
  keyring.set(firstRef.slice('keyring:'.length), 'first-api-key');
  keyring.set(secondRef.slice('keyring:'.length), 'second-api-key');
  failedDeletes.add(secondRef.slice('keyring:'.length));
  saveRegistry(registry([provider({
    authRef: firstRef,
    accounts: [
      { id: 'first', authRef: firstRef, enabled: true },
      { id: 'second', authRef: secondRef, enabled: true },
    ],
  })]), getProvidersPath());
  settingsPrompt.confirmations = [true];

  const result = await runProvidersRemove('anthropic-api', true);

  expect(result).toBe(0);
  expect(settingsPrompt.warnings).toHaveLength(1);
  expect(settingsPrompt.infos).toHaveLength(0);
});
