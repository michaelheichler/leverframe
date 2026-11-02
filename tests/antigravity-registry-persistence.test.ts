import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvidersPath } from '../src/paths.js';
import { loadRegistry, loadRegistryStrict, saveRegistry } from '../src/registry/io.js';
import type { ProviderRegistry } from '../src/registry/types.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-antigravity-registry-'));
  vi.stubEnv('LEVERFRAME_HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function registry(cacheAccountId: unknown): ProviderRegistry {
  return {
    schemaVersion: 1,
    providers: [{
      id: 'antigravity', templateId: 'antigravity', name: 'Google Antigravity', enabled: true,
      authRef: 'keyring:oauth:provider:antigravity', authType: 'oauth',
      api: { npm: '@ai-sdk/google' },
      modelsCache: {
        oauthAccountId: cacheAccountId as string,
        fetchedAt: '2026-10-31T00:00:00.000Z',
        models: [{ id: 'gemini-3.1-pro-high', upstreamModelId: 'gemini-3.1-pro-high', name: 'Gemini Pro', modelFormat: 'cloud-code' }],
      },
      addedAt: '2026-10-31T00:00:00.000Z',
    }],
  };
}

describe('Antigravity registry persistence', () => {
  it('preserves the OAuth account that owns a cached model catalog', () => {
    saveRegistry(registry('account-a'));

    expect(loadRegistry().providers[0]?.modelsCache?.oauthAccountId).toBe('account-a');
  });

  it('rejects cached model ownership with a non-string account identity', () => {
    writeFileSync(getProvidersPath(), JSON.stringify(registry(17)));

    expect(() => loadRegistryStrict()).toThrow(/invalid|provider|registry/i);
  });
});
