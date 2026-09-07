import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import LIEF from 'node-lief';

function atomicWriteBinary(
  binary: LIEF.ELF.Binary | LIEF.PE.Binary | LIEF.MachO.Binary,
  outputPath: string,
  originalPath: string,
  copyPermissions: boolean = true,
  beforeCommit?: (tempPath: string) => void,
): void {
  const tempPath = outputPath + '.tmp';

  try {
    binary.write(tempPath);

    if (copyPermissions) {
      const origStat = fs.statSync(originalPath);
      fs.chmodSync(tempPath, origStat.mode);
    }

    beforeCommit?.(tempPath);
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

interface PeSecurityDirectory {
  offset: bigint;
  size: bigint;
}

function readPeSecurityDirectory(binPath: string): PeSecurityDirectory | undefined {
  const file = fs.readFileSync(binPath);
  if (file.length < 0x40 || file.readUInt16LE(0) !== 0x5a4d) return undefined;

  const peHeaderOffset = file.readUInt32LE(0x3c);
  if (peHeaderOffset + 24 > file.length || file.readUInt32LE(peHeaderOffset) !== 0x4550) {
    return undefined;
  }

  const optionalHeaderOffset = peHeaderOffset + 24;
  if (optionalHeaderOffset + 2 > file.length) return undefined;
  const magic = file.readUInt16LE(optionalHeaderOffset);
  const dataDirectoryBase = magic === 0x10b ? 96 : magic === 0x20b ? 112 : undefined;
  if (dataDirectoryBase === undefined) return undefined;

  const optionalHeaderSize = file.readUInt16LE(peHeaderOffset + 20);
  const securityDirectoryOffset = optionalHeaderOffset + dataDirectoryBase + 4 * 8;
  if (
    securityDirectoryOffset + 8 > optionalHeaderOffset + optionalHeaderSize ||
    securityDirectoryOffset + 8 > file.length
  ) {
    return undefined;
  }
  const numberOfRvaAndSizesOffset = optionalHeaderOffset + (magic === 0x10b ? 92 : 108);
  if (file.readUInt32LE(numberOfRvaAndSizesOffset) < 5) return undefined;

  const offset = BigInt(file.readUInt32LE(securityDirectoryOffset));
  const size = BigInt(file.readUInt32LE(securityDirectoryOffset + 4));
  if (offset === 0n || size === 0n) return undefined;
  if (offset + size > BigInt(file.length)) {
    throw new Error('PE security directory extends beyond file contents');
  }
  return { offset, size };
}

function rangesOverlap(
  firstStart: bigint,
  firstEnd: bigint,
  secondStart: bigint,
  secondEnd: bigint,
): boolean {
  return firstStart < secondEnd && secondStart < firstEnd;
}

export function repackMachO(
  machoBinary: LIEF.MachO.Binary,
  binPath: string,
  newBunBuffer: Buffer,
  outputPath: string,
  sectionHeaderSize: number
): void {
  try {
    if (machoBinary.hasCodeSignature) {
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
    const sizeDiff = newSectionData.length - Number(bunSection.size);

    if (sizeDiff > 0) {
      const isARM64 =
        machoBinary.header.cpuType === LIEF.MachO.Header.CPU_TYPE.ARM64;
      const pageSize = isARM64 ? 16384 : 4096;
      const alignedSizeDiff = Math.ceil(sizeDiff / pageSize) * pageSize;
      const success = machoBinary.extendSegment(bunSegment, alignedSizeDiff);

      if (!success) {
        throw new Error('Failed to extend __BUN segment');
      }
    }

    bunSection.content = newSectionData;
    bunSection.size = BigInt(newSectionData.length);

    atomicWriteBinary(machoBinary, outputPath, binPath, true, tempPath => {
      execFileSync('codesign', ['-s', '-', '-f', tempPath], {
        stdio: 'ignore',
      });
    });
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
    const sections = peBinary.sections();
    const bunSection = sections.find(s => s.name === '.bun');
    if (!bunSection) {
      throw new Error('.bun section not found');
    }

    const newSectionData = buildSectionData(newBunBuffer, sectionHeaderSize);
    const sectionFileOffset = BigInt(bunSection.fileOffset);
    const nextSectionFileOffset = sections.reduce<bigint | undefined>(
      (next, section) => {
        const fileOffset = BigInt(section.fileOffset);
        if (fileOffset <= sectionFileOffset) return next;
        return next === undefined || fileOffset < next ? fileOffset : next;
      },
      undefined,
    );
    const fileAlignment = peBinary.optionalHeader.fileAlignment;
    if (!Number.isSafeInteger(fileAlignment) || fileAlignment <= 0) {
      throw new Error('PE binary has an invalid file alignment');
    }
    const placement = computePeSectionPlacement({
      sectionFileOffset,
      currentRawSize: BigInt(bunSection.size),
      nextSectionFileOffset,
      newContentSize: BigInt(newSectionData.length),
      fileAlignment: BigInt(fileAlignment),
    });

    if (placement.extensionSize > 0n) {
      const securityDirectory = readPeSecurityDirectory(binPath);
      if (
        securityDirectory &&
        (rangesOverlap(
          sectionFileOffset,
          sectionFileOffset + placement.rawSize,
          securityDirectory.offset,
          securityDirectory.offset + securityDirectory.size,
        ) ||
          (nextSectionFileOffset === undefined &&
            securityDirectory.offset >= sectionFileOffset + BigInt(bunSection.size)))
      ) {
        throw new Error(
          'Cannot safely grow PE .bun section with an existing security directory',
        );
      }
    }

    bunSection.content = newSectionData;
    bunSection.virtualSize = placement.virtualSize;
    bunSection.size = placement.rawSize;
    atomicWriteBinary(peBinary, outputPath, binPath, false);
  } catch (error) {
    console.error('repackPE failed:', error);
    throw error;
  }
}

function alignBigInt(value: bigint, alignment: bigint): bigint {
  return ((value + alignment - 1n) / alignment) * alignment;
}

export interface PeSectionPlacement {
  virtualSize: bigint;
  rawSize: bigint;
  extensionSize: bigint;
}

export function computePeSectionPlacement(params: {
  sectionFileOffset: bigint;
  currentRawSize: bigint;
  nextSectionFileOffset?: bigint;
  newContentSize: bigint;
  fileAlignment: bigint;
}): PeSectionPlacement {
  const {
    sectionFileOffset,
    currentRawSize,
    nextSectionFileOffset,
    newContentSize,
    fileAlignment,
  } = params;

  if (sectionFileOffset < 0n || currentRawSize < 0n || newContentSize < 0n) {
    throw new Error('PE section layout values must be non-negative');
  }
  if (fileAlignment <= 0n) {
    throw new Error('PE binary has an invalid file alignment');
  }
  const rawSize = alignBigInt(
    currentRawSize > newContentSize ? currentRawSize : newContentSize,
    fileAlignment,
  );
  const newRawEnd = sectionFileOffset + rawSize;
  if (nextSectionFileOffset !== undefined && nextSectionFileOffset < sectionFileOffset) {
    throw new Error('PE section layout has an out-of-order next section');
  }
  if (nextSectionFileOffset !== undefined && newRawEnd > nextSectionFileOffset) {
    throw new Error(
      'Cannot safely grow PE .bun section: aligned raw data would overlap the next section',
    );
  }

  return {
    virtualSize: newContentSize,
    rawSize,
    extensionSize: rawSize > currentRawSize ? rawSize - currentRawSize : 0n,
  };
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
  nextVirtualAddress?: bigint;
  newContentSize: bigint;
  pageSize: bigint;
}): BunSectionPlacement {
  const {
    rwVirtualAddress,
    rwVirtualSize,
    rwFileOffset,
    rwFileSize,
    topmostLoadEnd,
    newContentSize,
    pageSize,
  } = params;

  const alignedNewSize = alignBigInt(newContentSize, pageSize);
  const rwMemEnd = rwVirtualAddress + rwVirtualSize;
  const compact = rwMemEnd >= topmostLoadEnd;
  if (!compact) {
    throw new Error(
      'Writable ELF PT_LOAD segment is not topmost; refusing unsafe fallback placement',
    );
  }
  const newVaddr = alignBigInt(rwMemEnd, pageSize);
  const offsetInSegment = newVaddr - rwVirtualAddress;
  const newFileOffset = rwFileOffset + offsetInSegment;
  const oldRwFileEnd = rwFileOffset + rwFileSize;
  const extensionSize = newFileOffset + alignedNewSize - oldRwFileEnd;

  return { newVaddr, newFileOffset, alignedNewSize, extensionSize, compact };
}

export function findUniqueBunCompiledPointer(
  segmentContent: Buffer,
  segmentVirtualAddress: bigint,
  oldBunSectionVaddr: bigint,
): bigint {
  const target = Buffer.alloc(8);
  target.writeBigUInt64LE(oldBunSectionVaddr);

  const firstOffset = segmentContent.indexOf(target);
  if (firstOffset === -1) {
    throw new Error(
      `Could not find original BUN_COMPILED location in binary (searched for 0x${oldBunSectionVaddr.toString(16)})`,
    );
  }

  const secondOffset = segmentContent.indexOf(target, firstOffset + 1);
  if (secondOffset !== -1) {
    const firstAddress = segmentVirtualAddress + BigInt(firstOffset);
    const secondAddress = segmentVirtualAddress + BigInt(secondOffset);
    throw new Error(
      `Found multiple BUN_COMPILED locations in writable ELF segment `
      + `(0x${firstAddress.toString(16)} and 0x${secondAddress.toString(16)})`,
    );
  }

  return segmentVirtualAddress + BigInt(firstOffset);
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

    const rwContent = rwSegment.content;
    const rwVaddrStart = rwSegment.virtualAddress;
    const bunCompiledVaddr = findUniqueBunCompiledPointer(
      rwContent,
      rwVaddrStart,
      oldBunSectionVaddr,
    );

    const pageSize = elfBinary.pageSize();
    const newContentSize = BigInt(newSectionData.length);
    const loadSegments = elfBinary.segments().filter(s => s.type === 'LOAD');
    const rwVirtualAddress = BigInt(rwSegment.virtualAddress);
    if (loadSegments.some(s => BigInt(s.virtualAddress) > rwVirtualAddress)) {
      throw new Error(
        'Writable ELF PT_LOAD segment is not topmost; refusing unsafe in-segment extension',
      );
    }
    const topmostLoadEnd = loadSegments.reduce((max, s) => {
      const end = BigInt(s.virtualAddress) + BigInt(s.virtualSize);
      return end > max ? end : max;
    }, 0n);

    const placement = computeBunSectionPlacement({
      rwVirtualAddress,
      rwVirtualSize: BigInt(rwSegment.virtualSize),
      rwFileOffset: BigInt(rwSegment.fileOffset),
      rwFileSize: BigInt(rwSegment.fileSize),
      topmostLoadEnd,
      newContentSize,
      pageSize: BigInt(pageSize),
    });
    const { newVaddr, newFileOffset, extensionSize } = placement;
    if (extensionSize < 0n) {
      throw new Error(
        'New .bun location overlaps existing writable ELF segment'
      );
    }

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
    atomicWriteBinary(elfBinary, outputPath, binPath);
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

    elfBinary.overlay = newOverlay;
    atomicWriteBinary(elfBinary, outputPath, binPath);
  } catch (error) {
    console.error('repackELFOverlay failed:', error);
    throw error;
  }
}
