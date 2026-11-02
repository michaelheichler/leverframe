import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { removeProviderAccount } from '../src/registry/credential-lifecycle.js';
import { loadRegistryProviders, loadStoredRegistryProviders } from '../src/registry/load.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';
import type { CachedModel, RegistryProvider } from '../src/registry/types.js';
import type { LocalProvider } from '../src/types.js';

const previousHome = process.env.LEVERFRAME_HOME;
let home: string;
const primaryRefresh = '2026-10-30T09:00:00.000Z';
const secondaryRefresh = '2026-11-01T09:00:00.000Z';
const catalogReaders: Array<{ catalog: string; read: () => Promise<LocalProvider[]> }> = [
  { catalog: 'live', read: async () => loadRegistryProviders() },
  { catalog: 'stored', read: async () => (await loadStoredRegistryProviders()).providers },
];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-primary-removal-'));
  process.env.LEVERFRAME_HOME = home;
  vi.stubEnv('KIMI_PRIMARY', 'primary-scoped-key');
  vi.stubEnv('KIMI_SECONDARY', 'secondary-scoped-key');
  vi.stubEnv('LEVERFRAME_KEY_KIMI', '');
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function cachedModel(id: string): CachedModel {
  return {
    id, upstreamModelId: id, name: id, modelFormat: 'openai', npm: '@ai-sdk/openai-compatible',
    apiUrl: 'https://models.example.invalid/v1',
  };
}

function providerWithPrimaryCache(secondaryModels?: CachedModel[]): RegistryProvider {
  const primaryModels = [cachedModel('primary-exclusive-model')];
  const secondaryCache = secondaryModels ? { fetchedAt: secondaryRefresh, models: secondaryModels } : undefined;
  return {
    id: 'kimi', templateId: 'kimi', name: 'Kimi', enabled: true, authType: 'api',
    authRef: 'env:KIMI_PRIMARY', api: { npm: '@ai-sdk/openai-compatible', url: 'https://models.example.invalid/v1' },
    addedAt: '2026-10-01', refreshedAt: primaryRefresh,
    modelsCache: { fetchedAt: primaryRefresh, models: primaryModels },
    accounts: [
      { id: 'primary', authRef: 'env:KIMI_PRIMARY', enabled: true, name: 'Primary', tag: 'HOME',
        modelsCache: { fetchedAt: primaryRefresh, models: primaryModels } },
      { id: 'secondary', authRef: 'env:KIMI_SECONDARY', enabled: true, name: 'Work', tag: 'WORK',
        ...(secondaryCache ? { modelsCache: secondaryCache } : {}) },
    ],
  };
}

it.each(catalogReaders)('$catalog catalog never assigns a removed primary catalog to the replacement account', async ({ read }) => {
  saveRegistry({ schemaVersion: 1, providers: [providerWithPrimaryCache()] });

  const removal = await removeProviderAccount('kimi', 'primary');
  const saved = loadRegistry().providers.find(provider => provider.id === 'kimi')!;
  const providers = await read();
  const models = providers.flatMap(provider => provider.models);

  expect(removal.removed).toBe(true);
  expect(saved.modelsCache).toBeUndefined();
  expect(saved.refreshedAt).toBeUndefined();
  expect(models.some(model => model.accountId === 'secondary'
    && model.upstreamModelId === 'primary-exclusive-model')).toBe(false);
});

it('promotes the replacement account catalog and its fetched time when one exists', async () => {
  saveRegistry({ schemaVersion: 1, providers: [providerWithPrimaryCache([cachedModel('secondary-owned-model')])] });

  await removeProviderAccount('kimi', 'primary');

  const saved = loadRegistry().providers.find(provider => provider.id === 'kimi')!;
  expect(saved.modelsCache).toMatchObject({
    fetchedAt: secondaryRefresh,
    models: [{ id: 'secondary-owned-model' }],
  });
  expect(saved.refreshedAt).toBe(secondaryRefresh);
});
