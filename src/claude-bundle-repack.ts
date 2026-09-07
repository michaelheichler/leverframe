import fs from 'node:fs';
import { execSync } from 'node:child_process';
import LIEF from 'node-lief';

const isDebug = (): boolean => false;
const debug = (..._args: unknown[]): void => {};

export const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');
export const BUN_BYTECODE_PREFIX = '// @bun @bytecode';

export const SIZEOF_OFFSETS = 32;
const SIZEOF_STRING_POINTER = 8;

export const SIZEOF_MODULE_OLD = 4 * SIZEOF_STRING_POINTER + 4;
export const SIZEOF_MODULE_NEW = 6 * SIZEOF_STRING_POINTER + 4;

const BLOB_HEADER_ALIGNMENT = 16384;

export interface StringPointer {
  offset: number;
  length: number;
}

export interface BunOffsets {
  byteCount: bigint | number;
  modulesPtr: StringPointer;
  entryPointId: number;
  compileExecArgvPtr: StringPointer;
  flags: number;
}

export interface BunModule {
  name: StringPointer;
  contents: StringPointer;
  sourcemap: StringPointer;
  bytecode: StringPointer;
  moduleInfo: StringPointer;
  bytecodeOriginPath: StringPointer;
  encoding: number;
  loader: number;
  moduleFormat: number;
  side: number;
}

export interface BunData {
  bunOffsets: BunOffsets;
  bunData: Buffer;

  sectionHeaderSize?: number;

  moduleStructSize: number;
}

export function getStringPointerContent(
  buffer: Buffer,
  stringPointer: StringPointer
): Buffer {
  return buffer.subarray(
    stringPointer.offset,
    stringPointer.offset + stringPointer.length
  );
}

export function parseStringPointer(buffer: Buffer, offset: number): StringPointer {
  return {
    offset: buffer.readUInt32LE(offset),
    length: buffer.readUInt32LE(offset + 4),
  };
}

export function parseCompiledModuleGraphFile(
  buffer: Buffer,
  offset: number,
  moduleStructSize: number
): BunModule {
  let pos = offset;
  const name = parseStringPointer(buffer, pos);
  pos += 8;
  const contents = parseStringPointer(buffer, pos);
  pos += 8;
  const sourcemap = parseStringPointer(buffer, pos);
  pos += 8;
  const bytecode = parseStringPointer(buffer, pos);
  pos += 8;

  let moduleInfo: StringPointer;
  let bytecodeOriginPath: StringPointer;
  if (moduleStructSize === SIZEOF_MODULE_NEW) {
    moduleInfo = parseStringPointer(buffer, pos);
    pos += 8;
    bytecodeOriginPath = parseStringPointer(buffer, pos);
    pos += 8;
  } else {
    moduleInfo = { offset: 0, length: 0 };
    bytecodeOriginPath = { offset: 0, length: 0 };
  }

  const encoding = buffer.readUInt8(pos);
  pos += 1;
  const loader = buffer.readUInt8(pos);
  pos += 1;
  const moduleFormat = buffer.readUInt8(pos);
  pos += 1;
  const side = buffer.readUInt8(pos);

  return {
    name,
    contents,
    sourcemap,
    bytecode,
    moduleInfo,
    bytecodeOriginPath,
    encoding,
    loader,
    moduleFormat,
    side,
  };
}

export function mapModules<T>(
  bunData: Buffer,
  bunOffsets: BunOffsets,
  moduleStructSize: number,
  visitor: (
    module: BunModule,
    moduleName: string,
    index: number
  ) => T | undefined
): T | undefined {
  const modulesListBytes = getStringPointerContent(
    bunData,
    bunOffsets.modulesPtr
  );
  const modulesListCount = Math.floor(
    modulesListBytes.length / moduleStructSize
  );

  for (let i = 0; i < modulesListCount; i++) {
    const offset = i * moduleStructSize;
    const module = parseCompiledModuleGraphFile(
      modulesListBytes,
      offset,
      moduleStructSize
    );
    const moduleName = getStringPointerContent(bunData, module.name).toString(
      'utf-8'
    );

    const result = visitor(module, moduleName, i);
    if (result !== undefined) {
      return result;
    }
  }

  return undefined;
}

