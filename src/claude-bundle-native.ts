import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import LIEF from 'node-lief';
import {
  BUN_BYTECODE_PREFIX,
  BUN_TRAILER,
  SIZEOF_MODULE_NEW,
  SIZEOF_MODULE_OLD,
  SIZEOF_OFFSETS,
  getStringPointerContent,
  isChunkModule,
  isClaudeModule,
  mapModules,
  parseStringPointer,
  rebuildBunData,
  repackELFOverlay,
  repackELFSection,
  repackMachO,
  repackPE,
  type BunData,
  type BunOffsets,
} from './claude-bundle-repack.js';

export { isChunkModule, isClaudeModule };
export { resolveNixBinaryWrapper } from './claude-bundle-native-wrapper.js';
export {
  bytecodeForReplacement,
  computeBunSectionPlacement,
  sourceForInvalidatedBytecode,
  type BunSectionPlacement,
} from './claude-bundle-repack.js';

export interface NativeExtractionOptions {
  allowNetwork?: boolean;
}

const BUN_CJS_MARKER = '@bun-cjs';

interface LocatedBundle extends BunData {
  offset: number;
  length: number;
  write(newBunBuffer: Buffer, outputPath: string): void;
}

export const CLAUDE_MODULE_BOUNDARY = '\n//#__leverframe_claude_module__:';

export function splitModulePayload(content: string): Array<[string, string]> | null {
  if (!content.startsWith(CLAUDE_MODULE_BOUNDARY)) return null;
  return content.split(CLAUDE_MODULE_BOUNDARY).slice(1).map(segment => {
    const nameEnd = segment.indexOf('\n');
    if (nameEnd === -1) throw new Error('Malformed Leverframe Claude module boundary');
    return [segment.slice(0, nameEnd), segment.slice(nameEnd + 1)];
  });
}

function summarizeNames(names: string[]): string {
  const shown = names.slice(0, 5).join(', ');
  return names.length > 5 ? `${shown}, ... (${names.length} total)` : shown;
}

export function buildModuleReplacements(
  parts: Array<[string, string]>,
  expectedNames: string[],
): Map<string, Buffer> {
  const replacements = new Map<string, Buffer>();
  const duplicates: string[] = [];
  for (const [name, body] of parts) {
    if (replacements.has(name)) duplicates.push(name);
    replacements.set(name, Buffer.from(body));
  }
  if (duplicates.length) throw new Error(`Module payload names a module more than once: ${summarizeNames(duplicates)}`);
  const expected = new Set(expectedNames);
  const unknown = [...replacements.keys()].filter(name => !expected.has(name));
  if (unknown.length) throw new Error(`Module payload names ${unknown.length} module(s) absent from the binary: ${summarizeNames(unknown)}`);
  const missing = expectedNames.filter(name => !replacements.has(name));
  if (missing.length) throw new Error(`Module payload is missing ${missing.length} module(s) present in the binary: ${summarizeNames(missing)}`);
  return replacements;
}

function detectModuleStructSize(modulesListLength: number): number {
  const fitsNew = modulesListLength % SIZEOF_MODULE_NEW === 0;
  const fitsOld = modulesListLength % SIZEOF_MODULE_OLD === 0;

  if (fitsNew && !fitsOld) return SIZEOF_MODULE_NEW;
  if (fitsOld && !fitsNew) return SIZEOF_MODULE_OLD;
  if (fitsNew && fitsOld) return SIZEOF_MODULE_NEW;

  return SIZEOF_MODULE_NEW;
}

function collectClaudeJavaScriptModules(
  bunData: Buffer,
  bunOffsets: BunOffsets,
  moduleStructSize: number,
): Array<[string, Buffer]> {
  const modules: Array<[string, Buffer]> = [];
  mapModules(bunData, bunOffsets, moduleStructSize, (module, name) => {
    if (!isClaudeModule(name) && !isChunkModule(name)) return undefined;
    const content = getStringPointerContent(bunData, module.contents);
    if (content.length) modules.push([name, content]);
    return undefined;
  });
  return modules;
}

function parseOffsets(buffer: Buffer): BunOffsets {
  let pos = 0;
  const byteCount = buffer.readBigUInt64LE(pos);
  pos += 8;
  const modulesPtr = parseStringPointer(buffer, pos);
  pos += 8;
  const entryPointId = buffer.readUInt32LE(pos);
  pos += 4;
  const compileExecArgvPtr = parseStringPointer(buffer, pos);
  pos += 8;
  const flags = buffer.readUInt32LE(pos);

  return { byteCount, modulesPtr, entryPointId, compileExecArgvPtr, flags };
}

