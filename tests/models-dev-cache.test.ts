import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hideReason } from '../src/model-compatibility.js';
import {
  findModelsDevModel,
  getUserModelsDevCachePath,
  invalidateModelsDevCache,
  loadModelsDevCache,
  refreshModelsDevCacheAsync,
} from '../src/registry/models-dev.js';

const previousHome = process.env['LEVERFRAME_HOME'];
let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'leverframe-models-dev-'));
  process.env['LEVERFRAME_HOME'] = testHome;
  invalidateModelsDevCache();
});

afterEach(() => {
  invalidateModelsDevCache();
  vi.unstubAllGlobals();
  rmSync(testHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousHome;
});

describe('models.dev cache provenance', () => {
  it('treats absent disk metadata as unknown instead of loading a bundled snapshot', () => {
    expect(loadModelsDevCache()).toEqual({});
    expect(findModelsDevModel('synthetic-provider', 'unreported-model')).toBeNull();
    expect(hideReason({
      providerId: 'synthetic-provider',
      modelId: 'unreported-model',
      agent: 'claude',
    })).toBeNull();
  });

  it('uses explicit capability fields from a valid user disk cache', () => {
    writeFileSync(getUserModelsDevCachePath(), JSON.stringify({
      _relay_meta: {
        schema_version: '1',
        fetched_at: new Date().toISOString(),
        source: 'test',
      },
      'synthetic-provider': {
        models: {
          'synthetic-model': {
            id: 'synthetic-model',
            tool_call: false,
          },
        },
      },
    }));

    invalidateModelsDevCache();
    expect(findModelsDevModel('synthetic-provider', 'synthetic-model')).toMatchObject({
      id: 'synthetic-model',
      tool_call: false,
    });
    expect(hideReason({
      providerId: 'synthetic-provider',
      modelId: 'synthetic-model',
      agent: 'claude',
    })).toBe('[models.dev] incompatible capabilities for coding agents');
  });

  it('persists live catalog metadata as the user cache for later lookups', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        'synthetic-provider': {
          models: {
            'fresh-model': {
              id: 'fresh-model',
              modalities: { output: ['text'] },
            },
          },
        },
      }),
    } as Response));

    const completed = new Promise<boolean>(resolve => {
      refreshModelsDevCacheAsync({ force: true, onComplete: resolve });
    });
    await expect(completed).resolves.toBe(true);

    expect(existsSync(getUserModelsDevCachePath())).toBe(true);
    expect(readFileSync(getUserModelsDevCachePath(), 'utf8')).toContain('fresh-model');
    expect(findModelsDevModel('synthetic-provider', 'fresh-model')).toMatchObject({
      id: 'fresh-model',
    });
  });
});