export function isClaudeModule(moduleName: string): boolean {
  const normalizedName = moduleName.replaceAll('\\', '/');
  return (
    normalizedName.endsWith('/claude') ||
    normalizedName === 'claude' ||
    normalizedName.endsWith('/claude.exe') ||
    normalizedName === 'claude.exe' ||
    normalizedName.endsWith('/src/entrypoints/cli.js') ||
    normalizedName === 'src/entrypoints/cli.js' ||
    normalizedName === '/$bunfs/root/cli' ||
    normalizedName === 'B:/~BUN/root/cli' ||
    normalizedName === 'cli'
  );
}

export function isChunkModule(moduleName: string): boolean {
  return /(^|[\\/])chunk-[^\\/]+\.js$/.test(moduleName);
}

export function bytecodeForReplacement(original: Buffer, replacement: Buffer, bytecode: Buffer): Buffer {
  return original.equals(replacement) ? bytecode : Buffer.alloc(0);
}

export function sourceForInvalidatedBytecode(source: Buffer): Buffer {
  if (!source.subarray(0, BUN_BYTECODE_PREFIX.length).equals(Buffer.from(BUN_BYTECODE_PREFIX))) {
    return source;
  }
  const newline = source.indexOf(0x0a);
  return newline === -1 ? Buffer.alloc(0) : source.subarray(newline + 1);
}