function parseBunDataBlob(bunDataContent: Buffer): {
  bunOffsets: BunOffsets;
  bunData: Buffer;
  moduleStructSize: number;
} {
  if (bunDataContent.length < SIZEOF_OFFSETS + BUN_TRAILER.length) {
    throw new Error('BUN data is too small to contain trailer and offsets');
  }

  const trailerStart = bunDataContent.length - BUN_TRAILER.length;
  const trailerBytes = bunDataContent.subarray(trailerStart);

  if (!trailerBytes.equals(BUN_TRAILER)) {

    throw new Error('BUN trailer bytes do not match trailer');
  }

  const offsetsStart =
    bunDataContent.length - SIZEOF_OFFSETS - BUN_TRAILER.length;
  const offsetsBytes = bunDataContent.subarray(
    offsetsStart,
    offsetsStart + SIZEOF_OFFSETS
  );
  const bunOffsets = parseOffsets(offsetsBytes);
  const moduleStructSize = detectModuleStructSize(bunOffsets.modulesPtr.length);

  return {
    bunOffsets,
    bunData: bunDataContent,
    moduleStructSize,
  };
}

function extractBunDataFromSection(sectionData: Buffer): BunData {
  if (sectionData.length < 4) {
    throw new Error('Section data too small');
  }

  const bunDataSizeU32 = sectionData.readUInt32LE(0);
  const expectedLengthU32 = 4 + bunDataSizeU32;

  const bunDataSizeU64 =
    sectionData.length >= 8 ? Number(sectionData.readBigUInt64LE(0)) : 0;
  const expectedLengthU64 = 8 + bunDataSizeU64;

  let headerSize: number;
  let bunDataSize: number;

  if (
    sectionData.length >= 8 &&
    expectedLengthU64 <= sectionData.length &&
    expectedLengthU64 >= sectionData.length - 4096
  ) {

    headerSize = 8;
    bunDataSize = bunDataSizeU64;
  } else if (
    expectedLengthU32 <= sectionData.length &&
    expectedLengthU32 >= sectionData.length - 4096
  ) {

    headerSize = 4;
    bunDataSize = bunDataSizeU32;
  } else {
    throw new Error(
      `Cannot determine section header format: sectionData.length=${sectionData.length}, ` +
        `u64 would expect ${expectedLengthU64}, u32 would expect ${expectedLengthU32}`
    );
  }

  const bunDataContent = sectionData.subarray(
    headerSize,
    headerSize + bunDataSize
  );

  const { bunOffsets, bunData, moduleStructSize } =
    parseBunDataBlob(bunDataContent);

  return {
    bunOffsets,
    bunData,
    sectionHeaderSize: headerSize,
    moduleStructSize,
  };
}

function extractBunDataFromELFSection(
  elfBinary: LIEF.ELF.Binary
): BunData | null {
  try {
    const bunSection = elfBinary.getSection('.bun');
    if (!bunSection) return null;

    const sectionContent = bunSection.content;
    if (sectionContent.length < 8) return null;

    const result = extractBunDataFromSection(sectionContent);
    return result;
  } catch {
    return null;
  }
}

function extractBunDataFromELFOverlay(elfBinary: LIEF.ELF.Binary): BunData {
  if (!elfBinary.hasOverlay) {
    throw new Error('ELF binary has no overlay data');
  }

  const overlayData = elfBinary.overlay;

  if (overlayData.length < BUN_TRAILER.length + 8 + SIZEOF_OFFSETS) {
    throw new Error('ELF overlay data is too small');
  }

  const totalByteCount = overlayData.readBigUInt64LE(overlayData.length - 8);

  if (totalByteCount < 4096n || totalByteCount > 2n ** 32n - 1n) {
    throw new Error(`ELF total byte count is out of range: ${totalByteCount}`);
  }

  const trailerStart = overlayData.length - 8 - BUN_TRAILER.length;
  const trailerBytes = overlayData.subarray(
    trailerStart,
    overlayData.length - 8
  );

  if (!trailerBytes.equals(BUN_TRAILER)) {
    throw new Error('BUN trailer bytes do not match trailer');
  }

  const offsetsStart =
    overlayData.length - 8 - BUN_TRAILER.length - SIZEOF_OFFSETS;
  const offsetsBytes = overlayData.subarray(
    offsetsStart,
    overlayData.length - 8 - BUN_TRAILER.length
  );
  const bunOffsets = parseOffsets(offsetsBytes);

  const byteCount =
    typeof bunOffsets.byteCount === 'bigint'
      ? bunOffsets.byteCount
      : BigInt(bunOffsets.byteCount);

  if (byteCount >= totalByteCount) {
    throw new Error('ELF total byte count is out of range');
  }

  const tailDataLen = 8 + BUN_TRAILER.length + SIZEOF_OFFSETS;
  const dataStart = overlayData.length - tailDataLen - Number(byteCount);
  const dataRegion = overlayData.subarray(
    dataStart,
    overlayData.length - tailDataLen
  );

  const bunDataBlob = Buffer.concat([dataRegion, offsetsBytes, trailerBytes]);
  const moduleStructSize = detectModuleStructSize(bunOffsets.modulesPtr.length);

  return {
    bunOffsets,
    bunData: bunDataBlob,
    moduleStructSize,
  };
}

