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
export {
  bytecodeForReplacement,
  computeBunSectionPlacement,
  sourceForInvalidatedBytecode,
  type BunSectionPlacement,
} from './claude-bundle-repack.js';

const debug = (..._args: unknown[]): void => {};

const NIX_WRAPPER_MAX_SIZE = 200_000;

export function resolveNixBinaryWrapper(binaryPath: string): string | null {
  try {

    const stat = fs.statSync(binaryPath);
    if (stat.size > NIX_WRAPPER_MAX_SIZE) {
      return null;
    }

    LIEF.logging.disable();
    const binary = LIEF.parse(binaryPath);

    const symbols = binary.symbols();
    const hasExecv = symbols.some(sym => {
      const name = sym.name;
      return name === 'execv' || name === '_execv';
    });

    if (!hasExecv) {
      debug(
        'resolveNixBinaryWrapper: no execv import found, not a Nix wrapper'
      );
      return null;
    }

    debug(
      'resolveNixBinaryWrapper: execv import found, checking for Nix wrapper DOCSTRING'
    );

    let rawBytes: Buffer | null = null;

    if (binary.format === 'ELF') {
      const rodata = binary.sections().find(s => s.name === '.rodata');
      if (rodata) {
        rawBytes = rodata.content;
      }
    } else if (binary.format === 'MachO') {
      const machoBinary = binary as LIEF.MachO.Binary;
      const textSeg = machoBinary.getSegment('__TEXT');
      if (textSeg) {
        const cstring = textSeg.getSection('__cstring');
        if (cstring) {
          rawBytes = cstring.content;
        }
      }
    }

    if (!rawBytes || rawBytes.length === 0) {
      debug('resolveNixBinaryWrapper: could not read string section');
      return null;
    }

    const text = rawBytes.toString('utf-8');

    const docstringMatch = text.match(/makeCWrapper\s+'(\/nix\/store\/[^']+)'/);
    if (docstringMatch) {
      const resolvedPath = docstringMatch[1];
      debug(
        `resolveNixBinaryWrapper: found wrapped executable via DOCSTRING: ${resolvedPath}`
      );
      return resolvedPath;
    }

    const unquotedMatch = text.match(/makeCWrapper\s+(\/nix\/store\/\S+)/);
    if (unquotedMatch) {
      const resolvedPath = unquotedMatch[1];
      debug(
        `resolveNixBinaryWrapper: found wrapped executable via unquoted DOCSTRING: ${resolvedPath}`
      );
      return resolvedPath;
    }

    const nixPaths = text.match(/\/nix\/store\/[^\s]+/g);
    if (nixPaths) {
      for (const p of nixPaths) {
        if (p.includes('/bin/')) {
          debug(
            `resolveNixBinaryWrapper: found wrapped executable via /bin/ heuristic: ${p}`
          );
          return p;
        }
      }
    }

    debug('resolveNixBinaryWrapper: has execv but no Nix store paths found');
    return null;
  } catch (error) {
    debug('resolveNixBinaryWrapper: error during detection:', error);
    return null;
  }
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
  if (fitsNew && fitsOld) {

    debug(
      `detectModuleStructSize: Ambiguous module list length ${modulesListLength}, assuming new format`
    );
    return SIZEOF_MODULE_NEW;
  }

  debug(
    `detectModuleStructSize: Module list length ${modulesListLength} doesn't cleanly divide by either struct size, assuming new format`
  );
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

  debug(`parseBunDataBlob: Expected trailer: ${BUN_TRAILER.toString('hex')}`);
  debug(`parseBunDataBlob: Got trailer: ${trailerBytes.toString('hex')}`);

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

  debug(`extractBunDataFromSection: sectionData.length=${sectionData.length}`);

  const bunDataSizeU32 = sectionData.readUInt32LE(0);
  const expectedLengthU32 = 4 + bunDataSizeU32;

  const bunDataSizeU64 =
    sectionData.length >= 8 ? Number(sectionData.readBigUInt64LE(0)) : 0;
  const expectedLengthU64 = 8 + bunDataSizeU64;

  debug(
    `extractBunDataFromSection: u32 header would give size=${bunDataSizeU32}, expected total=${expectedLengthU32}`
  );
  debug(
    `extractBunDataFromSection: u64 header would give size=${bunDataSizeU64}, expected total=${expectedLengthU64}`
  );

  let headerSize: number;
  let bunDataSize: number;

  if (
    sectionData.length >= 8 &&
    expectedLengthU64 <= sectionData.length &&
    expectedLengthU64 >= sectionData.length - 4096
  ) {

    headerSize = 8;
    bunDataSize = bunDataSizeU64;
    debug(
      `extractBunDataFromSection: detected u64 header format (Bun >= 1.3.4)`
    );
  } else if (
    expectedLengthU32 <= sectionData.length &&
    expectedLengthU32 >= sectionData.length - 4096
  ) {

    headerSize = 4;
    bunDataSize = bunDataSizeU32;
    debug(
      `extractBunDataFromSection: detected u32 header format (Bun < 1.3.4)`
    );
  } else {
    throw new Error(
      `Cannot determine section header format: sectionData.length=${sectionData.length}, ` +
        `u64 would expect ${expectedLengthU64}, u32 would expect ${expectedLengthU32}`
    );
  }

  debug(`extractBunDataFromSection: bunDataSize from header=${bunDataSize}`);

  const bunDataContent = sectionData.subarray(
    headerSize,
    headerSize + bunDataSize
  );

  debug(
    `extractBunDataFromSection: bunDataContent.length=${bunDataContent.length}`
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
    if (!bunSection) {
      debug('extractBunDataFromELFSection: .bun section not found');
      return null;
    }

    const sectionContent = bunSection.content;
    if (sectionContent.length < 8) {
      debug('extractBunDataFromELFSection: .bun section too small');
      return null;
    }

    debug(
      `extractBunDataFromELFSection: .bun section found, size=${sectionContent.length}`
    );

    const result = extractBunDataFromSection(sectionContent);
    debug('extractBunDataFromELFSection: successfully extracted data');
    return result;
  } catch (error) {
    debug('extractBunDataFromELFSection: failed to extract:', error);
    return null;
  }
}