export function rebuildBunData(
  bunData: Buffer,
  bunOffsets: BunOffsets,
  modifiedClaudeJs: Buffer | Map<string, Buffer> | null,
  moduleStructSize: number,
  clearBytecode: boolean
): Buffer {
  if (modifiedClaudeJs instanceof Map) {
    return rebuildBunDataPreservingLayout(
      bunData,
      bunOffsets,
      modifiedClaudeJs,
      moduleStructSize
    );
  }

  const stringsData: Buffer[] = [];
  const modulesMetadata: Array<{
    name: Buffer;
    contents: Buffer;
    sourcemap: Buffer;
    bytecode: Buffer;
    moduleInfo: Buffer;
    bytecodeOriginPath: Buffer;
    encoding: number;
    loader: number;
    moduleFormat: number;
    side: number;
  }> = [];

  mapModules(bunData, bunOffsets, moduleStructSize, (module, moduleName) => {
    const nameBytes = getStringPointerContent(bunData, module.name);

    let contentsBytes: Buffer;
    let bytecodeBytes: Buffer;
    if (modifiedClaudeJs instanceof Map && modifiedClaudeJs.has(moduleName)) {
      const originalContents = getStringPointerContent(bunData, module.contents);
      contentsBytes = modifiedClaudeJs.get(moduleName)!;
      bytecodeBytes = bytecodeForReplacement(
        originalContents,
        contentsBytes,
        getStringPointerContent(bunData, module.bytecode),
      );
    } else if (modifiedClaudeJs instanceof Buffer && isClaudeModule(moduleName)) {
      contentsBytes = modifiedClaudeJs;
      bytecodeBytes = clearBytecode
        ? Buffer.alloc(0)
        : getStringPointerContent(bunData, module.bytecode);
    } else {
      contentsBytes = getStringPointerContent(bunData, module.contents);
      bytecodeBytes = getStringPointerContent(bunData, module.bytecode);
    }

    const sourcemapBytes = getStringPointerContent(bunData, module.sourcemap);
    const moduleInfoBytes = getStringPointerContent(bunData, module.moduleInfo);
    const bytecodeOriginPathBytes = getStringPointerContent(
      bunData,
      module.bytecodeOriginPath
    );

    modulesMetadata.push({
      name: nameBytes,
      contents: contentsBytes,
      sourcemap: sourcemapBytes,
      bytecode: bytecodeBytes,
      moduleInfo: moduleInfoBytes,
      bytecodeOriginPath: bytecodeOriginPathBytes,
      encoding: module.encoding,
      loader: module.loader,
      moduleFormat: module.moduleFormat,
      side: module.side,
    });

    if (moduleStructSize === SIZEOF_MODULE_NEW) {
      stringsData.push(
        nameBytes,
        contentsBytes,
        sourcemapBytes,
        bytecodeBytes,
        moduleInfoBytes,
        bytecodeOriginPathBytes
      );
    } else {
      stringsData.push(nameBytes, contentsBytes, sourcemapBytes, bytecodeBytes);
    }
    return undefined;
  });

  const stringsPerModule = moduleStructSize === SIZEOF_MODULE_NEW ? 6 : 4;

  let currentOffset = 0;
  const stringOffsets: StringPointer[] = [];

  for (const stringData of stringsData) {
    stringOffsets.push({ offset: currentOffset, length: stringData.length });
    currentOffset += stringData.length + 1;
  }

  const modulesListOffset = currentOffset;
  const modulesListSize = modulesMetadata.length * moduleStructSize;
  currentOffset += modulesListSize;

  const compileExecArgvBytes = getStringPointerContent(
    bunData,
    bunOffsets.compileExecArgvPtr
  );
  const compileExecArgvOffset = currentOffset;
  const compileExecArgvLength = compileExecArgvBytes.length;
  currentOffset += compileExecArgvLength + 1;

  const offsetsOffset = currentOffset;
  currentOffset += SIZEOF_OFFSETS;

  const trailerOffset = currentOffset;
  currentOffset += BUN_TRAILER.length;

  const newBuffer = Buffer.allocUnsafe(currentOffset);
  newBuffer.fill(0);

  let stringIdx = 0;
  for (const { offset, length } of stringOffsets) {
    if (length > 0) {
      stringsData[stringIdx].copy(newBuffer, offset, 0, length);
    }
    newBuffer[offset + length] = 0;
    stringIdx++;
  }

  if (compileExecArgvLength > 0) {
    compileExecArgvBytes.copy(
      newBuffer,
      compileExecArgvOffset,
      0,
      compileExecArgvLength
    );
    newBuffer[compileExecArgvOffset + compileExecArgvLength] = 0;
  }

  for (let i = 0; i < modulesMetadata.length; i++) {
    const metadata = modulesMetadata[i];
    const baseStringIdx = i * stringsPerModule;

    const moduleStruct: BunModule = {
      name: stringOffsets[baseStringIdx],
      contents: stringOffsets[baseStringIdx + 1],
      sourcemap: stringOffsets[baseStringIdx + 2],
      bytecode: stringOffsets[baseStringIdx + 3],
      moduleInfo:
        moduleStructSize === SIZEOF_MODULE_NEW
          ? stringOffsets[baseStringIdx + 4]
          : { offset: 0, length: 0 },
      bytecodeOriginPath:
        moduleStructSize === SIZEOF_MODULE_NEW
          ? stringOffsets[baseStringIdx + 5]
          : { offset: 0, length: 0 },
      encoding: metadata.encoding,
      loader: metadata.loader,
      moduleFormat: metadata.moduleFormat,
      side: metadata.side,
    };

    const moduleOffset = modulesListOffset + i * moduleStructSize;
    let pos = moduleOffset;

    newBuffer.writeUInt32LE(moduleStruct.name.offset, pos);
    newBuffer.writeUInt32LE(moduleStruct.name.length, pos + 4);
    pos += 8;
    newBuffer.writeUInt32LE(moduleStruct.contents.offset, pos);
    newBuffer.writeUInt32LE(moduleStruct.contents.length, pos + 4);
    pos += 8;
    newBuffer.writeUInt32LE(moduleStruct.sourcemap.offset, pos);
    newBuffer.writeUInt32LE(moduleStruct.sourcemap.length, pos + 4);
    pos += 8;
    newBuffer.writeUInt32LE(moduleStruct.bytecode.offset, pos);
    newBuffer.writeUInt32LE(moduleStruct.bytecode.length, pos + 4);
    pos += 8;

    if (moduleStructSize === SIZEOF_MODULE_NEW) {
      newBuffer.writeUInt32LE(moduleStruct.moduleInfo.offset, pos);
      newBuffer.writeUInt32LE(moduleStruct.moduleInfo.length, pos + 4);
      pos += 8;
      newBuffer.writeUInt32LE(moduleStruct.bytecodeOriginPath.offset, pos);
      newBuffer.writeUInt32LE(moduleStruct.bytecodeOriginPath.length, pos + 4);
      pos += 8;
    }

    newBuffer.writeUInt8(moduleStruct.encoding, pos);
    newBuffer.writeUInt8(moduleStruct.loader, pos + 1);
    newBuffer.writeUInt8(moduleStruct.moduleFormat, pos + 2);
    newBuffer.writeUInt8(moduleStruct.side, pos + 3);
  }

  const newOffsets: BunOffsets = {
    byteCount: offsetsOffset,
    modulesPtr: {
      offset: modulesListOffset,
      length: modulesListSize,
    },
    entryPointId: bunOffsets.entryPointId,
    compileExecArgvPtr: {
      offset: compileExecArgvOffset,
      length: compileExecArgvLength,
    },
    flags: bunOffsets.flags,
  };

  let offsetsPos = offsetsOffset;
  const byteCount =
    typeof newOffsets.byteCount === 'bigint'
      ? newOffsets.byteCount
      : BigInt(newOffsets.byteCount);
  newBuffer.writeBigUInt64LE(byteCount, offsetsPos);
  offsetsPos += 8;
  newBuffer.writeUInt32LE(newOffsets.modulesPtr.offset, offsetsPos);
  newBuffer.writeUInt32LE(newOffsets.modulesPtr.length, offsetsPos + 4);
  offsetsPos += 8;
  newBuffer.writeUInt32LE(newOffsets.entryPointId, offsetsPos);
  offsetsPos += 4;
  newBuffer.writeUInt32LE(newOffsets.compileExecArgvPtr.offset, offsetsPos);
  newBuffer.writeUInt32LE(newOffsets.compileExecArgvPtr.length, offsetsPos + 4);
  offsetsPos += 8;
  newBuffer.writeUInt32LE(newOffsets.flags, offsetsPos);

  BUN_TRAILER.copy(newBuffer, trailerOffset);

  return newBuffer;
}

