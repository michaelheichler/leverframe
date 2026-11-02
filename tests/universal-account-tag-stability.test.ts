import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { accountTag } from '../src/account-identity.js';
import { addProviderAccount, renameProviderAccount } from '../src/account-management.js';
import { removeProviderAccount } from '../src/registry/credential-lifecycle.js';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';
import type { RegistryAccount, RegistryProvider } from '../src/registry/types.js';

const credentials = vi.hoisted(() => ({ save: vi.fn(async (_authRef: string, _credential: string) => true) }));
vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  saveProviderCredential: credentials.save,
}));

const previousHome = process.env.LEVERFRAME_HOME;
let home: string;
const earlierAccountId = 'account-239';
const remainingAccountId = 'account-610';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-tag-stability-'));
  process.env.LEVERFRAME_HOME = home;
  vi.stubEnv('ACCOUNT_239', 'earlier-account-key');
  vi.stubEnv('ACCOUNT_610', 'remaining-account-key');
  credentials.save.mockReset();
  credentials.save.mockResolvedValue(true);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function account(id: string): RegistryAccount {
  return { id, authRef: `env:ACCOUNT_${id.slice('account-'.length).toUpperCase()}`, enabled: true };
}

function provider(accounts: RegistryAccount[]): RegistryProvider {
  return {
    id: 'kimi', templateId: 'kimi', name: 'Kimi', enabled: true, authType: 'api',
    authRef: accounts[0]!.authRef, api: {}, addedAt: '2026-11-02', accounts,
  };
}

function register(accounts: RegistryAccount[]): void {
  const registry = emptyRegistry();
  registry.providers.push(provider(accounts));
  saveRegistry(registry);
}

const accountMutations: Array<{ operation: string; mutate: () => Promise<unknown> }> = [
  { operation: 'removal', mutate: () => removeProviderAccount('kimi', earlierAccountId) },
  { operation: 'rename', mutate: async () => renameProviderAccount('kimi', earlierAccountId, { name: 'Renamed', tag: 'WORK' }) },
];

it.each(accountMutations)('keeps a generated tag stable after account $operation', async ({ mutate }) => {
  register([account(earlierAccountId), account(remainingAccountId)]);
  const before = loadRegistry().providers[0]!;
  const beforeAccounts = before.accounts!;
  const beforeTag = accountTag(beforeAccounts[1]!, beforeAccounts);

  await mutate();

  const after = loadRegistry().providers[0]!;
  const accounts = after.accounts!;
  const remaining = accounts.find(item => item.id === remainingAccountId)!;
  expect(remaining.tag).toBe(beforeTag);
  expect(accountTag(remaining, accounts)).toBe(beforeTag);
});

it('adds a collision-tagged account without relabeling the existing account', async () => {
  register([account(remainingAccountId)]);
  const before = loadRegistry().providers[0]!;
  const existing = before.accounts![0]!;
  const beforeTag = accountTag(existing, before.accounts!);

  await addProviderAccount('kimi', 'new-account-key', earlierAccountId);

  const accounts = loadRegistry().providers[0]!.accounts!;
  const existingAfter = accounts.find(item => item.id === remainingAccountId)!;
  const added = accounts.find(item => item.id === earlierAccountId)!;
  expect(existingAfter.tag).toBe(beforeTag);
  expect(added.tag).toBeDefined();
  expect(added.tag).not.toBe(beforeTag);
});