function extractBunDataFromELFOverlay(elfBinary: LIEF.ELF.Binary): BunData {
  if (!elfBinary.hasOverlay) {
    throw new Error('ELF binary has no overlay data');
  }

  const overlayData = elfBinary.overlay;
  debug(
    `extractBunDataFromELFOverlay: Overlay size=${overlayData.length} bytes`
  );

  if (overlayData.length < BUN_TRAILER.length + 8 + SIZEOF_OFFSETS) {
    throw new Error('ELF overlay data is too small');
  }

  const totalByteCount = overlayData.readBigUInt64LE(overlayData.length - 8);
  debug(
    `extractBunDataFromELFOverlay: Total byte count from tail=${totalByteCount}`
  );

  if (totalByteCount < 4096n || totalByteCount > 2n ** 32n - 1n) {
    throw new Error(`ELF total byte count is out of range: ${totalByteCount}`);
  }

  const trailerStart = overlayData.length - 8 - BUN_TRAILER.length;
  const trailerBytes = overlayData.subarray(
    trailerStart,
    overlayData.length - 8
  );

  debug(
    `extractBunDataFromELFOverlay: Expected trailer: ${BUN_TRAILER.toString('hex')}`
  );
  debug(
    `extractBunDataFromELFOverlay: Got trailer: ${trailerBytes.toString('hex')}`
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

  debug(
    `extractBunDataFromELFOverlay: Offsets.byteCount=${bunOffsets.byteCount}`
  );

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

  debug(
    `extractBunDataFromELFOverlay: Extracted ${dataRegion.length} bytes of data`
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
  debug(`locateBundle: Binary format detected as ${binary.format}`);
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
        debug('locateBundle: Using new ELF .bun section format');
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
      debug('locateBundle: Falling back to legacy ELF overlay format');
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
    debug(`fetchNpmSource: Downloading @anthropic-ai/claude-code@${version}`);
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
      debug('fetchNpmSource: No .tgz file found after npm pack');
      return null;
    }

    execFileSync('tar', ['xzf', path.join(tmpDir, tgz), 'package/cli.js'], {
      stdio: 'pipe',
      timeout: 30_000,
      cwd: tmpDir,
    });

    const cliJsPath = path.join(tmpDir, 'package', 'cli.js');
    if (!fs.existsSync(cliJsPath)) {
      debug('fetchNpmSource: cli.js not found in extracted package');
      return null;
    }

    const content = fs.readFileSync(cliJsPath);
    debug(`fetchNpmSource: Got cli.js, ${content.length} bytes`);
    return content;
  } catch (error) {
    debug('fetchNpmSource: Failed to fetch npm source:', error);
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
  version?: string
): { data: Buffer | null; clearBytecode: boolean; error?: string } {
  try {
    LIEF.logging.disable();
    const binary = LIEF.parse(nativeInstallationPath);
    const { bunOffsets, bunData, moduleStructSize } = locateBundle(
      binary,
      nativeInstallationPath
    );

    debug(
      `extractClaudeJsFromNativeInstallation: Got bunData, size=${bunData.length} bytes, moduleStructSize=${moduleStructSize}`
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
        debug(
          'extractClaudeJsFromNativeInstallation: Extracted content is Bun bytecode — falling back to npm source'
        );

        if (version) {
          const npmSource = fetchNpmSource(version);
          if (npmSource) {
            debug(
              `extractClaudeJsFromNativeInstallation: Using npm source (${npmSource.length} bytes) instead of bytecode`
            );
            return { data: npmSource, clearBytecode: true };
          }
          debug(
            'extractClaudeJsFromNativeInstallation: npm source fetch failed, returning bytecode content as-is'
          );
        } else {
          debug(
            'extractClaudeJsFromNativeInstallation: No version provided, cannot fetch npm source'
          );
        }
      }

      return { data: result, clearBytecode: false };
    }

    debug(
      'extractClaudeJsFromNativeInstallation: claude module not found in any module'
    );

    return {
      data: null,
      clearBytecode: false,
      error: 'claude module not found in any of the binary modules',
    };
  } catch (error) {
    debug(
      'extractClaudeJsFromNativeInstallation: Error during extraction:',
      error
    );

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