function rebuildBunDataPreservingLayout(
  bunData: Buffer,
  bunOffsets: BunOffsets,
  replacements: Map<string, Buffer>,
  moduleStructSize: number
): Buffer {
  const originalDataLength = Number(bunOffsets.byteCount);
  const modulesTableOffset = bunOffsets.modulesPtr.offset;
  const modulesTableLength = bunOffsets.modulesPtr.length;
  const selected: Array<{ index: number; original: Buffer; replacement: Buffer }> = [];

  mapModules(bunData, bunOffsets, moduleStructSize, (module, name, index) => {
    const replacement = replacements.get(name);
    if (replacement) selected.push({
      index,
      original: getStringPointerContent(bunData, module.contents),
      replacement,
    });
    return undefined;
  });

  if (!selected.some(item => !item.replacement.equals(item.original))) return bunData;

  const changed = selected.map(({ index, replacement }) => ({
    index,
    contents: sourceForInvalidatedBytecode(replacement),
  }));

  const appendedContentsLength = changed.reduce(
    (total, item) => total + item.contents.length + 1,
    0
  );
  const newOffsetsOffset = originalDataLength + appendedContentsLength;
  const newBuffer = Buffer.alloc(
    newOffsetsOffset + SIZEOF_OFFSETS + BUN_TRAILER.length
  );

  bunData.copy(newBuffer, 0, 0, originalDataLength);
  let contentsOffset = originalDataLength;
  for (const { index, contents } of changed) {
    contents.copy(newBuffer, contentsOffset);
    newBuffer[contentsOffset + contents.length] = 0;

    const moduleOffset = modulesTableOffset + index * moduleStructSize;
    newBuffer.writeUInt32LE(contentsOffset, moduleOffset + 8);
    newBuffer.writeUInt32LE(contents.length, moduleOffset + 12);
    newBuffer.writeUInt32LE(0, moduleOffset + 24);
    newBuffer.writeUInt32LE(0, moduleOffset + 28);
    if (moduleStructSize === SIZEOF_MODULE_NEW) {
      newBuffer.writeUInt32LE(0, moduleOffset + 32);
      newBuffer.writeUInt32LE(0, moduleOffset + 36);
      newBuffer.writeUInt32LE(0, moduleOffset + 40);
      newBuffer.writeUInt32LE(0, moduleOffset + 44);
    }
    contentsOffset += contents.length + 1;
  }

  let offsetsPos = newOffsetsOffset;
  newBuffer.writeBigUInt64LE(BigInt(newOffsetsOffset), offsetsPos);
  offsetsPos += 8;
  newBuffer.writeUInt32LE(modulesTableOffset, offsetsPos);
  newBuffer.writeUInt32LE(modulesTableLength, offsetsPos + 4);
  offsetsPos += 8;
  newBuffer.writeUInt32LE(bunOffsets.entryPointId, offsetsPos);
  offsetsPos += 4;
  newBuffer.writeUInt32LE(bunOffsets.compileExecArgvPtr.offset, offsetsPos);
  newBuffer.writeUInt32LE(bunOffsets.compileExecArgvPtr.length, offsetsPos + 4);
  offsetsPos += 8;
  newBuffer.writeUInt32LE(bunOffsets.flags, offsetsPos);
  BUN_TRAILER.copy(newBuffer, newOffsetsOffset + SIZEOF_OFFSETS);

  return newBuffer;
}

