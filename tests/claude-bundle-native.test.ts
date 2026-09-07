import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUN_BYTECODE_PREFIX,
  BUN_TRAILER,
  SIZEOF_MODULE_NEW,
  SIZEOF_OFFSETS,
} from '../src/claude-bundle-repack.js';

const parse = vi.hoisted(() => vi.fn());
const disable = vi.hoisted(() => vi.fn());

vi.mock('node-lief', () => ({
  default: {
    logging: { disable },
    parse,
  },
}));

import { extractClaudeJsFromNativeInstallation } from '../src/claude-bundle-native.js';

const roots: string[] = [];

afterEach(() => {
  parse.mockReset();
  disable.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type FixtureModule = [name: string, content: Buffer, bytecode?: Buffer];
type NativePlatform = 'linux' | 'darwin';
type NativeFormat = 'ELF' | 'MachO';
type NativeFixtureOptions = { platform: NativePlatform; format: NativeFormat };

const NATIVE_PLATFORMS: NativeFixtureOptions[] = [
  { platform: 'linux', format: 'ELF' },
  { platform: 'darwin', format: 'MachO' },
];

function makeBunSection(modules: FixtureModule[]): Buffer {
  const offsets = new Map<string, { offset: number; length: number }>();
  let stringsLength = 0;
  for (const [name, content, bytecode] of modules) {
    offsets.set(`${name}:name`, { offset: stringsLength, length: Buffer.byteLength(name) });
    stringsLength += Buffer.byteLength(name);
    offsets.set(`${name}:content`, { offset: stringsLength, length: content.length });
    stringsLength += content.length;
    if (bytecode) {
      offsets.set(`${name}:bytecode`, { offset: stringsLength, length: bytecode.length });
      stringsLength += bytecode.length;
    }
  }

  const modulesOffset = stringsLength;
  const offsetsOffset = modulesOffset + modules.length * SIZEOF_MODULE_NEW;
  const bunData = Buffer.alloc(offsetsOffset + SIZEOF_OFFSETS + BUN_TRAILER.length);
  for (const [name, content, bytecode] of modules) {
    const nameInfo = offsets.get(`${name}:name`)!;
    const contentInfo = offsets.get(`${name}:content`)!;
    Buffer.from(name).copy(bunData, nameInfo.offset);
    content.copy(bunData, contentInfo.offset);
    if (bytecode) bytecode.copy(bunData, offsets.get(`${name}:bytecode`)!.offset);
  }

  for (const [index, [name]] of modules.entries()) {
    const moduleOffset = modulesOffset + index * SIZEOF_MODULE_NEW;
    const nameInfo = offsets.get(`${name}:name`)!;
    const contentInfo = offsets.get(`${name}:content`)!;
    bunData.writeUInt32LE(nameInfo.offset, moduleOffset);
    bunData.writeUInt32LE(nameInfo.length, moduleOffset + 4);
    bunData.writeUInt32LE(contentInfo.offset, moduleOffset + 8);
    bunData.writeUInt32LE(contentInfo.length, moduleOffset + 12);
    const bytecodeInfo = offsets.get(`${name}:bytecode`);
    if (bytecodeInfo) {
      bunData.writeUInt32LE(bytecodeInfo.offset, moduleOffset + 24);
      bunData.writeUInt32LE(bytecodeInfo.length, moduleOffset + 28);
    }
  }

  bunData.writeBigUInt64LE(BigInt(offsetsOffset), offsetsOffset);
  bunData.writeUInt32LE(modulesOffset, offsetsOffset + 8);
  bunData.writeUInt32LE(modules.length * SIZEOF_MODULE_NEW, offsetsOffset + 12);
  bunData.writeUInt32LE(0, offsetsOffset + 16);
  bunData.writeUInt32LE(0, offsetsOffset + 20);
  bunData.writeUInt32LE(0, offsetsOffset + 24);
  bunData.writeUInt32LE(0, offsetsOffset + 28);
  BUN_TRAILER.copy(bunData, offsetsOffset + SIZEOF_OFFSETS);

  const section = Buffer.alloc(4 + bunData.length);
  section.writeUInt32LE(bunData.length, 0);
  bunData.copy(section, 4);
  return section;
}

function nativeFixture(section: Buffer, fixture: NativeFixtureOptions): string {
  const root = mkdtempSync(join(tmpdir(), 'leverframe-native-extraction-'));
  roots.push(root);
  const binaryPath = join(root, 'claude');
  writeFileSync(binaryPath, fixture.format === 'ELF'
    ? Buffer.from([0x7f, 0x45, 0x4c, 0x46])
    : Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
  const bunSection = { content: section, fileOffset: 0n };
  parse.mockReturnValue(fixture.format === 'ELF'
    ? {
        format: 'ELF',
        getSection: (name: string) => name === '.bun' ? bunSection : undefined,
        hasOverlay: false,
      }
    : {
        format: 'MachO',
        getSegment: (name: string) => name === '__BUN'
          ? { getSection: (sectionName: string) => sectionName === '__bun' ? bunSection : undefined }
          : undefined,
      });
  return binaryPath;
}

function extractForPlatform(
  section: Buffer,
  fixture: NativeFixtureOptions,
  version?: string,
  options: { allowNetwork?: boolean } = {},
) {
  const binaryPath = nativeFixture(section, fixture);
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue(fixture.platform);
  try {
    return extractClaudeJsFromNativeInstallation(binaryPath, version, options);
  } finally {
    platform.mockRestore();
  }
}

describe('native Claude bundle extraction', () => {
  it.each(NATIVE_PLATFORMS)('reports an explicit error for bytecode-only $format on $platform without network access', (fixture) => {
    const bytecode = Buffer.concat([Buffer.from(`${BUN_BYTECODE_PREFIX}\n`, 'utf8'), Buffer.from([0x00, 0xff, 0x80])]);
    const extracted = extractForPlatform(
      makeBunSection([['claude', bytecode]]),
      fixture,
      '2.1.263',
      { allowNetwork: false },
    );

    expect(extracted.data).toBeNull();
    expect(extracted.clearBytecode).toBe(false);
    expect(extracted.error).toMatch(/Bun bytecode/i);
    expect(extracted.error).toMatch(/network/i);
  });

  it.each(NATIVE_PLATFORMS)('rejects bytecode in a secondary module on $platform before concatenating it as UTF-8', (fixture) => {
    const bytecode = Buffer.concat([Buffer.from(`${BUN_BYTECODE_PREFIX}\n`, 'utf8'), Buffer.from([0x00, 0xff, 0x80])]);
    const extracted = extractForPlatform(
      makeBunSection([
        ['claude', Buffer.from('export const cli = true;', 'utf8')],
        ['chunk-runtime.js', bytecode],
      ]),
      fixture,
      undefined,
      { allowNetwork: false },
    );

    expect(extracted.data).toBeNull();
    expect(extracted.error).toMatch(/Bun bytecode/i);
  });

  it.each(NATIVE_PLATFORMS)('keeps a source module readable with a bytecode cache on $platform', (fixture) => {
    const source = Buffer.from(`${BUN_BYTECODE_PREFIX}\nexport const cli = true;`, 'utf8');
    const cachedBytecode = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const extracted = extractForPlatform(
      makeBunSection([['claude', source, cachedBytecode]]),
      fixture,
      undefined,
      { allowNetwork: false },
    );

    expect(extracted).toEqual({ data: source, clearBytecode: false });
  });

  it.each([
    { platform: 'linux' as const, format: 'MachO' as const, expected: 'ELF' },
    { platform: 'darwin' as const, format: 'ELF' as const, expected: 'MachO' },
  ])('rejects a $format fixture when running on $platform', ({ expected, ...fixture }) => {
    const extracted = extractForPlatform(
      makeBunSection([['claude', Buffer.from('export const cli = true;', 'utf8')]]),
      fixture,
      undefined,
      { allowNetwork: false },
    );

    expect(extracted.data).toBeNull();
    expect(extracted.error).toMatch(new RegExp(`does not match ${fixture.platform} \\(${expected}\\)`));
  });
});
