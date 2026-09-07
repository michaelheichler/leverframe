import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  computePeSectionPlacement,
  repackPE,
} from '../src/claude-bundle-repack-native.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface FakeSection {
  name: string;
  fileOffset: bigint;
  size: bigint;
  virtualSize: bigint;
  content: Buffer;
}

interface LIEFLikePe {
  sections: () => FakeSection[];
  optionalHeader: { fileAlignment: number };
  write: (path: string) => void;
}

function makePe(sections: FakeSection[]): LIEFLikePe {
  return {
    sections: () => sections,
    optionalHeader: { fileAlignment: 512 },
    write: (path: string) => writeFileSync(path, Buffer.from('rewritten')),
  };
}

function makeSection(name: string, fileOffset: bigint, size: bigint): FakeSection {
  return {
    name,
    fileOffset,
    size,
    virtualSize: size,
    content: Buffer.alloc(Number(size)),
  };
}

function outputPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'leverframe-repack-pe-'));
  roots.push(root);
  const path = join(root, 'claude.exe');
  writeFileSync(path, 'original');
  return path;
}

function signedOutputPath(securityDirectoryOffset = 0x1200): string {
  const path = outputPath();
  const file = Buffer.alloc(0x2000);
  const peHeaderOffset = 0x80;
  const optionalHeaderOffset = peHeaderOffset + 24;
  file.writeUInt16LE(0x5a4d, 0);
  file.writeUInt32LE(peHeaderOffset, 0x3c);
  file.writeUInt32LE(0x4550, peHeaderOffset);
  file.writeUInt16LE(240, peHeaderOffset + 20);
  file.writeUInt16LE(0x20b, optionalHeaderOffset);
  file.writeUInt32LE(16, optionalHeaderOffset + 108);
  file.writeUInt32LE(securityDirectoryOffset, optionalHeaderOffset + 112 + 4 * 8);
  file.writeUInt32LE(0x80, optionalHeaderOffset + 112 + 4 * 8 + 4);
  writeFileSync(path, file);
  return path;
}

describe('PE section repacking safety', () => {
  it('aligns raw data while keeping the mapped virtual size exact', () => {
    const bun = makeSection('.bun', 0x1000n, 0x200n);
    const next = makeSection('.reloc', 0x2000n, 0x200n);
    const pe = makePe([bun, next]);
    const path = outputPath();

    repackPE(pe as never, path, Buffer.alloc(600, 0x41), path, 8);

    expect(bun.virtualSize).toBe(608n);
    expect(bun.size).toBe(1024n);
    expect(bun.content).toHaveLength(608);
    expect(readFileSync(path, 'utf8')).toBe('rewritten');
  });

  it('preserves existing raw padding when the replacement is smaller', () => {
    const placement = computePeSectionPlacement({
      sectionFileOffset: 0x1000n,
      currentRawSize: 0x800n,
      nextSectionFileOffset: 0x2000n,
      newContentSize: 608n,
      fileAlignment: 512n,
    });

    expect(placement).toEqual({
      virtualSize: 608n,
      rawSize: 0x800n,
      extensionSize: 0n,
    });
  });

  it('rejects growth that would overwrite a following section before mutating it', () => {
    const bun = makeSection('.bun', 0x1000n, 0x200n);
    const next = makeSection('.reloc', 0x1300n, 0x200n);
    const pe = makePe([bun, next]);
    const path = outputPath();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => repackPE(pe as never, path, Buffer.alloc(600), path, 8))
      .toThrow(/overlap the next section/);
    expect(bun.size).toBe(0x200n);
    expect(bun.virtualSize).toBe(0x200n);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('original');
    expect(error).toHaveBeenCalled();
  });

  it('permits aligned growth when .bun is the final section', () => {
    const bun = makeSection('.bun', 0x1000n, 0x200n);
    const pe = makePe([bun]);
    const path = outputPath();

    repackPE(pe as never, path, Buffer.alloc(600), path, 8);

    expect(bun.size).toBe(1024n);
    expect(bun.virtualSize).toBe(608n);
  });

  it('rejects final growth into the PE security directory before mutation', () => {
    const bun = makeSection('.bun', 0x1000n, 0x200n);
    const pe = makePe([bun]);
    const path = signedOutputPath();
    const before = readFileSync(path);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => repackPE(pe as never, path, Buffer.alloc(600), path, 8))
      .toThrow(/security directory/);
    expect(bun.size).toBe(0x200n);
    expect(bun.virtualSize).toBe(0x200n);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(readFileSync(path)).toEqual(before);
    expect(error).toHaveBeenCalled();
  });

  it('rejects final growth before a security directory separated by a file gap', () => {
    const bun = makeSection('.bun', 0x1000n, 0x200n);
    const pe = makePe([bun]);
    const path = signedOutputPath(0x1500);
    const before = readFileSync(path);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => repackPE(pe as never, path, Buffer.alloc(600), path, 8))
      .toThrow(/security directory/);
    expect(bun.size).toBe(0x200n);
    expect(bun.virtualSize).toBe(0x200n);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(readFileSync(path)).toEqual(before);
    expect(error).toHaveBeenCalled();
  });
});
