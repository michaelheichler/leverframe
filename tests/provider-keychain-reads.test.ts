import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { loadRegistryProviders } from '../src/registry/load.js';
import { saveRegistry } from '../src/registry/io.js';
import type { RegistryProvider } from '../src/registry/types.js';
import { resolveServerUpstreamApiKey } from '../src/server/index.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-keychain-reads-'));
  vi.stubEnv('LEVERFRAME_HOME', home);
  vi.stubEnv('LEVERFRAME_KEY_OPENAI_OAUTH', '');
  vi.stubEnv('LEVERFRAME_KEY_DISABLED', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function oauthProvider(id = 'openai-oauth', enabled = true): RegistryProvider {
  return {
    id, enabled, name: id, templateId: 'openai-oauth', authType: 'oauth',
    authRef: `keyring:oauth:provider:${id}`, api: { npm: '@ai-sdk/openai' },
    addedAt: '2026-01-01T00:00:00Z',
    modelsCache: { fetchedAt: '2026-01-01T00:00:00Z', models: [{
      id: 'gpt-fixture', name: 'Fixture', upstreamModelId: 'gpt-fixture', modelFormat: 'openai',
    }] },
  };
}

function freshCredential() {
  return JSON.stringify({
    type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3_600_000,
    accountId: 'fixture-account', providerData: { organization: 'fixture-organization' },
  });
}

it('loads access and account metadata from one fresh OAuth Keychain read', async () => {
  saveRegistry({ schemaVersion: 1, providers: [oauthProvider()] });
  const keyring = vi.spyOn(_credentialStoreInternals, 'keyringOperation')
    .mockResolvedValue({ ok: true, value: freshCredential() });

  const providers = await loadRegistryProviders();

  expect(providers).toHaveLength(1);
  expect(providers[0]).toMatchObject({
    apiKey: 'fixture-access', oauthAccountId: 'fixture-account',
    providerData: { organization: 'fixture-organization' },
  });
  expect(keyring).toHaveBeenCalledTimes(1);
  expect(keyring).toHaveBeenCalledWith({ operation: 'read', service: 'leverframe', account: 'oauth:provider:openai-oauth' });
});

it('does not access credentials for disabled registry providers', async () => {
  saveRegistry({ schemaVersion: 1, providers: [oauthProvider('disabled', false)] });
  const keyring = vi.spyOn(_credentialStoreInternals, 'keyringOperation')
    .mockResolvedValue({ ok: true, value: freshCredential() });

  const providers = await loadRegistryProviders();

  expect(providers).toEqual([]);
  expect(keyring).not.toHaveBeenCalled();
});

it('checks server configuration without reading provider credentials', async () => {
  saveRegistry({ schemaVersion: 1, providers: [oauthProvider()] });
  const keyring = vi.spyOn(_credentialStoreInternals, 'keyringOperation')
    .mockResolvedValue({ ok: true, value: freshCredential() });

  const result = await resolveServerUpstreamApiKey();

  expect(result).toBe('registry-local');
  expect(keyring).not.toHaveBeenCalled();
});

it.each([{ providers: [] }, { providers: [oauthProvider('disabled', false)] }])('rejects server startup without enabled providers', async ({ providers }) => {
  saveRegistry({ schemaVersion: 1, providers });
  const keyring = vi.spyOn(_credentialStoreInternals, 'keyringOperation')
    .mockResolvedValue({ ok: true, value: freshCredential() });

  const result = await resolveServerUpstreamApiKey();

  expect(result).toBeNull();
  expect(keyring).not.toHaveBeenCalled();
});
