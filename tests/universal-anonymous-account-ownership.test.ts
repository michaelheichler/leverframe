import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { removeProviderAccount } from '../src/registry/credential-lifecycle.js';
import { loadRegistryProviders, loadStoredRegistryProviders } from '../src/registry/load.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';
import { refreshAccountCatalogs } from '../src/registry/account-catalogs.js';
import { dispatchWithPool } from '../src/account-pool-dispatch.js';
import { savePreferences } from '../src/config.js';
import type { CachedModel, RegistryProvider } from '../src/registry/types.js';
import type { LocalProvider } from '../src/types.js';

const previousHome = process.env.LEVERFRAME_HOME;
const primaryRefresh = '2026-10-30T09:00:00.000Z';
const secondaryRefresh = '2026-11-01T09:00:00.000Z';
const catalogReaders: Array<{ catalog: string; read: () => Promise<LocalProvider[]> }> = [
  { catalog: 'live', read: async () => loadRegistryProviders() },
  { catalog: 'stored', read: async () => (await loadStoredRegistryProviders()).providers },
];
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-anonymous-account-ownership-'));
  process.env.LEVERFRAME_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function cachedModel(id: string): CachedModel {
  return {
    id, upstreamModelId: id, name: id, modelFormat: 'openai', npm: '@ai-sdk/openai-compatible',
    apiUrl: 'https://models.example.invalid/v1',
  };
}

function anonymousProvider(secondaryModels?: CachedModel[]): RegistryProvider {
  return {
    id: 'custom-anonymous', templateId: 'custom-openai', name: 'Local endpoint', enabled: true,
    authType: 'none', authRef: 'none:anonymous',
    api: { npm: '@ai-sdk/openai-compatible', url: 'https://models.example.invalid/v1' },
    addedAt: '2026-10-01', refreshedAt: primaryRefresh,
    modelsCache: { fetchedAt: primaryRefresh, models: [cachedModel('primary-exclusive-model')] },
    accounts: [
      { id: 'primary', authRef: 'none:anonymous', enabled: true, name: 'Primary', tag: 'HOME' },
      { id: 'secondary', authRef: 'none:anonymous', enabled: true, name: 'Secondary', tag: 'WORK',
        ...(secondaryModels ? { modelsCache: { fetchedAt: secondaryRefresh, models: secondaryModels } } : {}) },
    ],
  };
}

function register(provider: RegistryProvider = anonymousProvider()): void {
  saveRegistry({ schemaVersion: 1, providers: [provider] });
}

it.each(catalogReaders)('$catalog catalog assigns a legacy anonymous cache only to its primary account', async ({ read }) => {
  register();
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  const providers = await read();
  const models = providers.flatMap(provider => provider.models);

  expect(models.some(model => model.id === 'primary-exclusive-model@primary')).toBe(true);
  expect(models.some(model => model.id === 'primary-exclusive-model@secondary')).toBe(false);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('keeps anonymous account discoveries separate and publishes only the primary catalog globally', async () => {
  const provider = anonymousProvider();
  register(provider);
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  const refresh = await refreshAccountCatalogs(provider, async account => ({
    models: [cachedModel(`${account.id}-discovered-model`)],
  }));

  const saved = loadRegistry().providers[0]!;
  const primary = saved.accounts!.find(account => account.id === 'primary')!;
  const secondary = saved.accounts!.find(account => account.id === 'secondary')!;
  const loaded = await loadRegistryProviders();
  const models = loaded.flatMap(provider => provider.models);
  expect(refresh.ok).toBe(true);
  expect(saved.modelsCache?.models[0]?.id).toBe('primary-discovered-model');
  expect(primary.modelsCache?.models[0]?.id).toBe('primary-discovered-model');
  expect(secondary.modelsCache?.models[0]?.id).toBe('secondary-discovered-model');
  expect(models.some(model => model.id === 'primary-discovered-model@primary')).toBe(true);
  expect(models.some(model => model.id === 'secondary-discovered-model@secondary')).toBe(true);
  expect(models.some(model => model.id === 'primary-discovered-model@secondary')).toBe(false);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('preserves the primary anonymous catalog when the secondary account is removed', async () => {
  register();

  await removeProviderAccount('custom-anonymous', 'secondary');

  const saved = loadRegistry().providers[0]!;
  const providers = await loadRegistryProviders();
  const models = providers.flatMap(provider => provider.models);
  expect(saved.modelsCache).toMatchObject({
    fetchedAt: primaryRefresh,
    models: [{ id: 'primary-exclusive-model' }],
  });
  expect(models.some(model => model.id === 'primary-exclusive-model@primary')).toBe(true);
});

it('clears a removed primary anonymous catalog when the replacement has no cache', async () => {
  register();

  await removeProviderAccount('custom-anonymous', 'primary');

  const saved = loadRegistry().providers[0]!;
  const providers = await loadRegistryProviders();
  const models = providers.flatMap(provider => provider.models);
  expect(saved.modelsCache).toBeUndefined();
  expect(saved.refreshedAt).toBeUndefined();
  expect(models.some(model => model.upstreamModelId === 'primary-exclusive-model')).toBe(false);
});

it('promotes an anonymous replacement account own cache after primary removal', async () => {
  register(anonymousProvider([cachedModel('secondary-owned-model')]));

  await removeProviderAccount('custom-anonymous', 'primary');

  const saved = loadRegistry().providers[0]!;
  const providers = await loadRegistryProviders();
  const models = providers.flatMap(provider => provider.models);
  expect(saved.modelsCache).toMatchObject({
    fetchedAt: secondaryRefresh,
    models: [{ id: 'secondary-owned-model' }],
  });
  expect(models.some(model => model.id === 'secondary-owned-model@secondary')).toBe(true);
  expect(models.some(model => model.upstreamModelId === 'primary-exclusive-model')).toBe(false);
});

it.each([
  { scenario: 'no account catalog', secondaryCatalog: undefined },
  { scenario: 'a catalog without the selected model', secondaryCatalog: [cachedModel('secondary-only-model')] },
])('dispatches a legacy anonymous model only through its primary cache owner when secondary has $scenario', async ({ secondaryCatalog }) => {
  const provider = anonymousProvider(secondaryCatalog);
  provider.pinnedAccountId = 'secondary';
  register(provider);
  savePreferences({ accountPoolBalancing: false, accountPoolFailover: false });
  const selectedAccounts: string[] = [];

  await dispatchWithPool({
    pool: { providerId: 'custom-anonymous', modelId: 'primary-exclusive-model', billingType: 'api' },
    dispatch: async binding => {
      selectedAccounts.push(binding.account.id);
      return { kind: 'success', value: 'ok' };
    },
  });

  expect(selectedAccounts).toEqual(['primary']);
});
