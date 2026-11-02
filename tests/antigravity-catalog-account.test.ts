import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRegistry } from '../src/registry/types.js';

const mocks = vi.hoisted(() => ({
  resolveAuth: vi.fn(),
  resolveStored: vi.fn(),
  loadRegistry: vi.fn(),
}));
vi.mock('../src/env.js', () => ({
  resolveProviderAuth: mocks.resolveAuth,
  resolveStoredProviderCredential: mocks.resolveStored,
}));
vi.mock('../src/registry/io.js', () => ({ loadRegistry: mocks.loadRegistry }));

import { loadRegistryProviders, loadStoredRegistryProviders } from '../src/registry/load.js';

function catalogRegistry(accountId = 'account-a'): ProviderRegistry {
  return {
    schemaVersion: 1,
    providers: [{
      id: 'antigravity', templateId: 'antigravity', name: 'Google Antigravity', enabled: true,
      authRef: 'keyring:oauth:provider:antigravity', authType: 'oauth', api: { npm: '@ai-sdk/google', url: '' },
      modelsCache: {
        fetchedAt: '2026-10-31T00:00:00Z', oauthAccountId: accountId,
        models: [{
          id: 'gemini-3.1-pro-high', upstreamModelId: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro High',
          modelFormat: 'cloud-code', npm: '@ai-sdk/google', contextWindowUnconfirmed: true,
        }],
      },
      addedAt: '2026-10-31T00:00:00Z',
    }],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.loadRegistry.mockReturnValue(catalogRegistry());
  mocks.resolveAuth.mockResolvedValue({ apiKey: 'token-b', accountId: 'account-a', providerData: { projectId: 'project-a' } });
  mocks.resolveStored.mockResolvedValue({
    value: 'token-a', refreshDue: false, accountId: 'account-a', providerData: { projectId: 'project-a' },
  });
});

afterEach(() => vi.restoreAllMocks());

describe('Antigravity live catalog ownership', () => {
  it('shows cached models to the account that discovered them', async () => {
    const providers = await loadRegistryProviders();

    expect(providers[0]?.models.map(model => model.id)).toEqual(['gemini-3.1-pro-high']);
  });

  it('hides account A models when account B replaces credentials and refresh fails', async () => {
    mocks.resolveAuth.mockResolvedValue({ apiKey: 'token-b', accountId: 'account-b', providerData: { projectId: 'project-b' } });

    const providers = await loadRegistryProviders();

    expect(providers).toEqual([]);
  });

  it('hides cached Antigravity models whose account provenance is missing', async () => {
    const registry = catalogRegistry();
    delete registry.providers[0]!.modelsCache!.oauthAccountId;
    mocks.loadRegistry.mockReturnValue(registry);

    const providers = await loadRegistryProviders();

    expect(providers).toEqual([]);
  });

  it('hides prior account models when fresh credential resolution fails', async () => {
    mocks.resolveAuth.mockRejectedValue(new Error('OAuth credential unavailable'));

    const providers = await loadRegistryProviders();

    expect(providers).toEqual([]);
  });
});

describe('Antigravity stored catalog ownership', () => {
  it('shows a stored catalog only when stored credentials prove the same account', async () => {
    const result = await loadStoredRegistryProviders();

    expect(result.providers[0]?.models.map(model => model.id)).toEqual(['gemini-3.1-pro-high']);
  });

  it('hides a stored catalog owned by a different account', async () => {
    mocks.resolveStored.mockResolvedValue({
      value: 'token-b', refreshDue: false, accountId: 'account-b', providerData: { projectId: 'project-b' },
    });

    const result = await loadStoredRegistryProviders();

    expect(result.providers).toEqual([]);
  });

  it('hides a stored catalog when its account ownership is unavailable', async () => {
    mocks.resolveStored.mockResolvedValue({ value: 'token-a', refreshDue: false });

    const result = await loadStoredRegistryProviders();

    expect(result.providers).toEqual([]);
  });
});