function extractBunDataFromMachO(machoBinary: LIEF.MachO.Binary): BunData {
  const bunSegment = machoBinary.getSegment('__BUN');
  if (!bunSegment) {
    throw new Error('__BUN segment not found');
  }

  const bunSection = bunSegment.getSection('__bun');
  if (!bunSection) {
    throw new Error('__bun section not found');
  }

  return extractBunDataFromSection(bunSection.content);
}

function extractBunDataFromPE(peBinary: LIEF.PE.Binary): BunData {
  const bunSection = peBinary.sections().find(s => s.name === '.bun');

  if (!bunSection) {
    throw new Error('.bun section not found');
  }

  return extractBunDataFromSection(bunSection.content);
}

function getExpectedFormatForPlatform(): 'MachO' | 'ELF' | 'PE' | null {
  switch (process.platform) {
    case 'darwin':
      return 'MachO';
    case 'linux':
      return 'ELF';
    case 'win32':
      return 'PE';
    default:
      return null;
  }
}

function assertPlatformFormat(
  binary: LIEF.ELF.Binary | LIEF.PE.Binary | LIEF.MachO.Binary
): void {
  const expectedFormat = getExpectedFormatForPlatform();
  if (expectedFormat && binary.format !== expectedFormat) {
    throw new Error(
      `Native binary format ${binary.format} does not match ${process.platform} (${expectedFormat})`
    );
  }
}

function locateBundle(
  binary: LIEF.ELF.Binary | LIEF.PE.Binary | LIEF.MachO.Binary,
  binPath: string
): LocatedBundle {
  assertPlatformFormat(binary);

  switch (binary.format) {
    case 'MachO': {
      const machoBinary = binary as LIEF.MachO.Binary;
      const data = extractBunDataFromMachO(machoBinary);
      if (!data.sectionHeaderSize) {
        throw new Error('sectionHeaderSize is required for Mach-O binaries');
      }
      const bunSection = machoBinary.getSegment('__BUN')!.getSection('__bun')!;
      return {
        ...data,
        offset: Number(bunSection.fileOffset),
        length: bunSection.content.length,
        write: (newBunBuffer, outputPath) =>
          repackMachO(
            machoBinary,
            binPath,
            newBunBuffer,
            outputPath,
            data.sectionHeaderSize!
          ),
      };
    }
    case 'PE': {
      const peBinary = binary as LIEF.PE.Binary;
      const data = extractBunDataFromPE(peBinary);
      if (!data.sectionHeaderSize) {
        throw new Error('sectionHeaderSize is required for PE binaries');
      }
      const bunSection = peBinary.sections().find(s => s.name === '.bun')!;
      return {
        ...data,
        offset: Number(bunSection.fileOffset),
        length: bunSection.content.length,
        write: (newBunBuffer, outputPath) =>
          repackPE(
            peBinary,
            binPath,
            newBunBuffer,
            outputPath,
            data.sectionHeaderSize!
          ),
      };
    }
    case 'ELF': {
      const elfBinary = binary as LIEF.ELF.Binary;
      const sectionResult = extractBunDataFromELFSection(elfBinary);
      if (sectionResult) {
        if (!sectionResult.sectionHeaderSize) {
          throw new Error('sectionHeaderSize is required for ELF .bun section');
        }
        return {
          ...sectionResult,
          offset: Number(elfBinary.getSection('.bun')!.fileOffset),
          length: elfBinary.getSection('.bun')!.content.length,
          write: (newBunBuffer, outputPath) =>
            repackELFSection(
              elfBinary,
              binPath,
              newBunBuffer,
              outputPath,
              sectionResult.sectionHeaderSize!
            ),
        };
      }
      const data = extractBunDataFromELFOverlay(elfBinary);
      const stat = fs.statSync(binPath);
      return {
        ...data,
        offset: stat.size - elfBinary.overlay.length,
        length: elfBinary.overlay.length,
        write: (newBunBuffer, outputPath) =>
          repackELFOverlay(elfBinary, binPath, newBunBuffer, outputPath),
      };
    }
    default: {
      const _exhaustive: never = binary;
      throw new Error(
        `Unsupported binary format: ${(_exhaustive as LIEF.ELF.Binary | LIEF.PE.Binary | LIEF.MachO.Binary).format}`
      );
    }
  }
}