function atomicWriteBinary(
  binary: LIEF.ELF.Binary | LIEF.PE.Binary | LIEF.MachO.Binary,
  outputPath: string,
  originalPath: string,
  copyPermissions: boolean = true
): void {
  const tempPath = outputPath + '.tmp';
  binary.write(tempPath);

  if (copyPermissions) {
    const origStat = fs.statSync(originalPath);
    fs.chmodSync(tempPath, origStat.mode);
  }

  try {
    fs.renameSync(tempPath, outputPath);
  } catch (error) {

    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {

    }

    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ETXTBSY' ||
        error.code === 'EBUSY' ||
        error.code === 'EPERM')
    ) {
      throw new Error(
        'Cannot update the Claude executable while it is running.\n' +
          'Please close all Claude instances and try again.'
      );
    }

    throw error;
  }
}

function buildSectionData(bunBuffer: Buffer, headerSize: number = 8): Buffer {
  const sectionData = Buffer.allocUnsafe(headerSize + bunBuffer.length);
  if (headerSize === 8) {
    sectionData.writeBigUInt64LE(BigInt(bunBuffer.length), 0);
  } else {
    sectionData.writeUInt32LE(bunBuffer.length, 0);
  }
  bunBuffer.copy(sectionData, headerSize);
  return sectionData;
}

export function repackMachO(
  machoBinary: LIEF.MachO.Binary,
  binPath: string,
  newBunBuffer: Buffer,
  outputPath: string,
  sectionHeaderSize: number
): void {
  try {

    debug(`repackMachO: Has code signature: ${machoBinary.hasCodeSignature}`);
    if (machoBinary.hasCodeSignature) {
      debug('repackMachO: Removing code signature...');
      machoBinary.removeSignature();
    }

    const bunSegment = machoBinary.getSegment('__BUN');
    if (!bunSegment) {
      throw new Error('__BUN segment not found');
    }

    const bunSection = bunSegment.getSection('__bun');
    if (!bunSection) {
      throw new Error('__bun section not found');
    }

    const newSectionData = buildSectionData(newBunBuffer, sectionHeaderSize);

    debug(`repackMachO: Original section size: ${bunSection.size}`);
    debug(`repackMachO: Original segment fileSize: ${bunSegment.fileSize}`);
    debug(
      `repackMachO: Original segment virtualSize: ${bunSegment.virtualSize}`
    );
    debug(`repackMachO: New data size: ${newSectionData.length}`);
    debug(`repackMachO: Using header size: ${sectionHeaderSize}`);

    const sizeDiff = newSectionData.length - Number(bunSection.size);

    if (sizeDiff > 0) {

      const isARM64 =
        machoBinary.header.cpuType === LIEF.MachO.Header.CPU_TYPE.ARM64;
      const PAGE_SIZE = isARM64 ? 16384 : 4096;
      const alignedSizeDiff = Math.ceil(sizeDiff / PAGE_SIZE) * PAGE_SIZE;

      debug(`repackMachO: CPU type: ${isARM64 ? 'ARM64' : 'x86_64'}`);
      debug(`repackMachO: Page size: ${PAGE_SIZE} bytes`);
      debug(`repackMachO: Need to expand by ${sizeDiff} bytes`);
      debug(
        `repackMachO: Rounding up to page-aligned: ${alignedSizeDiff} bytes`
      );

      const success = machoBinary.extendSegment(bunSegment, alignedSizeDiff);
      debug(`repackMachO: extendSegment returned: ${success}`);

      if (!success) {
        throw new Error('Failed to extend __BUN segment');
      }

      debug(`repackMachO: Section size after extend: ${bunSection.size}`);
      debug(
        `repackMachO: Segment fileSize after extend: ${bunSegment.fileSize}`
      );
      debug(
        `repackMachO: Segment virtualSize after extend: ${bunSegment.virtualSize}`
      );
    }

    bunSection.content = newSectionData;
    bunSection.size = BigInt(newSectionData.length);

    debug(`repackMachO: Final section size: ${bunSection.size}`);
    debug(`repackMachO: Writing modified binary to ${outputPath}...`);

    atomicWriteBinary(machoBinary, outputPath, binPath);

    try {
      debug(`repackMachO: Re-signing binary with ad-hoc signature...`);
      execSync(`codesign -s - -f "${outputPath}"`, {
        stdio: isDebug() ? 'inherit' : 'ignore',
      });
      debug('repackMachO: Code signing completed successfully');
    } catch (codesignError) {
      console.warn(
        'Warning: Failed to re-sign binary. The binary may not run correctly on macOS:',
        codesignError
      );
    }

    debug('repackMachO: Write completed successfully');
  } catch (error) {
    console.error('repackMachO failed:', error);
    throw error;
  }
}

