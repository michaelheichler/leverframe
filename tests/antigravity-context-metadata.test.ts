import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchAntigravityModels } from '../src/antigravity/models.js';
import { cachedModelToLocal } from '../src/registry/materialize.js';
import { filterFreshProviderCatalog } from '../src/provider-catalog.js';
import { buildHttpProxyRoutes } from '../src/http-proxy/routes.js';
import { buildDesiredPatchConfig } from '../src/patcher.js';
import type { RegistryProvider } from '../src/registry/types.js';

const auth = { accessToken: 'catalog-token', accountId: 'catalog-account', projectId: 'catalog-project' };
const previousHome = process.env['LEVERFRAME_HOME'];
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'antigravity-context-metadata-'));
  process.env['LEVERFRAME_HOME'] = home;
  writeFileSync(join(home, 'config.json'), JSON.stringify({ favoriteModels: [] }));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('Antigravity context metadata', () => {
  it.each([345_678, 987_654])('uses the account catalog context limit %s', async limit => {
    const models = await fetchAntigravityModels(auth, {
      fetchImpl: async () => Response.json({ models: {
        'gemini-catalog-model': { maxTokens: limit, maxOutputTokens: 12_345 },
      } }),
    });

    expect(models[0]).toMatchObject({ contextWindow: limit, outputTokenLimit: 12_345 });
    expect(models[0]?.contextWindowUnconfirmed).not.toBe(true);
  });

  it.each([undefined, null, 0, -1, 1.5, '1048576'])('keeps an invalid context limit %s unconfirmed', async limit => {
    const models = await fetchAntigravityModels(auth, {
      fetchImpl: async () => Response.json({ models: {
        'gemini-catalog-model': { maxTokens: limit, maxOutputTokens: 12_345 },
      } }),
    });

    expect(models[0]).toMatchObject({ contextWindow: undefined, contextWindowUnconfirmed: true });
  });

  it('carries catalog context into browsing, proxy routes, and the Claude picker', async () => {
    const contextWindow = 678_901;
    const [cachedModel] = await fetchAntigravityModels(auth, {
      fetchImpl: async () => Response.json({ models: {
        'gemini-context-catalog-model': { maxTokens: contextWindow, maxOutputTokens: 12_345 },
      } }),
    });
    const registryProvider: RegistryProvider = {
      id: 'antigravity', templateId: 'antigravity', name: 'Google Antigravity', enabled: true,
      authRef: 'keyring:oauth:provider:antigravity', authType: 'oauth',
      api: { npm: '@ai-sdk/google', url: 'https://daily-cloudcode-pa.googleapis.com' },
      addedAt: '2026-11-02T00:00:00Z',
    };
    const localModel = cachedModelToLocal(cachedModel!, registryProvider)!;
    const fresh = filterFreshProviderCatalog([{
      id: registryProvider.id, name: registryProvider.name, apiKey: 'account-credential', authType: 'oauth',
      models: [localModel],
    }], { refreshed: [{ id: registryProvider.id, name: registryProvider.name, ok: true, modelSource: 'live' }] });
    const routes = buildHttpProxyRoutes(fresh.providers, [], []).routes;
    const desired = buildDesiredPatchConfig(fresh.providers, {
      providerId: registryProvider.id,
      modelId: cachedModel!.id,
    });

    expect(localModel.contextWindow).toBe(contextWindow);
    expect(routes[0]?.contextWindow).toBe(contextWindow);
    expect(desired.config[`leverframe:${registryProvider.id}:${cachedModel!.id}`]).toMatchObject({ context: contextWindow });
  });
});
