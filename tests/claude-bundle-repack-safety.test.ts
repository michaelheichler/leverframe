import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

import { execFileSync } from 'node:child_process';
import {
  computeBunSectionPlacement,
  repackMachO,
} from '../src/claude-bundle-repack-native.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeMachO(outputPath: string, sectionSize: bigint): never {
  const section = {
    content: Buffer.alloc(Number(sectionSize)),
    size: sectionSize,
  };
  const segment = {
    getSection: vi.fn(() => section),
  };
  const binary = {
    hasCodeSignature: false,
    getSegment: vi.fn(() => segment),
    header: { cpuType: 0 },
    extendSegment: vi.fn(() => true),
    removeSignature: vi.fn(),
    write: vi.fn((path: string) => writeFileSync(path, Buffer.from('rewritten'))),
  };
  writeFileSync(outputPath, 'original', { mode: 0o755 });
  return binary as never;
}

describe('native binary repacking safety', () => {
  it('rejects an ELF placement that would extend a non-topmost load segment', () => {
    expect(() => computeBunSectionPlacement({
      rwVirtualAddress: 0x2000n,
      rwVirtualSize: 0x1000n,
      rwFileOffset: 0x2000n,
      rwFileSize: 0x1000n,
      topmostLoadEnd: 0x5000n,
      nextVirtualAddress: 0x6000n,
      newContentSize: 0x1800n,
      pageSize: 0x1000n,
    })).toThrow(/not topmost/);
  });

  it('places content after a topmost writable load segment', () => {
    const placement = computeBunSectionPlacement({
      rwVirtualAddress: 0x2000n,
      rwVirtualSize: 0x1000n,
      rwFileOffset: 0x2000n,
      rwFileSize: 0x1000n,
      topmostLoadEnd: 0x3000n,
      newContentSize: 0x1800n,
      pageSize: 0x1000n,
    });

    expect(placement).toEqual({
      newVaddr: 0x3000n,
      newFileOffset: 0x3000n,
      alignedNewSize: 0x2000n,
      extensionSize: 0x2000n,
      compact: true,
    });
  });

  it('passes the codesign path as an argument and commits only after signing', () => {
    const root = mkdtempSync(join(tmpdir(), 'leverframe-repack-safety-'));
    roots.push(root);
    const outputPath = join(root, 'claude;touch injected');
    const binary = makeMachO(outputPath, 15n);

    repackMachO(binary, outputPath, Buffer.from('payload'), outputPath, 8);

    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      'codesign',
      ['-s', '-', '-f', `${outputPath}.tmp`],
      { stdio: 'ignore' },
    );
    expect(readFileSync(outputPath, 'utf8')).toBe('rewritten');
    expect(existsSync(join(root, 'injected'))).toBe(false);
  });

  it('keeps the original binary when codesign fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'leverframe-repack-rollback-'));
    roots.push(root);
    const outputPath = join(root, 'claude');
    const binary = makeMachO(outputPath, 15n);
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('codesign failed');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => repackMachO(binary, outputPath, Buffer.from('payload'), outputPath, 8))
      .toThrow('codesign failed');
    expect(readFileSync(outputPath, 'utf8')).toBe('original');
    expect(existsSync(`${outputPath}.tmp`)).toBe(false);
  });
});