export function repackPE(
  peBinary: LIEF.PE.Binary,
  binPath: string,
  newBunBuffer: Buffer,
  outputPath: string,
  sectionHeaderSize: number
): void {
  try {
    const bunSection = peBinary.sections().find(s => s.name === '.bun');
    if (!bunSection) {
      throw new Error('.bun section not found');
    }

    const newSectionData = buildSectionData(newBunBuffer, sectionHeaderSize);

    debug(
      `repackPE: Original section size: ${bunSection.size}, virtual size: ${bunSection.virtualSize}`
    );
    debug(`repackPE: New data size: ${newSectionData.length}`);
    debug(`repackPE: Using header size: ${sectionHeaderSize}`);

    bunSection.content = newSectionData;

    bunSection.virtualSize = BigInt(newSectionData.length);
    bunSection.size = BigInt(newSectionData.length);

    debug(`repackPE: Writing modified binary to ${outputPath}...`);
    atomicWriteBinary(peBinary, outputPath, binPath, false);
    debug('repackPE: Write completed successfully');
  } catch (error) {
    console.error('repackPE failed:', error);
    throw error;
  }
}

function alignBigInt(value: bigint, alignment: bigint): bigint {
  return ((value + alignment - 1n) / alignment) * alignment;
}

export interface BunSectionPlacement {
  newVaddr: bigint;
  newFileOffset: bigint;
  alignedNewSize: bigint;
  extensionSize: bigint;

  compact: boolean;
}

export function computeBunSectionPlacement(params: {
  rwVirtualAddress: bigint;
  rwVirtualSize: bigint;
  rwFileOffset: bigint;
  rwFileSize: bigint;
  topmostLoadEnd: bigint;
  nextVirtualAddress: bigint;
  newContentSize: bigint;
  pageSize: bigint;
}): BunSectionPlacement {
  const {
    rwVirtualAddress,
    rwVirtualSize,
    rwFileOffset,
    rwFileSize,
    topmostLoadEnd,
    nextVirtualAddress,
    newContentSize,
    pageSize,
  } = params;

  const alignedNewSize = alignBigInt(newContentSize, pageSize);
  const rwMemEnd = rwVirtualAddress + rwVirtualSize;
  const compact = rwMemEnd >= topmostLoadEnd;
  const newVaddr = compact
    ? alignBigInt(rwMemEnd, pageSize)
    : alignBigInt(nextVirtualAddress, pageSize);

  const offsetInSegment = newVaddr - rwVirtualAddress;
  const newFileOffset = rwFileOffset + offsetInSegment;
  const oldRwFileEnd = rwFileOffset + rwFileSize;
  const extensionSize = newFileOffset + alignedNewSize - oldRwFileEnd;

  return { newVaddr, newFileOffset, alignedNewSize, extensionSize, compact };
}

