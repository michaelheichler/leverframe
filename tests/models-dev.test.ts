import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  invalidateModelsDevCache,
  isModelsDevCacheFresh,
  getUserModelsDevCachePath,
  loadModelsDevCache,
  loadBundledModelsDevCache,
  readModelsDevCacheMeta,
  refreshModelsDevCacheAsync,
  stripModelsDevCacheMeta,
  type ModelsDevCacheFile,
} from '../src/registry/models-dev.js';
import { resetLegacyMigrationForTests } from '../src/paths.js';

let tempHome: string;
let previousHome: string | undefined;
let previousLeverframeHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'leverframe-modelsdev-'));
  previousHome = process.env['HOME'];
  previousLeverframeHome = process.env['LEVERFRAME_HOME'];
  process.env['HOME'] = tempHome;
  process.env['LEVERFRAME_HOME'] = join(tempHome, 'app-home');
  resetLegacyMigrationForTests();
  invalidateModelsDevCache();
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  if (previousLeverframeHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousLeverframeHome;
  resetLegacyMigrationForTests();
  invalidateModelsDevCache();
  vi.unstubAllGlobals();
});

function writeUserCache(data: ModelsDevCacheFile): void {
  const path = getUserModelsDevCachePath();
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data)}\n`, { encoding: 'utf8', mode: 0o600 });
  invalidateModelsDevCache();
}

describe('isModelsDevCacheFresh', () => {
  it('returns false for a null cache', () => {
    expect(isModelsDevCacheFresh(null)).toBe(false);
  });

  it('returns false when _relay_meta.fetched_at is missing', () => {
    const cache = { openai: { id: 'openai' } } as unknown as ModelsDevCacheFile;
    expect(isModelsDevCacheFresh(cache)).toBe(false);
  });

  it('returns true when fetched_at is within the 24h TTL', () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const cache = {
      _relay_meta: { fetched_at: recent, schema_version: '1' },
      openai: { id: 'openai' },
    } as unknown as ModelsDevCacheFile;
    expect(isModelsDevCacheFresh(cache)).toBe(true);
  });

  it('returns false when fetched_at is older than 24h', () => {
    const stale = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    const cache = {
      _relay_meta: { fetched_at: stale, schema_version: '1' },
      openai: { id: 'openai' },
    } as unknown as ModelsDevCacheFile;
    expect(isModelsDevCacheFresh(cache)).toBe(false);
  });

  it('returns false when fetched_at is unparseable', () => {
    const cache = {
      _relay_meta: { fetched_at: 'not-a-date', schema_version: '1' },
      openai: { id: 'openai' },
    } as unknown as ModelsDevCacheFile;
    expect(isModelsDevCacheFresh(cache)).toBe(false);
  });

  it('returns false when fetched_at is in the future', () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const cache = {
      _relay_meta: { fetched_at: future, schema_version: '1' },
      openai: { id: 'openai' },
    } as unknown as ModelsDevCacheFile;
    expect(isModelsDevCacheFresh(cache)).toBe(false);
  });
});

describe('refreshModelsDevCacheAsync TTL', () => {
  it('skips the network fetch when the on-disk cache is fresh', async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeUserCache({
      _relay_meta: { fetched_at: recent, schema_version: '1', source: 'https://models.dev/api.json' },
      openai: { id: 'openai' },
    } as unknown as ModelsDevCacheFile);

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    let completed = false;
    let result: boolean | undefined;
    refreshModelsDevCacheAsync({ onComplete: updated => { result = updated; completed = true; } });
    await vi.waitFor(() => { expect(completed).toBe(true); });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('fetches when the on-disk cache is stale', async () => {
    const stale = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    writeUserCache({
      _relay_meta: { fetched_at: stale, schema_version: '1', source: 'https://models.dev/api.json' },
      openai: { id: 'openai' },
    } as unknown as ModelsDevCacheFile);

    const fetchMock = vi.fn(async () => new Response('{"openai":{"id":"openai"}}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    let completed = false;
    let result: boolean | undefined;
    refreshModelsDevCacheAsync({ onComplete: updated => { result = updated; completed = true; } });
    await vi.waitFor(() => { expect(completed).toBe(true); });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toBe(true);
  });

  it('fetches when no user cache exists', async () => {
    const fetchMock = vi.fn(async () => new Response('{"openai":{"id":"openai"}}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    let completed = false;
    refreshModelsDevCacheAsync({ onComplete: () => { completed = true; } });
    await vi.waitFor(() => { expect(completed).toBe(true); });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fetches when force: true even if the cache is fresh', async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeUserCache({
      _relay_meta: { fetched_at: recent, schema_version: '1', source: 'https://models.dev/api.json' },
      openai: { id: 'openai' },
    } as unknown as ModelsDevCacheFile);

    const fetchMock = vi.fn(async () => new Response('{"openai":{"id":"openai"}}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    let completed = false;
    refreshModelsDevCacheAsync({ force: true, onComplete: () => { completed = true; } });
    await vi.waitFor(() => { expect(completed).toBe(true); });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fetches when the user cache is corrupt', async () => {
    const path = getUserModelsDevCachePath();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'not valid json', { encoding: 'utf8', mode: 0o600 });
    invalidateModelsDevCache();

    const fetchMock = vi.fn(async () => new Response('{"openai":{"id":"openai"}}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    let completed = false;
    refreshModelsDevCacheAsync({ onComplete: () => { completed = true; } });
    await vi.waitFor(() => { expect(completed).toBe(true); });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('fetches when no user cache exists even if the bundled fallback is fresh', async () => {
    loadModelsDevCache();

    const fetchMock = vi.fn(async () => new Response('{"openai":{"id":"openai"}}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    let completed = false;
    let result: boolean | undefined;
    refreshModelsDevCacheAsync({ onComplete: updated => { result = updated; completed = true; } });
    await vi.waitFor(() => { expect(completed).toBe(true); });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toBe(true);
  });

  it('supports the legacy callback form (onComplete as first arg)', async () => {
    const stale = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    writeUserCache({
      _relay_meta: { fetched_at: stale, schema_version: '1', source: 'https://models.dev/api.json' },
      openai: { id: 'openai' },
    } as unknown as ModelsDevCacheFile);

    const fetchMock = vi.fn(async () => new Response('{"openai":{"id":"openai"}}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    let completed = false;
    let result: boolean | undefined;
    refreshModelsDevCacheAsync(updated => { result = updated; completed = true; });
    await vi.waitFor(() => { expect(completed).toBe(true); });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toBe(true);
  });

  it('catches a throwing callback so the background refresh never rejects', async () => {
    const fetchMock = vi.fn(async () => new Response('{"openai":{"id":"openai"}}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const throwingCallback = vi.fn(() => { throw new Error('callback boom'); });
    refreshModelsDevCacheAsync(throwingCallback);

    await vi.waitFor(() => { expect(throwingCallback).toHaveBeenCalled(); });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('swallows an async-rejecting callback so no unhandledRejection escapes', async () => {
    const fetchMock = vi.fn(async () => new Response('{"openai":{"id":"openai"}}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const rejections: unknown[] = [];
    const unhandled = (reason: unknown) => { rejections.push(reason); };
    process.on('unhandledRejection', unhandled);

    const asyncRejecting = vi.fn(() => Promise.reject(new Error('async callback boom')));
    refreshModelsDevCacheAsync(asyncRejecting);

    try {
      await vi.waitFor(() => { expect(asyncRejecting).toHaveBeenCalled(); });
      await new Promise<void>(resolve => { setImmediate(resolve); });
      await new Promise<void>(resolve => { setTimeout(resolve, 30); });
      expect(rejections).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', unhandled);
    }
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('bundled cache sanity (regression)', () => {
  it('bundled snapshot remains loadable and exposes a fetched_at meta', () => {
    const cache = loadBundledModelsDevCache();
    const meta = readModelsDevCacheMeta(cache);
    expect(meta?.source).toBe('https://models.dev/api.json');
    expect(stripModelsDevCacheMeta(cache).openai).toBeDefined();
  });

  it('loadModelsDevCache returns bundled snapshot when no user cache exists', () => {
    expect(loadModelsDevCache()).toBe(loadBundledModelsDevCache());
  });
});
