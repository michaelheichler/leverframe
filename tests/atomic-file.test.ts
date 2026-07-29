import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  atomicWriteFileSync,
  atomicWriteJsonSync,
  commitSameDirectoryStageSync,
  copyImmutableFileSync,
  ensureDirectoryDurableSync,
  sameDirectoryStagePath,
} from '../src/atomic-file.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'leverframe-atomic-file-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

it('creates stages beside their target', () => {
    const target = join(root, 'state', 'manifest.json');
    ensureDirectoryDurableSync(dirname(target));

    const stage = sameDirectoryStagePath(target, 'manifest');

    expect(dirname(stage)).toBe(dirname(target));
    expect(stage).toContain('.leverframe-manifest.json-manifest-');
  });

  it('atomically replaces a file and enforces its requested mode', () => {
    const target = join(root, 'manifest.json');
    writeFileSync(target, 'old', { mode: 0o644 });

    atomicWriteFileSync(target, 'new', { mode: 0o600 });

    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).filter(name => name.includes('-write-'))).toEqual([]);
  });

  it('writes newline-terminated JSON into a newly-created durable directory tree', () => {
    const target = join(root, 'state', 'patches', 'identity', 'manifest.json');

    atomicWriteJsonSync(target, { schemaVersion: 2, generation: 7 });

    expect(readFileSync(target, 'utf8')).toBe('{\n  "schemaVersion": 2,\n  "generation": 7\n}\n');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('commits an executable stage without changing its mode', () => {
    const target = join(root, 'claude');
    const stage = sameDirectoryStagePath(target, 'binary');
    writeFileSync(stage, 'patched', { mode: 0o755 });

    commitSameDirectoryStageSync(stage, target, { mode: 0o755 });

    expect(readFileSync(target, 'utf8')).toBe('patched');
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(existsSync(stage)).toBe(false);
  });

  it('rejects a stage outside the destination directory', () => {
    const other = join(root, 'other');
    ensureDirectoryDurableSync(other);
    const stage = join(other, 'stage');
    writeFileSync(stage, 'candidate');

    expect(() => commitSameDirectoryStageSync(stage, join(root, 'target')))
      .toThrow('Refusing cross-directory atomic commit');
    expect(readFileSync(stage, 'utf8')).toBe('candidate');
  });

  it('publishes immutable copies and never replaces an existing baseline', () => {
    const source = join(root, 'claude-source');
    const baseline = join(root, 'state', 'baselines', 'claude-1.2.3-deadbeef.orig');
    writeFileSync(source, 'pristine', { mode: 0o755 });

    copyImmutableFileSync(source, baseline);
    writeFileSync(source, 'different', { mode: 0o755 });

    expect(() => copyImmutableFileSync(source, baseline)).toThrow();
  expect(readFileSync(baseline, 'utf8')).toBe('pristine');
  expect(statSync(baseline).mode & 0o777).toBe(0o755);
});
