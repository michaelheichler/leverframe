import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import incompatibleModels from '../src/data/model-incompatible.json';
import { loadRegistryProviders } from '../src/registry/load.js';
import { saveRegistry } from '../src/registry/io.js';
import type { CachedModel } from '../src/registry/types.js';

const previousHome = process.env.LEVERFRAME_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-model-compatibility-'));
  process.env.LEVERFRAME_HOME = home;
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function cachedModel(id: string): CachedModel {
  return {
    id, upstreamModelId: id, name: id, modelFormat: 'openai', npm: '@ai-sdk/google',
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta',
  };
}

it('does not restore compatibility-hidden models from account caches', async () => {
  const blocked = (incompatibleModels as { entries: Array<{ provider: string; modelId: string }> }).entries
    .find(entry => entry.provider === 'google')!;
  vi.stubEnv('GOOGLE_ACCOUNT_PRIMARY', 'primary-scoped-token');
  vi.stubEnv('GOOGLE_ACCOUNT_SECONDARY', 'secondary-scoped-token');
  vi.stubEnv('LEVERFRAME_KEY_GOOGLE', '');
  const primaryVisible = 'visible-primary-account-model';
  const secondaryVisible = 'visible-secondary-account-model';
  saveRegistry({ schemaVersion: 1, providers: [{
    id: blocked.provider, templateId: blocked.provider, name: 'Google API', enabled: true,
    authType: 'api', authRef: 'env:GOOGLE_ACCOUNT_PRIMARY', api: { npm: '@ai-sdk/google', url: 'https://generativelanguage.googleapis.com/v1beta' },
    addedAt: '2026-11-02',
    modelsCache: { fetchedAt: '2026-11-02', models: [cachedModel('visible-model')] },
    accounts: [
      { id: 'primary', authRef: 'env:GOOGLE_ACCOUNT_PRIMARY', enabled: true,
        tag: 'WORK', modelsCache: { fetchedAt: '2026-11-02', models: [cachedModel(blocked.modelId), cachedModel(primaryVisible)] } },
      { id: 'secondary', authRef: 'env:GOOGLE_ACCOUNT_SECONDARY', enabled: true,
        tag: 'HOME', modelsCache: { fetchedAt: '2026-11-02', models: [cachedModel(blocked.modelId), cachedModel(secondaryVisible)] } },
    ],
  }] });

  const providers = await loadRegistryProviders(undefined, { agent: 'claude' });
  const google = providers.find(provider => provider.id === blocked.provider);

  expect(google).toBeDefined();
  expect(google?.models.some(model => model.accountId === 'primary' && model.upstreamModelId === primaryVisible)).toBe(true);
  expect(google?.models.some(model => model.accountId === 'secondary' && model.upstreamModelId === secondaryVisible)).toBe(true);
  expect(google?.models.some(model => model.id === blocked.modelId || model.upstreamModelId === blocked.modelId)).toBe(false);
});
