import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CachedModel, RegistryAccount, RegistryProvider } from '../src/registry/types.js';
import { refreshAccountCatalogs } from '../src/registry/account-catalogs.js';
import { emptyRegistry, loadRegistry, saveRegistry, updateRegistry } from '../src/registry/io.js';

const previousHome = process.env.LEVERFRAME_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-catalogs-'));
  process.env.LEVERFRAME_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function cachedModel(id: string): CachedModel {
  return { id, upstreamModelId: id, name: id, modelFormat: 'openai' };
}

function account(id: string, authRef: string): RegistryAccount {
  return { id, authRef, enabled: true };
}

function provider(accounts = [
  account('primary', 'keyring:provider:kimi:primary'),
  account('secondary', 'keyring:provider:kimi:secondary'),
]): RegistryProvider {
  return {
    id: 'kimi', templateId: 'kimi', name: 'Kimi', enabled: true, authType: 'api',
    authRef: accounts[0]!.authRef, api: {}, addedAt: '2026-11-02', accounts,
  };
}

function register(entry: RegistryProvider): void {
  const registry = emptyRegistry();
  registry.providers.push(entry);
  saveRegistry(registry);
}

function startOverlappingRefreshes(entry: RegistryProvider): {
  first: Promise<unknown>;
  second: Promise<unknown>;
  started: Promise<void>;
  pending: Array<{
    resolve: (value: { models: CachedModel[] }) => void;
    reject: (error: Error) => void;
  }>;
} {
  let announceBothStarted!: () => void;
  const started = new Promise<void>(resolve => { announceBothStarted = resolve; });
  const pending: Array<{
    resolve: (value: { models: CachedModel[] }) => void;
    reject: (error: Error) => void;
  }> = [];
  const discover = () => new Promise<{ models: CachedModel[] }>((resolve, reject) => {
    pending.push({ resolve, reject });
    if (pending.length === 2) announceBothStarted();
  });
  return {
    first: refreshAccountCatalogs(entry, discover),
    second: refreshAccountCatalogs(entry, discover),
    started,
    pending,
  };
}

it('persists each discovered account catalog independently and updates the primary view', async () => {
  const entry = provider();
  register(entry);

  const result = await refreshAccountCatalogs(entry, async account => ({
    models: [cachedModel(`${account.id}-model`)],
  }));

  const saved = loadRegistry().providers[0]!;
  expect(result.accountResults).toEqual(expect.arrayContaining([
    { accountId: 'primary', ok: true }, { accountId: 'secondary', ok: true },
  ]));
  expect(saved.accounts?.map(item => item.modelsCache?.models[0]?.id)).toEqual(['primary-model', 'secondary-model']);
  expect(saved.modelsCache?.models[0]?.id).toBe('primary-model');
});

it('keeps a failed account cache while reporting successful discovery for another account', async () => {
  const entry = provider();
  entry.accounts![1]!.modelsCache = { fetchedAt: '2026-10-01', models: [cachedModel('saved-model')] };
  register(entry);

  const result = await refreshAccountCatalogs(entry, async account => {
    if (account.id === 'secondary') throw new Error('catalog unavailable');
    return { models: [cachedModel('fresh-primary')] };
  });

  const saved = loadRegistry().providers[0]!;
  expect(result.ok).toBe(true);
  expect(result.accountResults).toEqual(expect.arrayContaining([
    { accountId: 'primary', ok: true }, { accountId: 'secondary', ok: false, reason: expect.any(String) },
  ]));
  expect(saved.accounts?.[1]).toMatchObject({
    modelsCache: { models: [{ id: 'saved-model' }] }, modelDiscoveryError: expect.any(String),
  });
  expect(saved.modelsCache?.models[0]?.id).toBe('fresh-primary');
});

it('reports failure when no account catalog can be refreshed', async () => {
  const entry = provider();
  register(entry);

  const result = await refreshAccountCatalogs(entry, async () => { throw new Error('catalog unavailable'); });

  expect(result.ok).toBe(false);
  expect(result.accountResults).toEqual([
    { accountId: 'primary', ok: false, reason: expect.any(String) },
    { accountId: 'secondary', ok: false, reason: expect.any(String) },
  ]);
});

const registryMutations = [
  {
    name: 'credential reference changes',
    apply: (current: RegistryProvider) => { current.accounts![0]!.authRef = 'keyring:provider:kimi:rotated'; },
  },
  {
    name: 'account is disabled',
    apply: (current: RegistryProvider) => { current.accounts![0]!.enabled = false; },
  },
  {
    name: 'account is removed',
    apply: (current: RegistryProvider) => { current.accounts = []; },
  },
] as const;

it.each(registryMutations)('does not publish discovery after an account $name', async ({ apply }) => {
  const entry = provider([account('primary', 'keyring:provider:kimi:primary')]);
  entry.modelsCache = { fetchedAt: '2026-10-01', models: [cachedModel('saved-model')] };
  register(entry);
  let resolveCatalog!: (value: { models: CachedModel[] }) => void;
  let announceStart!: () => void;
  const catalog = new Promise<{ models: CachedModel[] }>(resolve => { resolveCatalog = resolve; });
  const started = new Promise<void>(resolve => { announceStart = resolve; });
  const refresh = refreshAccountCatalogs(entry, async () => {
    announceStart();
    return catalog;
  });
  await started;
  updateRegistry(registry => apply(registry.providers[0]!));
  resolveCatalog({ models: [cachedModel('unpublished-model')] });

  await refresh;

  expect(loadRegistry().providers[0]?.modelsCache?.models[0]?.id).toBe('saved-model');
  expect(loadRegistry().providers[0]?.accounts?.[0]?.modelsCache?.models[0]?.id).toBeUndefined();
});

it('does not let an older discovery failure poison a newer successful catalog', async () => {
  const entry = provider([account('primary', 'keyring:provider:kimi:primary')]);
  register(entry);
  const refreshes = startOverlappingRefreshes(entry);
  await refreshes.started;
  refreshes.pending[1]!.resolve({ models: [cachedModel('newer-model')] });
  await refreshes.second;
  refreshes.pending[0]!.reject(new Error('stale request failed'));

  await refreshes.first;

  const saved = loadRegistry().providers[0]!;
  expect(saved.accounts?.[0]).toMatchObject({ modelsCache: { models: [{ id: 'newer-model' }] } });
  expect(saved.accounts?.[0]?.modelDiscoveryError).toBeUndefined();
});

it('does not let an older successful discovery overwrite a newer catalog', async () => {
  const entry = provider([account('primary', 'keyring:provider:kimi:primary')]);
  register(entry);
  const refreshes = startOverlappingRefreshes(entry);
  await refreshes.started;
  refreshes.pending[1]!.resolve({ models: [cachedModel('newer-model')] });
  await refreshes.second;
  refreshes.pending[0]!.resolve({ models: [cachedModel('older-model')] });

  await refreshes.first;

  const saved = loadRegistry().providers[0]!;
  expect(saved.accounts?.[0]?.modelsCache?.models[0]?.id).toBe('newer-model');
  expect(saved.modelsCache?.models[0]?.id).toBe('newer-model');
});
