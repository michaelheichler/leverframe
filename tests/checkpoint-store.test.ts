import { existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureExecutionDir,
  getCheckpointPath,
  getExecutionDir,
  getExecutionsRoot,
  isExpired,
  listExecutions,
  readDocument,
  removeExecution,
  tryAcquireExecutionLock,
  withExecutionLock,
  workspaceOrSessionHash,
  writeDocumentCAS,
  type HasSchemaAndGeneration,
} from '../src/checkpoint-store.js';

const originalHome = process.env.LEVERFRAME_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = originalHome;
});

function home(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'leverframe-checkpoint-store-')), 'home');
  process.env.LEVERFRAME_HOME = path;
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

interface Doc extends HasSchemaAndGeneration {
  schemaVersion: 1;
  generation: number;
  value: string;
}

function isDoc(value: Record<string, unknown>): boolean {
  return typeof value.value === 'string';
}

describe('workspaceOrSessionHash', () => {
  it('is a stable, bounded, non-reversible digest', () => {
    const a = workspaceOrSessionHash('/Users/me/project');
    const b = workspaceOrSessionHash('/Users/me/project');
    const c = workspaceOrSessionHash('/Users/me/other');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain('project');
  });
});

describe('directory and file permissions', () => {
  it('creates the execution directory 0700', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope-1');
    ensureExecutionDir(scopeHash, 'exec-1');
    const stats = statSync(getExecutionDir(scopeHash, 'exec-1'));
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it('publishes checkpoint documents 0600', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope-1');
    ensureExecutionDir(scopeHash, 'exec-1');
    const path = getCheckpointPath(scopeHash, 'exec-1');
    const doc: Doc = { schemaVersion: 1, generation: 1, value: 'hello' };
    const result = writeDocumentCAS(path, 1, isDoc, 0, doc, 'doc');
    expect(result.ok).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('readDocument explicit states', () => {
  it('reports missing for a file that was never published', () => {
    home();
    const path = join(getExecutionsRoot(), 'scope', 'exec', 'checkpoint.json');
    const result = readDocument<Doc>(path, 1, isDoc, 'doc');
    expect(result.state).toBe('missing');
    expect(result.generation).toBe(0);
  });

  it('reports corrupt for invalid JSON', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    ensureExecutionDir(scopeHash, 'exec');
    const path = getCheckpointPath(scopeHash, 'exec');
    writeFileSync(path, 'not json{{{', { mode: 0o600 });
    const result = readDocument<Doc>(path, 1, isDoc, 'doc');
    expect(result.state).toBe('corrupt');
  });

  it('reports corrupt when required fields fail validation', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    ensureExecutionDir(scopeHash, 'exec');
    const path = getCheckpointPath(scopeHash, 'exec');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, generation: 1 }), { mode: 0o600 });
    const result = readDocument<Doc>(path, 1, isDoc, 'doc');
    expect(result.state).toBe('corrupt');
  });

  it('reports unsupported-version distinctly from corrupt, preserving the generation', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    ensureExecutionDir(scopeHash, 'exec');
    const path = getCheckpointPath(scopeHash, 'exec');
    writeFileSync(path, JSON.stringify({ schemaVersion: 99, generation: 4, value: 'x' }), { mode: 0o600 });
    const result = readDocument<Doc>(path, 1, isDoc, 'doc');
    expect(result.state).toBe('unsupported-version');
    expect(result.generation).toBe(4);
  });

  it('reports invalid-storage for a symlinked document path', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    ensureExecutionDir(scopeHash, 'exec');
    const path = getCheckpointPath(scopeHash, 'exec');
    const real = `${path}.real`;
    writeFileSync(real, JSON.stringify({ schemaVersion: 1, generation: 1, value: 'x' }), { mode: 0o600 });
    symlinkSync(real, path);
    const result = readDocument<Doc>(path, 1, isDoc, 'doc');
    expect(result.state).toBe('invalid-storage');
  });
});