function fetchNpmSource(version: string): Buffer | null {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leverframe-claude-'));
  try {
    execFileSync(
      'npm',
      [
        'pack',
        `@anthropic-ai/claude-code@${version}`,
        '--pack-destination',
        tmpDir,
      ],
      { stdio: 'pipe', timeout: 30_000, cwd: tmpDir }
    );

    const files = fs.readdirSync(tmpDir);
    const tgz = files.find(f => f.endsWith('.tgz'));
    if (!tgz) {
      return null;
    }

    execFileSync('tar', ['xzf', path.join(tmpDir, tgz), 'package/cli.js'], {
      stdio: 'pipe',
      timeout: 30_000,
      cwd: tmpDir,
    });

    const cliJsPath = path.join(tmpDir, 'package', 'cli.js');
    if (!fs.existsSync(cliJsPath)) {
      return null;
    }

    const content = fs.readFileSync(cliJsPath);
    return content;
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {

    }
  }
}

export function extractClaudeJsFromNativeInstallation(
  nativeInstallationPath: string,
  version?: string,
  options: NativeExtractionOptions = {},
): { data: Buffer | null; clearBytecode: boolean; error?: string } {
  try {
    LIEF.logging.disable();
    const binary = LIEF.parse(nativeInstallationPath);
    const { bunOffsets, bunData, moduleStructSize } = locateBundle(
      binary,
      nativeInstallationPath
    );

    const jsModules = collectClaudeJavaScriptModules(
      bunData,
      bunOffsets,
      moduleStructSize,
    );
    let result: Buffer | undefined;
    if (jsModules.length === 1) {
      result = jsModules[0]![1];
    } else if (jsModules.length > 1) {
      for (const [name, content] of jsModules) {
        if (content.includes(CLAUDE_MODULE_BOUNDARY)) {
          throw new Error(`Claude module ${name} contains the reserved integration boundary`);
        }
      }
      result = Buffer.from(jsModules.map(([name, content]) =>
        `${CLAUDE_MODULE_BOUNDARY}${name}\n${content.toString('utf8')}`
      ).join(''));
    }

    if (result) {
      const head = result.subarray(0, 64).toString('utf8');

      if (
        head.startsWith(BUN_BYTECODE_PREFIX) &&
        !head.includes(BUN_CJS_MARKER)
      ) {
        if (version && options.allowNetwork !== false) {
          const npmSource = fetchNpmSource(version);
          if (npmSource) {
            return { data: npmSource, clearBytecode: true };
          }
        }
      }

      return { data: result, clearBytecode: false };
    }

    return {
      data: null,
      clearBytecode: false,
      error: 'claude module not found in any of the binary modules',
    };
  } catch (error) {
    return {
      data: null,
      clearBytecode: false,
      error: `extraction threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export function repackNativeInstallation(
  binPath: string,
  modifiedClaudeJs: Buffer,
  outputPath: string,
  clearBytecode: boolean
): void {
  LIEF.logging.disable();
  const binary = LIEF.parse(binPath);

  const bundle = locateBundle(binary, binPath);
  const parts = splitModulePayload(modifiedClaudeJs.toString('utf8'));
  const replacement = parts
    ? buildModuleReplacements(
        parts,
        collectClaudeJavaScriptModules(bundle.bunData, bundle.bunOffsets, bundle.moduleStructSize).map(([name]) => name),
      )
    : modifiedClaudeJs;
  const newBuffer = rebuildBunData(
    bundle.bunData,
    bundle.bunOffsets,
    replacement,
    bundle.moduleStructSize,
    clearBytecode
  );

  bundle.write(newBuffer, outputPath);
}
