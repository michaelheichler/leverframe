import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { getCredentialCleanupPath, getProvidersPath } from '../src/paths.js';
import {
  cancelCredentialDelete,
  loadPendingCredentialDeletes,
  queueCredentialDelete,
} from '../src/registry/credential-cleanup-journal.js';
import {
  _credentialLifecycleInternals,
  reconcilePendingCredentialDeletes,
} from '../src/registry/credential-lifecycle.js';
import { removeProviderFromRegistry } from '../src/registry/crud.js';
import { saveRegistry } from '../src/registry/io.js';
import type { ProviderRegistry } from '../src/registry/types.js';

const originalHome = process.env.LEVERFRAME_HOME;

function registry(authRef = 'keyring:provider:test'): ProviderRegistry {
  return {
    schemaVersion: 1,
    providers: [{
      id: 'test',
      templateId: 'test',
      name: 'Test',
      enabled: true,
      authRef,
      authType: 'api',
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://example.test/v1' },
      addedAt: '2026-01-01T00:00:00.000Z',
    }],
  };
}

beforeEach(() => {
  process.env.LEVERFRAME_HOME = join(mkdtempSync(join(tmpdir(), 'leverframe-lifecycle-')), 'home');
  _credentialLifecycleInternals.resetWarningsForTests();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = originalHome;
  vi.restoreAllMocks();
});

describe('credential cleanup journal', () => {
  it('validates, deduplicates, and durably publishes managed references', async () => {
    const ref = 'keyring:provider:test';
    expect(await queueCredentialDelete(ref)).toBe(true);
    expect(await queueCredentialDelete(ref)).toBe(true);
    expect(await queueCredentialDelete('keyring:not-managed')).toBe(false);
    expect(await loadPendingCredentialDeletes()).toEqual([ref]);
    expect(JSON.parse(readFileSync(getCredentialCleanupPath(), 'utf8'))).toEqual({
      schemaVersion: 1,
      pendingCredentialDeletes: [ref],
    });
    expect(await cancelCredentialDelete(ref)).toBe(true);
    expect(await loadPendingCredentialDeletes()).toEqual([]);
  });

  it('rejects corrupt, broad-mode, and symlinked journals without replacing them', async () => {
    const path = getCredentialCleanupPath();
    mkdirSync(process.env.LEVERFRAME_HOME!, { recursive: true, mode: 0o700 });
    writeFileSync(path, '{broken', { mode: 0o600 });
    await expect(loadPendingCredentialDeletes()).rejects.toThrow(/Could not read credential cleanup journal/);

    writeFileSync(path, '{"schemaVersion":1,"pendingCredentialDeletes":[]}', { mode: 0o644 });
    chmodSync(path, 0o644);
    await expect(loadPendingCredentialDeletes()).rejects.toThrow(/permissions are too broad/);

    const target = join(process.env.LEVERFRAME_HOME!, 'target.json');
    writeFileSync(target, '{"schemaVersion":1,"pendingCredentialDeletes":[]}', { mode: 0o600 });
    const link = join(process.env.LEVERFRAME_HOME!, 'journal-link.json');
    symlinkSync(target, link);
    await expect(loadPendingCredentialDeletes(link)).rejects.toThrow(/not a regular file/);
  });
});

describe('credential cleanup reconciliation', () => {
  it('cancels deletion when the reference becomes active again', async () => {
    saveRegistry(registry(), getProvidersPath());
    await queueCredentialDelete('keyring:provider:test');
    const operation = vi.spyOn(_credentialStoreInternals, 'keyringOperation');

    const result = await reconcilePendingCredentialDeletes();

    expect(result).toEqual({ deleted: [], pending: [] });
    expect(operation).not.toHaveBeenCalled();
  });

  it('queues before registry removal and deletes outside the registry lock', async () => {
    saveRegistry(registry(), getProvidersPath());
    vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockResolvedValue({ ok: true, value: null });

    const result = await removeProviderFromRegistry('test');

    expect(result.removed).toBe(true);
    expect(result.credentialDeleted).toBe(true);
    expect(await loadPendingCredentialDeletes()).toEqual([]);
  });

  it('retains uncertain failures and warns only once across retries', async () => {
    saveRegistry({ schemaVersion: 1, providers: [] }, getProvidersPath());
    await queueCredentialDelete('keyring:provider:test');
    vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockResolvedValue({ ok: false, error: 'backend uncertain' });
    const warnings: string[] = [];

    const first = await reconcilePendingCredentialDeletes(message => warnings.push(message));
    const second = await reconcilePendingCredentialDeletes(message => warnings.push(message));

    expect(first.pending).toEqual(['keyring:provider:test']);
    expect(second.pending).toEqual(['keyring:provider:test']);
    expect(warnings.filter(message => message.includes('could not be confirmed'))).toHaveLength(1);
  });
});