describe('compare-and-swap publish', () => {
  it('publishes generation 1 from nothing (0 -> 1)', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    ensureExecutionDir(scopeHash, 'exec');
    const path = getCheckpointPath(scopeHash, 'exec');
    const result = writeDocumentCAS(path, 1, isDoc, 0, { schemaVersion: 1, generation: 1, value: 'a' } as Doc, 'doc');
    expect(result).toEqual({ ok: true, generation: 1 });
  });

  it('rejects a stale generation as a conflict without touching the file', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    ensureExecutionDir(scopeHash, 'exec');
    const path = getCheckpointPath(scopeHash, 'exec');
    writeDocumentCAS(path, 1, isDoc, 0, { schemaVersion: 1, generation: 1, value: 'a' } as Doc, 'doc');

    const conflict = writeDocumentCAS(path, 1, isDoc, 0, { schemaVersion: 1, generation: 1, value: 'b' } as Doc, 'doc');
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.reason).toBe('conflict');
      expect(conflict.currentGeneration).toBe(1);
    }
    const read = readDocument<Doc>(path, 1, isDoc, 'doc');
    expect(read.value?.value).toBe('a');
  });

  it('advances generation 1 -> 2 only when the expected generation matches', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    ensureExecutionDir(scopeHash, 'exec');
    const path = getCheckpointPath(scopeHash, 'exec');
    writeDocumentCAS(path, 1, isDoc, 0, { schemaVersion: 1, generation: 1, value: 'a' } as Doc, 'doc');
    const second = writeDocumentCAS(path, 1, isDoc, 1, { schemaVersion: 1, generation: 2, value: 'b' } as Doc, 'doc');
    expect(second).toEqual({ ok: true, generation: 2 });
    const read = readDocument<Doc>(path, 1, isDoc, 'doc');
    expect(read.value?.value).toBe('b');
  });

  it('refuses to write onto a corrupt document even when the generation matches', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    ensureExecutionDir(scopeHash, 'exec');
    const path = getCheckpointPath(scopeHash, 'exec');
    writeFileSync(path, 'garbage', { mode: 0o600 });
    const result = writeDocumentCAS(path, 1, isDoc, 0, { schemaVersion: 1, generation: 1, value: 'a' } as Doc, 'doc');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('corrupt');
  });

  it('throws if the caller supplies a non-adjacent next generation', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    ensureExecutionDir(scopeHash, 'exec');
    const path = getCheckpointPath(scopeHash, 'exec');
    expect(() => writeDocumentCAS(path, 1, isDoc, 0, { schemaVersion: 1, generation: 5, value: 'a' } as Doc, 'doc')).toThrow();
  });
});

describe('expiry', () => {
  it('treats a past ISO timestamp as expired and a future one as not', () => {
    const now = () => Date.parse('2024-01-01T00:00:00.000Z');
    expect(isExpired('2023-12-31T00:00:00.000Z', now)).toBe(true);
    expect(isExpired('2024-06-01T00:00:00.000Z', now)).toBe(false);
  });

  it('treats an unparsable timestamp as expired', () => {
    expect(isExpired('not-a-date')).toBe(true);
  });
});

describe('locking', () => {
  it('serializes concurrent CAS updates through the per-execution lock', async () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    ensureExecutionDir(scopeHash, 'exec');
    const path = getCheckpointPath(scopeHash, 'exec');
    writeDocumentCAS(path, 1, isDoc, 0, { schemaVersion: 1, generation: 1, value: 'a' } as Doc, 'doc');

    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => withExecutionLock(scopeHash, 'exec', () => {
      const current = readDocument<Doc>(path, 1, isDoc, 'doc');
      return writeDocumentCAS(path, 1, isDoc, current.generation, {
        schemaVersion: 1,
        generation: current.generation + 1,
        value: `write-${i}`,
      } as Doc, 'doc');
    })));

    expect(results.every(r => r.ok)).toBe(true);
    const final = readDocument<Doc>(path, 1, isDoc, 'doc');
    expect(final.generation).toBe(6);
  });

  it('lets a second non-blocking lock attempt fail while the first is held', () => {
    home();
    const scopeHash = workspaceOrSessionHash('scope');
    ensureExecutionDir(scopeHash, 'exec');
    const first = tryAcquireExecutionLock(scopeHash, 'exec');
    expect(first).not.toBeNull();
    const second = tryAcquireExecutionLock(scopeHash, 'exec');
    expect(second).toBeNull();
    first?.release();
    const third = tryAcquireExecutionLock(scopeHash, 'exec');
    expect(third).not.toBeNull();
    third?.release();
  });
});

describe('listing and removal', () => {
  it('lists every execution directory across scopes and removes them cleanly', () => {
    home();
    const scopeA = workspaceOrSessionHash('a');
    const scopeB = workspaceOrSessionHash('b');
    ensureExecutionDir(scopeA, 'exec-1');
    ensureExecutionDir(scopeA, 'exec-2');
    ensureExecutionDir(scopeB, 'exec-3');

    const listed = listExecutions();
    expect(listed).toHaveLength(3);
    expect(listed).toContainEqual({ scopeHash: scopeA, executionId: 'exec-1' });

    removeExecution(scopeA, 'exec-1');
    expect(existsSync(getExecutionDir(scopeA, 'exec-1'))).toBe(false);
    expect(listExecutions()).toHaveLength(2);
  });

  it('returns an empty list before any execution has ever been created', () => {
    home();
    expect(listExecutions()).toEqual([]);
  });
});
