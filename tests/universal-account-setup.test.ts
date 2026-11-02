import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RegistryProvider } from '../src/registry/types.js';
import { accountTag } from '../src/account-identity.js';
import { setupProviderAccount } from '../src/account-setup.js';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';

const adapters = vi.hoisted(() => ({
  text: vi.fn(),
  password: vi.fn(),
  authenticate: vi.fn(),
  refresh: vi.fn(),
  saveCredential: vi.fn(async (_authRef: string, _value: string) => true),
}));

vi.mock('@clack/prompts', async importOriginal => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return { ...actual, text: adapters.text, password: adapters.password };
});
vi.mock('../src/registry/provider-auth.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/registry/provider-auth.js')>();
  return { ...actual, authenticateProvider: adapters.authenticate };
});
vi.mock('../src/registry/refresh-models.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/registry/refresh-models.js')>();
  return { ...actual, refreshProviderModels: adapters.refresh };
});
vi.mock('../src/env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/env.js')>();
  return { ...actual, saveProviderCredential: adapters.saveCredential };
});

const previousHome = process.env.LEVERFRAME_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-setup-'));
  process.env.LEVERFRAME_HOME = home;
  adapters.text.mockReset();
  adapters.password.mockReset();
  adapters.authenticate.mockReset();
  adapters.refresh.mockReset().mockResolvedValue({ ok: true, modelSource: 'live' });
  adapters.saveCredential.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function provider(id: string, authType: 'api' | 'oauth' | 'none'): RegistryProvider {
  return {
    id, templateId: id, name: id, enabled: true, authType,
    authRef: authType === 'none' ? 'none:anonymous' : `keyring:provider:${id}`,
    api: {}, addedAt: '2026-11-02',
    accounts: [{ id: 'primary', authRef: `keyring:provider:${id}:primary`, enabled: true }],
  };
}

function register(entry: RegistryProvider): void {
  const registry = emptyRegistry();
  registry.providers.push(entry);
  saveRegistry(registry);
}

it('creates a named API account through setup and keeps the first account', async () => {
  const entry = provider('kimi', 'api');
  const firstAccount = entry.accounts![0]!;
  const firstTag = accountTag(firstAccount, entry.accounts!);
  register(entry);
  adapters.text.mockResolvedValueOnce('Personal').mockResolvedValueOnce('HOME');
  adapters.password.mockResolvedValueOnce('api-key-value');

  await setupProviderAccount(entry);

  expect(loadRegistry().providers[0]?.accounts).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: firstAccount.id, authRef: firstAccount.authRef, enabled: firstAccount.enabled, tag: firstTag }),
    expect.objectContaining({ name: 'Personal', tag: 'HOME', enabled: true }),
  ]));
  expect(adapters.saveCredential.mock.calls[0]?.[1]).toBe('api-key-value');
});

it.each(['github-copilot', 'antigravity'])('passes account identity into OAuth sign-in for %s', async providerId => {
  const entry = provider(providerId, 'oauth');
  register(entry);
  adapters.text.mockResolvedValueOnce('Work account').mockResolvedValueOnce('TEAM');

  await setupProviderAccount(entry);

  expect(adapters.authenticate).toHaveBeenCalledWith(providerId, {
    accountIdentity: { name: 'Work account', tag: 'TEAM' },
  });
});

it('adds an anonymous local configuration without saving a credential', async () => {
  const entry = provider('custom-local', 'none');
  const firstAccount = entry.accounts![0]!;
  const firstTag = accountTag(firstAccount, entry.accounts!);
  register(entry);
  adapters.text.mockResolvedValueOnce('Laptop').mockResolvedValueOnce('HOME');

  await setupProviderAccount(entry);

  expect(loadRegistry().providers[0]?.accounts).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: firstAccount.id, authRef: firstAccount.authRef, enabled: firstAccount.enabled, tag: firstTag }),
    expect.objectContaining({ name: 'Laptop', tag: 'HOME', authRef: 'none:anonymous' }),
  ]));
  expect(adapters.saveCredential).not.toHaveBeenCalled();
});
