import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { loadRegistryProviders } from '../src/registry/load.js';
import { saveRegistry } from '../src/registry/io.js';
import type { RegistryProvider } from '../src/registry/types.js';
import { planAccountId, planCredential } from './fixtures/chatgpt-plan-credential.js';
import { resolveServerUpstreamApiKey } from '../src/server/index.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-keychain-reads-'));
  vi.stubEnv('LEVERFRAME_HOME', home);
  vi.stubEnv('LEVERFRAME_KEY_OPENAI_CHATGPT_PLAN', '');
  vi.stubEnv('LEVERFRAME_KEY_DISABLED', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function oauthProvider(id = 'openai-chatgpt-plan', enabled = true): RegistryProvider {
  return {
    id, enabled, name: id, templateId: 'openai-chatgpt-plan', authType: 'oauth',
    authRef: `keyring:oauth:provider:${id}`, api: { npm: '@ai-sdk/openai' },
    addedAt: '2026-01-01T00:00:00Z',
    modelsCache: { fetchedAt: '2026-01-01T00:00:00Z', models: [{
      id: 'gpt-fixture', name: 'Fixture', upstreamModelId: 'gpt-fixture', modelFormat: 'openai',
    }] },
  };
}

function freshCredential() {
  return JSON.stringify(planCredential('fixture-access', 'fixture-account'));
}

it('loads access and account metadata from one fresh OAuth Keychain read', async () => {
  saveRegistry({ schemaVersion: 1, providers: [oauthProvider()] });
  const keyring = vi.spyOn(_credentialStoreInternals, 'keyringOperation')
    .mockResolvedValue({ ok: true, value: freshCredential() });

  const providers = await loadRegistryProviders();

  expect(providers).toHaveLength(1);
  expect(providers[0]).toMatchObject({
    apiKey: 'fixture-access', oauthAccountId: planAccountId('fixture-account'),
    providerData: expect.objectContaining({ subject: 'fixture-account' }),
  });
  expect(keyring).toHaveBeenCalledTimes(1);
  expect(keyring).toHaveBeenCalledWith({ operation: 'read', service: 'leverframe', account: 'oauth:provider:openai-chatgpt-plan' });
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
