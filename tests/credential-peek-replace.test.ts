import { mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _credentialStoreInternals,
  getCredentialFallbackPath,
  peekStoredCredential,
  UnstableCredentialSnapshotError,
  writeFallbackCredential,
} from '../src/credential-store.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';
import { loadStoredRegistryProviders } from '../src/registry/load.js';

const openHook = vi.hoisted(() => ({ beforeOpen: (_path: string): void => {} }));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      openHook.beforeOpen(String(args[0]));
      return actual.openSync(...args);
    },
  };
});

const ACCOUNT = 'provider:openai';

afterEach(() => {
  openHook.beforeOpen = () => {};
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function seedFallback(): string {
  vi.stubEnv('LEVERFRAME_HOME', join(mkdtempSync(join(tmpdir(), 'leverframe-peek-replace-')), 'home'));
  writeFallbackCredential(ACCOUNT, 'fallback-before');
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockResolvedValue({ ok: true, value: 'primary-stale' });
  return getCredentialFallbackPath();
}

function replaceFallbackBeforeOpen(path: string, replacements: number): void {
  let replaced = 0;
  openHook.beforeOpen = opened => {
    if (opened !== path || replaced >= replacements) return;
    replaced += 1;
    const staging = `${path}.staging`;
    const content = { schemaVersion: 1, credentials: { [ACCOUNT]: 'fallback-after' } };
    writeFileSync(staging, JSON.stringify(content), { mode: 0o600 });
    renameSync(staging, path);
  };
}

describe('peekStoredCredential when a writer replaces the fallback file', () => {
  it('returns the replacement fallback after one replacement', async () => {
    replaceFallbackBeforeOpen(seedFallback(), 1);

    await expect(peekStoredCredential(ACCOUNT)).resolves.toBe('fallback-after');
  });

  it('reports an unstable snapshot instead of the primary when every read is replaced', async () => {
    replaceFallbackBeforeOpen(seedFallback(), Number.POSITIVE_INFINITY);

    await expect(peekStoredCredential(ACCOUNT)).rejects.toBeInstanceOf(UnstableCredentialSnapshotError);
  });

  it('lists the provider as unstable in the stored catalog', async () => {
    const path = seedFallback();
    saveRegistry({
      ...loadRegistry(),
      providers: [{
        id: 'openai',
        templateId: 'openai',
        name: 'OpenAI',
        enabled: true,
        authRef: `keyring:${ACCOUNT}`,
        api: { npm: '@ai-sdk/openai' },
        modelsCache: { fetchedAt: '2026-10-14T00:00:00.000Z', models: [] },
        addedAt: '2026-10-14T00:00:00.000Z',
      }],
    });
    replaceFallbackBeforeOpen(path, Number.POSITIVE_INFINITY);

    const catalog = await loadStoredRegistryProviders({ agent: 'claude' });

    expect(catalog.unstable).toEqual(['openai']);
    expect(catalog.refreshDue).toEqual([]);
  });
});
