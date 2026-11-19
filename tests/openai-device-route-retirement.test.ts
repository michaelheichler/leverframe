import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { getProvidersPath } from '../src/paths.js';
import { authenticateProvider } from '../src/registry/provider-auth.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';
import { loadRegistryProviders } from '../src/registry/load.js';
import type { RegistryProvider } from '../src/registry/types.js';
import { resolveServerUpstreamApiKey } from '../src/server/index.js';
import { planCredential } from './fixtures/chatgpt-plan-credential.js';

function savedProvider(id: string, authType: 'oauth' | 'api'): RegistryProvider {
  const authRef = authType === 'oauth' ? `keyring:oauth:provider:${id}` : 'env:OPENAI_RETIREMENT_FIXTURE_KEY';
  return {
    id, templateId: id, name: id, enabled: true, authType, authRef,
    api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
    addedAt: '2026-11-19T00:00:00Z',
    modelsCache: {
      fetchedAt: '2026-11-19T00:00:00Z',
      models: [{ id: 'gpt-6.2-sol', name: 'Sol', upstreamModelId: 'gpt-6.2-sol', modelFormat: 'openai' }],
    },
  };
}

function saveFixture(providers: RegistryProvider[]): void {
  const home = mkdtempSync(join(process.env.TMPDIR!, 'retired-device-route-'));
  vi.stubEnv('LEVERFRAME_HOME', home);
  const registryPath = getProvidersPath();
  expect(registryPath).toBe(join(home, 'providers.json'));
  saveRegistry({ schemaVersion: 1, providers }, registryPath);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('keeps saved device accounts off the runnable catalog and loads plan and API accounts', async () => {
  vi.stubEnv('LEVERFRAME_KEY_OPENAI', '');
  vi.stubEnv('OPENAI_RETIREMENT_FIXTURE_KEY', 'fixture-api-key');
  const retired = savedProvider('openai-oauth', 'oauth');
  const plan = savedProvider('openai-chatgpt-plan', 'oauth');
  const api = savedProvider('openai', 'api');
  saveFixture([retired, plan, api]);
  const keyring = vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockResolvedValue({
    ok: true, value: JSON.stringify(planCredential('fixture-plan-token', 'plan')),
  });

  const providers = await loadRegistryProviders();

  expect(providers.map(provider => [provider.id, provider.apiKey])).toEqual([
    ['openai-chatgpt-plan', 'fixture-plan-token'],
    ['openai', 'fixture-api-key'],
  ]);
  expect(keyring.mock.calls).toEqual([[{
    operation: 'read', service: 'leverframe', account: 'oauth:provider:openai-chatgpt-plan',
  }]]);
  expect(loadRegistry().providers).toContainEqual(expect.objectContaining({ id: retired.id, authRef: retired.authRef }));
});

it('reports no server credential when the only provider is a retired device account', async () => {
  saveFixture([savedProvider('openai-oauth', 'oauth')]);
  const keyring = vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockRejectedValue(new Error('Unexpected credential read'));

  const credential = await resolveServerUpstreamApiKey();

  expect(credential).toBeNull();
  expect(keyring).not.toHaveBeenCalled();
});

it.each(['openai', 'openai-oauth'])('rejects the retired %s device login before contacting OpenAI', async providerId => {
  const fetchUpstream = vi.fn().mockRejectedValue(new Error('Unexpected network request'));
  vi.stubGlobal('fetch', fetchUpstream);

  await expect(authenticateProvider(providerId)).rejects.toThrow(/openai-chatgpt-plan/i);

  expect(fetchUpstream).not.toHaveBeenCalled();
});
