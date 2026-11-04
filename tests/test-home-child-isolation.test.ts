import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { installTestHomeIsolation } from './fixtures/test-home-lifecycle.js';

const tempBaseForOwnedChild = process.platform === 'darwin' ? '/tmp' : process.env['TMPDIR']!;

it('preserves a marked worker home beneath the canonical short temp base', () => {
  const tempRoot = process.env['TMPDIR']!;
  const workerHome = mkdtempSync(join(tempRoot, 'leverframe-worker-home-'));
  const env = { HOME: workerHome, LEVERFRAME_HOME: workerHome, LEVERFRAME_TEST_HOME: workerHome, TMPDIR: tempBaseForOwnedChild };
  const cleanups: Array<() => void> = [];

  try {
    expect(installTestHomeIsolation({ env, registerAfterAll: cleanup => cleanups.push(cleanup) })).toBe(realpathSync.native(workerHome));
    expect(env.HOME).toBe(workerHome);
    expect(cleanups).toHaveLength(0);
  } finally {
    rmSync(workerHome, { recursive: true, force: true });
  }
});

it('keeps an owned short runner temp root as the fresh home base', () => {
  const caseRoot = mkdtempSync(join(process.env['TMPDIR']!, 'leverframe-short-runner-'));
  const tempRoot = join(caseRoot, 'tmp');
  mkdirSync(tempRoot);
  const env = { HOME: tempRoot, LEVERFRAME_HOME: tempRoot, TMPDIR: tempRoot };
  const cleanups: Array<() => void> = [];

  try {
    const isolatedHome = installTestHomeIsolation({ env, registerAfterAll: cleanup => cleanups.push(cleanup) });
    expect(realpathSync.native(dirname(isolatedHome))).toBe(realpathSync.native(tempRoot));
    cleanups.pop()?.();
    expect(existsSync(isolatedHome)).toBe(false);
  } finally {
    cleanups.pop()?.();
    rmSync(caseRoot, { recursive: true, force: true });
  }
});

it('reallocates a worker home whose symlink escapes its private temp root', () => {
  const caseRoot = mkdtempSync(join(process.env['TMPDIR']!, 'leverframe-worker-case-'));
  const tempRoot = join(caseRoot, 'private');
  const outside = join(caseRoot, 'outside');
  mkdirSync(tempRoot);
  mkdirSync(outside);
  const linkedHome = join(tempRoot, 'linked-home');
  symlinkSync(outside, linkedHome, 'junction');
  const cleanups: Array<() => void> = [];
  const env = { HOME: linkedHome, LEVERFRAME_HOME: linkedHome, LEVERFRAME_TEST_HOME: linkedHome, TMPDIR: tempRoot };

  try {
    const isolatedHome = installTestHomeIsolation({ env, registerAfterAll: cleanup => cleanups.push(cleanup), tempBase: tempRoot });
    expect(isolatedHome).not.toBe(linkedHome);
    expect(realpathSync.native(dirname(isolatedHome))).toBe(realpathSync.native(tempRoot));
    cleanups.pop()?.();
    expect(existsSync(isolatedHome)).toBe(false);
  } finally {
    cleanups.pop()?.();
    rmSync(caseRoot, { recursive: true, force: true });
  }
});

it('preserves a valid candidate environment without adding harness variables', () => {
  const candidateHome = mkdtempSync(join(process.env['TMPDIR']!, 'leverframe-candidate-home-'));
  const appHome = join(candidateHome, '.leverframe');
  const configRoot = join(candidateHome, 'candidate-config');
  mkdirSync(appHome);
  mkdirSync(configRoot);
  const env = {
    HOME: candidateHome,
    CANDIDATE_HOME: candidateHome,
    CANDIDATE_CONFIG: configRoot,
    LEVERFRAME_HOME: appHome,
    LEVERFRAME_CANDIDATE_MODE: '1',
  };
  const cleanups: Array<() => void> = [];

  try {
    expect(installTestHomeIsolation({ env, registerAfterAll: cleanup => cleanups.push(cleanup) })).toBe(realpathSync.native(candidateHome));
    expect(env.LEVERFRAME_HOME).toBe(appHome);
    expect(cleanups).toHaveLength(0);
  } finally {
    rmSync(candidateHome, { recursive: true, force: true });
  }
});

it('reallocates a candidate environment whose root symlink escapes its private temp root', () => {
  const caseRoot = mkdtempSync(join(process.env['TMPDIR']!, 'leverframe-candidate-case-'));
  const tempRoot = join(caseRoot, 'private');
  const outside = join(caseRoot, 'outside');
  mkdirSync(tempRoot);
  mkdirSync(outside);
  const linkedHome = join(tempRoot, 'linked-candidate');
  symlinkSync(outside, linkedHome, 'junction');
  const appHome = join(linkedHome, '.leverframe');
  const configRoot = join(linkedHome, 'candidate-config');
  mkdirSync(join(outside, '.leverframe'));
  mkdirSync(join(outside, 'candidate-config'));
  const cleanups: Array<() => void> = [];
  const env = {
    HOME: linkedHome,
    CANDIDATE_HOME: linkedHome,
    CANDIDATE_CONFIG: configRoot,
    LEVERFRAME_HOME: appHome,
    LEVERFRAME_CANDIDATE_MODE: '1',
    TMPDIR: tempRoot,
  };

  try {
    const isolatedHome = installTestHomeIsolation({ env, registerAfterAll: cleanup => cleanups.push(cleanup), tempBase: tempRoot });
    expect(isolatedHome).not.toBe(appHome);
    expect(realpathSync.native(dirname(isolatedHome))).toBe(realpathSync.native(tempRoot));
    cleanups.pop()?.();
    expect(existsSync(isolatedHome)).toBe(false);
  } finally {
    cleanups.pop()?.();
    rmSync(caseRoot, { recursive: true, force: true });
  }
});

it('rejects an injected temp base outside the environment temp root', () => {
  const caseRoot = mkdtempSync(join(process.env['TMPDIR']!, 'leverframe-temp-base-case-'));
  const tempRoot = join(caseRoot, 'private');
  const outside = join(caseRoot, 'outside');
  mkdirSync(tempRoot);
  mkdirSync(outside);
  const env = { HOME: outside, LEVERFRAME_HOME: outside, LEVERFRAME_TEST_HOME: outside, TMPDIR: tempRoot };

  try {
    expect(() => installTestHomeIsolation({ env, registerAfterAll: () => undefined, tempBase: outside })).toThrow();
  } finally {
    rmSync(caseRoot, { recursive: true, force: true });
  }
});
