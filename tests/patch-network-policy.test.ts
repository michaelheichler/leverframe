import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const readClaudeContent = vi.hoisted(() => vi.fn(async () => 'source'));

vi.mock('../src/claude-bundle.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/claude-bundle.js')>();
  return { ...actual, readClaudeContent };
});

import { defaultPatchRuntime } from '../src/patch-transaction.js';

const roots: string[] = [];

afterEach(() => {
  readClaudeContent.mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeVersionedScript(root: string): string {
  const path = join(root, 'claude');
  writeFileSync(
    path,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.263 (Claude Code)"; exit 0; fi\n',
    { mode: 0o755 },
  );
  return path;
}

describe('patch diagnostic network policy', () => {
  it('disables package fetching while inspecting a native target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'leverframe-diagnostics-network-'));
    roots.push(root);
    const path = writeVersionedScript(root);

    const result = await defaultPatchRuntime.inspect(path);

    expect(result.readable).toBe(true);
    expect(readClaudeContent).toHaveBeenCalledWith(
      path,
      '2.1.263',
      { allowNetwork: false },
    );
  });

  it('forwards the caller network policy through runtime reads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'leverframe-runtime-network-'));
    roots.push(root);
    const path = writeVersionedScript(root);

    await defaultPatchRuntime.readContent(path, '2.1.263', { allowNetwork: false });

    expect(readClaudeContent).toHaveBeenCalledWith(
      path,
      '2.1.263',
      { allowNetwork: false },
    );
  });
});
