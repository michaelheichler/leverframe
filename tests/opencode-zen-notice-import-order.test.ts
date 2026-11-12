import { OPENCODE_ZEN_BASE_URL } from '../src/opencode-zen.js';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { getProvidersPath } from '../src/paths.js';
import { saveRegistry } from '../src/registry/io.js';
import { loadRegistryProviders } from '../src/registry/load.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function configureBuiltinZen() {
  const home = process.env['LEVERFRAME_TEST_HOME'];
  if (!home) throw new Error('isolated test home is missing');
  vi.stubEnv('LEVERFRAME_HOME', join(home, randomUUID()));
  const part = relative(resolve(home), resolve(getProvidersPath()));
  if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) throw new Error('registry fixture escaped test home');
  const credential = randomUUID();
  vi.stubEnv('LEVERFRAME_ZEN_IMPORT_ORDER_CREDENTIAL', credential);
  const now = new Date().toISOString();
  saveRegistry({ schemaVersion: 1, providers: [{
    id: 'opencode-zen', templateId: 'opencode-zen', name: 'Zen fixture', enabled: true,
    authRef: 'env:LEVERFRAME_ZEN_IMPORT_ORDER_CREDENTIAL', authType: 'api',
    api: { npm: '@ai-sdk/openai-compatible', url: OPENCODE_ZEN_BASE_URL },
    addedAt: now, modelsCache: { fetchedAt: now, models: [{
      id: 'notice-free-fixture', name: 'Notice free fixture', upstreamModelId: 'notice-free-fixture',
      npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', isFree: true,
    }] },
  }] });
  return credential;
}

it('reports the ignored configured Zen key even when the transport module loads before the registry', async () => {
  const credential = configureBuiltinZen();
  const diagnostics: string[] = [];

  const providers = await loadRegistryProviders(message => diagnostics.push(message));

  expect(providers.map(provider => provider.apiKey)).toEqual([credential]);
  expect(diagnostics).toEqual([
    expect.stringMatching(/public.*(?:configured|supplied).*key.*(?:not sent|ignored)/i),
  ]);
  expect(diagnostics.join('\n')).not.toContain(credential);
});
