import { describe, expect, it } from 'vitest';
import { expandAccountModels } from '../src/account-models.js';
import type { CachedModel, RegistryProvider } from '../src/registry/types.js';
import type { LocalProviderModel } from '../src/types.js';

function cachedModel(id: string, contextWindow: number): CachedModel {
  return {
    id, upstreamModelId: id, name: 'Gemini Pro', modelFormat: 'openai', npm: '@ai-sdk/google',
    contextWindow,
  };
}

function localModel(id: string, contextWindow: number): LocalProviderModel {
  return {
    id, upstreamModelId: id, name: 'Gemini Pro', family: 'gemini', brand: 'Google',
    modelFormat: 'openai', npm: '@ai-sdk/google', contextWindow,
  };
}

function provider(accounts: NonNullable<RegistryProvider['accounts']>): RegistryProvider {
  return {
    id: 'antigravity', templateId: 'antigravity', name: 'Google Antigravity', enabled: true,
    authType: 'oauth', authRef: 'keyring:oauth:provider:antigravity', api: {}, addedAt: '2026-11-02', accounts,
  };
}

describe('account-specific model catalog', () => {
  it('keeps legacy model IDs when one account has no explicit identity', () => {
    const models = [localModel('gemini-pro', 100_000)];
    const registryProvider = provider([{
      id: 'primary', authRef: 'keyring:antigravity:primary', enabled: true,
      modelsCache: { fetchedAt: '2026-11-02', models: [cachedModel('gemini-pro', 100_000)] },
    }]);

    expect(expandAccountModels(registryProvider, models)).toEqual(models);
  });

  it('expands named accounts with their own IDs, labels, and context limits', () => {
    const registryProvider = provider([
      {
        id: 'primary', authRef: 'keyring:antigravity:primary', enabled: true, tag: 'WORK', name: 'Company',
        modelsCache: { fetchedAt: '2026-11-02', models: [cachedModel('gemini-pro', 100_000)] },
      },
      {
        id: 'personal', authRef: 'keyring:antigravity:personal', enabled: true, tag: 'HOME', name: 'Personal',
        modelsCache: { fetchedAt: '2026-11-02', models: [cachedModel('gemini-pro', 55_000)] },
      },
      {
        id: 'disabled', authRef: 'keyring:antigravity:disabled', enabled: false, tag: 'OFFC', name: 'Disabled',
        modelsCache: { fetchedAt: '2026-11-02', models: [cachedModel('gemini-pro', 33_000)] },
      },
    ]);

    const expanded = expandAccountModels(registryProvider, [localModel('gemini-pro', 100_000)]);

    expect(expanded.find(model => model.accountTag === 'AUTO')).toMatchObject({
      id: 'gemini-pro', name: 'Gemini Pro [AUTO]',
    });
    expect(expanded.find(model => model.accountTag === 'AUTO')).not.toHaveProperty('accountId');
    expect(expanded).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gemini-pro@primary', accountId: 'primary', accountTag: 'WORK', accountName: 'Company', contextWindow: 100_000 }),
      expect.objectContaining({ id: 'gemini-pro@personal', accountId: 'personal', accountTag: 'HOME', accountName: 'Personal', contextWindow: 55_000 }),
    ]));
    expect(expanded.some(model => model.id === 'gemini-pro@disabled')).toBe(false);
  });

  it('does not copy a primary account model into another account without its own cache', () => {
    const registryProvider = provider([
      {
        id: 'primary', authRef: 'keyring:antigravity:primary', enabled: true, tag: 'WORK',
        modelsCache: { fetchedAt: '2026-11-02', models: [cachedModel('gemini-pro', 100_000)] },
      },
      { id: 'secondary', authRef: 'keyring:antigravity:secondary', enabled: true, tag: 'HOME' },
    ]);

    const expanded = expandAccountModels(registryProvider, [localModel('gemini-pro', 100_000)]);

    expect(expanded.some(model => model.id === 'gemini-pro@secondary')).toBe(false);
  });
});
