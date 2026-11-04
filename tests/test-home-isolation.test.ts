import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getProvidersPath } from '../src/paths.js';
import { installTestHomeIsolation } from './fixtures/test-home-lifecycle.js';

const isolatedHome = process.env['LEVERFRAME_TEST_HOME'];

describe('test home isolation', () => {
  it('resolves the provider registry inside the isolated home before test overrides', () => {
    expect(dirname(getProvidersPath())).toBe(isolatedHome);
  });

  it('restores the isolated home path after a test removes environment stubs', () => {
    vi.stubEnv('LEVERFRAME_HOME', '/tmp/provider-registry-test-override');
    vi.unstubAllEnvs();

    expect(dirname(getProvidersPath())).toEqual(isolatedHome);
  });

  it('reuses the stable temp base after cleaning one setup home before creating the next', () => {
    vi.stubEnv('HOME', process.env['HOME']);
    vi.stubEnv('USERPROFILE', process.env['USERPROFILE']);
    vi.stubEnv('LEVERFRAME_HOME', process.env['LEVERFRAME_HOME']);
    vi.stubEnv('LEVERFRAME_TEST_HOME', process.env['LEVERFRAME_TEST_HOME']);
    vi.stubEnv('TMPDIR', process.env['TMPDIR']);
    vi.stubEnv('TMP', process.env['TMP']);
    vi.stubEnv('TEMP', process.env['TEMP']);
    const stableBase = process.env['TMPDIR']!;
    const cleanups: Array<() => void> = [];
    const registerAfterAll = (cleanup: () => void) => { cleanups.push(cleanup); };

    try {
      const firstHome = installTestHomeIsolation({ env: process.env, registerAfterAll, tempBase: stableBase });
      const firstTemp = join(firstHome, 'tmp');
      expect(realpathSync.native(dirname(firstHome))).toBe(realpathSync.native(stableBase));
      expect(process.env['HOME']).toBe(firstHome);
      expect(process.env['USERPROFILE']).toBe(firstHome);
      expect(process.env['LEVERFRAME_HOME']).toBe(join(firstHome, 'leverframe'));
      expect(process.env['LEVERFRAME_TEST_HOME']).toBe(join(firstHome, 'leverframe'));
      expect([process.env['TMPDIR'], process.env['TMP'], process.env['TEMP']]).toEqual([firstTemp, firstTemp, firstTemp]);
      expect(existsSync(firstTemp)).toBe(true);

      const firstCleanup = cleanups.pop()!;
      firstCleanup();
      expect(existsSync(firstHome)).toBe(false);
      expect([process.env['TMPDIR'], process.env['TMP'], process.env['TEMP']]).toEqual([stableBase, stableBase, stableBase]);

      const secondHome = installTestHomeIsolation({ env: process.env, registerAfterAll, tempBase: stableBase });
      const secondTemp = join(secondHome, 'tmp');
      expect(secondHome).not.toBe(firstHome);
      expect(realpathSync.native(dirname(secondHome))).toBe(realpathSync.native(stableBase));
      expect([process.env['TMPDIR'], process.env['TMP'], process.env['TEMP']]).toEqual([secondTemp, secondTemp, secondTemp]);
      expect(existsSync(secondTemp)).toBe(true);

      const secondCleanup = cleanups.pop()!;
      secondCleanup();
      expect(existsSync(secondHome)).toBe(false);
      expect([process.env['TMPDIR'], process.env['TMP'], process.env['TEMP']]).toEqual([stableBase, stableBase, stableBase]);
    } finally {
      cleanups.pop()?.();
      vi.unstubAllEnvs();
    }
  });
});