export function repackELFSection(
  elfBinary: LIEF.ELF.Binary,
  binPath: string,
  newBunBuffer: Buffer,
  outputPath: string,
  sectionHeaderSize: number
): void {
  try {
    const bunSection = elfBinary.getSection('.bun');
    if (!bunSection) {
      throw new Error('.bun section not found');
    }

    const rwSegment = elfBinary
      .segments()
      .find(s => s.type === 'LOAD' && (s.flags & 2) !== 0);
    if (!rwSegment) {
      throw new Error('No writable ELF PT_LOAD segment found');
    }

    const newSectionData = buildSectionData(newBunBuffer, sectionHeaderSize);
    const oldBunSectionVaddr = bunSection.virtualAddress;
    const vaddrBytes = Buffer.alloc(8);
    vaddrBytes.writeBigUInt64LE(oldBunSectionVaddr);

    let bunCompiledVaddr: bigint | null = null;
    const rwContent = rwSegment.content;
    const rwVaddrStart = rwSegment.virtualAddress;
    const firstAligned = alignBigInt(
      rwVaddrStart,
      BigInt(BLOB_HEADER_ALIGNMENT)
    );
    const lastCandidate = rwVaddrStart + BigInt(rwContent.length) - 8n;

    for (
      let va = firstAligned;
      va <= lastCandidate;
      va += BigInt(BLOB_HEADER_ALIGNMENT)
    ) {
      const off = Number(va - rwVaddrStart);
      if (rwContent.subarray(off, off + 8).equals(vaddrBytes)) {
        bunCompiledVaddr = va;
        break;
      }
    }

    if (bunCompiledVaddr === null) {
      throw new Error(
        `Could not find original BUN_COMPILED location in binary (searched for 0x${oldBunSectionVaddr.toString(16)})`
      );
    }

    const pageSize = elfBinary.pageSize();
    const newContentSize = BigInt(newSectionData.length);

    const loadSegments = elfBinary.segments().filter(s => s.type === 'LOAD');
    const topmostLoadEnd = loadSegments.reduce((max, s) => {
      const end = BigInt(s.virtualAddress) + BigInt(s.virtualSize);
      return end > max ? end : max;
    }, 0n);

    const placement = computeBunSectionPlacement({
      rwVirtualAddress: BigInt(rwSegment.virtualAddress),
      rwVirtualSize: BigInt(rwSegment.virtualSize),
      rwFileOffset: BigInt(rwSegment.fileOffset),
      rwFileSize: BigInt(rwSegment.fileSize),
      topmostLoadEnd,
      nextVirtualAddress: BigInt(elfBinary.nextVirtualAddress()),
      newContentSize,
      pageSize: BigInt(pageSize),
    });
    const { newVaddr, newFileOffset, extensionSize, compact } = placement;
    debug(
      `repackELFSection: ${compact ? 'compact' : 'fallback'} placement ` +
        `(topmost LOAD ends at 0x${topmostLoadEnd.toString(16)})`
    );

    if (extensionSize < 0n) {
      throw new Error(
        'New .bun location overlaps existing writable ELF segment'
      );
    }

    debug(
      `repackELFSection: moving .bun to offset=0x${newFileOffset.toString(16)}, vaddr=0x${newVaddr.toString(16)}, size=0x${newContentSize.toString(16)}`
    );

    if (extensionSize > 0n) {
      const extendedSegment = elfBinary.extend(rwSegment, extensionSize);
      if (!extendedSegment) {
        throw new Error('Failed to extend writable ELF PT_LOAD segment');
      }
    }

    bunSection.fileOffset = newFileOffset;
    bunSection.virtualAddress = newVaddr;
    bunSection.content = newSectionData;
    bunSection.size = newContentSize;

    const vaddrPatch = Buffer.alloc(8);
    vaddrPatch.writeBigUInt64LE(newVaddr);
    elfBinary.patchAddress(bunCompiledVaddr, vaddrPatch);

    debug(
      `repackELFSection: Patched BUN_COMPILED at vaddr 0x${bunCompiledVaddr.toString(16)} -> 0x${newVaddr.toString(16)}`
    );

    atomicWriteBinary(elfBinary, outputPath, binPath);
    debug('repackELFSection: Write completed successfully');
  } catch (error) {
    console.error('repackELFSection failed:', error);
    throw error;
  }
}

export function repackELFOverlay(
  elfBinary: LIEF.ELF.Binary,
  binPath: string,
  newBunBuffer: Buffer,
  outputPath: string
): void {
  try {

    const newOverlay = Buffer.allocUnsafe(newBunBuffer.length + 8);
    newBunBuffer.copy(newOverlay, 0);
    newOverlay.writeBigUInt64LE(
      BigInt(newBunBuffer.length),
      newBunBuffer.length
    );

    debug(
      `repackELFOverlay: Setting overlay data (${newOverlay.length} bytes)`
    );

    elfBinary.overlay = newOverlay;
    debug(`repackELFOverlay: Writing modified binary to ${outputPath}...`);

    atomicWriteBinary(elfBinary, outputPath, binPath);
    debug('repackELFOverlay: Write completed successfully');
  } catch (error) {
    console.error('repackELFOverlay failed:', error);
    throw error;
  }
}
