import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { getTemplateById } from '../src/provider-templates.js';
import { getProvidersPath } from '../src/paths.js';
import { resolveLocalProviderApiKey } from '../src/provider-catalog.js';
import { saveRegistry } from '../src/registry/io.js';
import { loadRegistryProviders } from '../src/registry/load.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function configureZenPair(configuredKey = false, singleId?: 'builtin' | 'custom') {
  const home = process.env['LEVERFRAME_TEST_HOME'];
  if (!home) throw new Error('isolated test home is missing');
  vi.stubEnv('LEVERFRAME_HOME', join(home, randomUUID()));
  const part = relative(resolve(home), resolve(getProvidersPath()));
  if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) throw new Error('registry fixture escaped test home');
  const customId = `custom-zen-${randomUUID()}`;
  const credential = randomUUID();
  vi.stubEnv('LEVERFRAME_ZEN_PAIR_CREDENTIAL', credential);
  const now = new Date().toISOString();
  const providerIds = singleId ? [singleId === 'builtin' ? 'opencode-zen' : customId] : ['opencode-zen', customId];
  saveRegistry({ schemaVersion: 1, providers: providerIds.map(id => ({
    id, templateId: 'opencode-zen', name: 'Zen fixture', enabled: true,
    authRef: configuredKey ? 'env:LEVERFRAME_ZEN_PAIR_CREDENTIAL' : 'none:anonymous',
    authType: configuredKey ? 'api' : 'none',
    subscriptionFilter: 'free',
    api: { npm: '@ai-sdk/openai-compatible', url: getTemplateById('opencode-zen')?.defaultBaseUrl },
    addedAt: now, refreshedAt: now,
    modelsCache: { fetchedAt: now, models: [{
      id: 'anonymous-free-fixture', name: 'Anonymous free fixture', upstreamModelId: 'anonymous-free-fixture',
      npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', isFree: true,
    }] },
  })) });
  return { customId, credential, providerIds };
}

it('gives a custom-id Zen entry the same anonymous access as a normally added key-free entry', async () => {
  const { customId } = configureZenPair();

  const providers = await loadRegistryProviders();
  const credentials = await Promise.all(providers.map(resolveLocalProviderApiKey));

  expect(providers.map(provider => provider.id)).toEqual(['opencode-zen', customId]);
  expect(credentials).toEqual(['anonymous', 'anonymous']);
});

it.each(['builtin', 'custom'] as const)(
  'explains that a configured Zen key is not sent for a %s provider id', async idKind => {
    const { credential, providerIds } = configureZenPair(true, idKind);
    const diagnostics: string[] = [];

    const providers = await loadRegistryProviders(message => diagnostics.push(message));

    expect(providers.map(provider => provider.id)).toEqual(providerIds);
    expect(providers.map(provider => provider.apiKey)).toEqual([credential]);
    expect(diagnostics).toEqual([
      expect.stringMatching(/public.*(?:configured|supplied).*key.*(?:not sent|ignored)/i),
    ]);
    expect(diagnostics.join('\n')).not.toContain(credential);
  },
);
