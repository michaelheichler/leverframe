export const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');
export const BUN_BYTECODE_PREFIX = '// @bun @bytecode';

export const SIZEOF_OFFSETS = 32;
const SIZEOF_STRING_POINTER = 8;

export const SIZEOF_MODULE_OLD = 4 * SIZEOF_STRING_POINTER + 4;
export const SIZEOF_MODULE_NEW = 6 * SIZEOF_STRING_POINTER + 4;

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
    if (modifiedClaudeJs instanceof Buffer && isClaudeModule(moduleName)) {
      const originalContents = getStringPointerContent(bunData, module.contents);
      const originalBytecode = getStringPointerContent(bunData, module.bytecode);
      const sourceChanged = !originalContents.equals(modifiedClaudeJs);
      const invalidateBytecode = clearBytecode || sourceChanged;
      contentsBytes = invalidateBytecode
        ? sourceForInvalidatedBytecode(modifiedClaudeJs)
        : modifiedClaudeJs;
      bytecodeBytes = invalidateBytecode
        ? Buffer.alloc(0)
        : bytecodeForReplacement(originalContents, modifiedClaudeJs, originalBytecode);
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

export {
  computeBunSectionPlacement,
  repackELFOverlay,
  repackELFSection,
  repackMachO,
  repackPE,
  type BunSectionPlacement,
} from './claude-bundle-repack-native.js';
