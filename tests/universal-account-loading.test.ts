import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { loadRegistryProviders, loadStoredRegistryProviders } from '../src/registry/load.js';
import { saveRegistry } from '../src/registry/io.js';
import type { CachedModel, RegistryProvider } from '../src/registry/types.js';
import type { LocalProvider } from '../src/types.js';

const previousHome = process.env.LEVERFRAME_HOME;
const oauthPrimaryRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000051';
const oauthSecondaryRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000052';
let home: string;
let keyring: Map<string, string>;
const catalogReaders: Array<{ catalog: string; read: () => Promise<LocalProvider[]> }> = [
  { catalog: 'live', read: async () => loadRegistryProviders() },
  { catalog: 'stored', read: async () => (await loadStoredRegistryProviders()).providers },
];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-loading-'));
  process.env.LEVERFRAME_HOME = home;
  keyring = new Map();
  vi.stubEnv('LEVERFRAME_KEY_KIMI', '');
  vi.stubEnv('LEVERFRAME_KEY_OPENAI_OAUTH', '');
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => ({
    ok: true,
    value: input.operation === 'read' || input.operation === 'peek' ? keyring.get(input.account) ?? null : null,
  }));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function cachedModel(id: string, overrides: Partial<CachedModel> = {}): CachedModel {
  return {
    id, upstreamModelId: id, name: id, modelFormat: 'openai', npm: '@ai-sdk/openai-compatible',
    apiUrl: 'https://models.example.invalid/v1', ...overrides,
  };
}

function oauthCredential(access: string, accountId: string): string {
  return JSON.stringify({ type: 'oauth', access, refresh: 'unused-refresh', expires: Date.now() + 3_600_000, accountId });
}

function scopedApiProvider(): RegistryProvider {
  return {
    id: 'kimi', templateId: 'kimi', name: 'Kimi', enabled: true, authType: 'api',
    authRef: 'env:KIMI_PRIMARY', api: { npm: '@ai-sdk/openai-compatible', url: 'https://models.example.invalid/v1' },
    addedAt: '2026-11-02',
    accounts: [
      { id: 'primary', authRef: 'env:KIMI_PRIMARY', enabled: true, name: 'Primary', tag: 'HOME',
        modelsCache: { fetchedAt: '2026-11-02', models: [cachedModel('primary-account-model')] } },
      { id: 'secondary', authRef: 'env:KIMI_SECONDARY', enabled: true, name: 'Secondary', tag: 'WORK',
        modelsCache: { fetchedAt: '2026-11-02', models: [cachedModel('secondary-account-model')] } },
    ],
  };
}

function scopedOAuthProvider(): RegistryProvider {
  keyring.set(oauthPrimaryRef.slice('keyring:'.length), oauthCredential('primary-access', 'oauth-primary'));
  keyring.set(oauthSecondaryRef.slice('keyring:'.length), oauthCredential('secondary-access', 'oauth-secondary'));
  return {
    id: 'openai-oauth', templateId: 'openai-oauth', name: 'ChatGPT OAuth', enabled: true, authType: 'oauth',
    authRef: oauthPrimaryRef, api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' }, addedAt: '2026-11-02',
    accounts: [
      { id: 'primary', authRef: oauthPrimaryRef, enabled: true, name: 'Primary', tag: 'HOME',
        modelsCache: { oauthAccountId: 'oauth-primary', fetchedAt: '2026-11-02', models: [cachedModel('primary-oauth-model', { npm: '@ai-sdk/openai', apiUrl: 'https://api.openai.com/v1' })] } },
      { id: 'secondary', authRef: oauthSecondaryRef, enabled: true, name: 'Secondary', tag: 'WORK',
        modelsCache: { oauthAccountId: 'oauth-primary', fetchedAt: '2026-11-02', models: [cachedModel('secondary-oauth-model', { npm: '@ai-sdk/openai', apiUrl: 'https://api.openai.com/v1' })] } },
    ],
  };
}

it.each(catalogReaders)('$catalog catalog loads only cached models for accounts with scoped credentials', async ({ read }) => {
  vi.stubEnv('KIMI_SECONDARY', 'secondary-scoped-token');
  vi.stubEnv('KIMI_PRIMARY', '');
  saveRegistry({ schemaVersion: 1, providers: [scopedApiProvider()] });
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  const providers = await read();
  const models = providers.find(provider => provider.id === 'kimi')?.models ?? [];

  expect(models.some(model => model.accountId === 'secondary' && model.upstreamModelId === 'secondary-account-model')).toBe(true);
  expect(models.some(model => model.accountId === 'primary')).toBe(false);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it.each(catalogReaders)('$catalog catalog rejects OAuth model caches belonging to another account identity', async ({ read }) => {
  saveRegistry({ schemaVersion: 1, providers: [scopedOAuthProvider()] });
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  const providers = await read();
  const models = providers.find(provider => provider.id === 'openai-oauth')?.models ?? [];

  expect(models.some(model => model.accountId === 'primary' && model.upstreamModelId === 'primary-oauth-model')).toBe(true);
  expect(models.some(model => model.accountId === 'secondary' || model.upstreamModelId === 'secondary-oauth-model')).toBe(false);
  expect(fetchSpy).not.toHaveBeenCalled();
});
