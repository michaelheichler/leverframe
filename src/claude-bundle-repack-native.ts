import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import LIEF from 'node-lief';

const BLOB_HEADER_ALIGNMENT = 16384;

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
    const bunSection = peBinary.sections().find(s => s.name === '.bun');
    if (!bunSection) {
      throw new Error('.bun section not found');
    }

    const newSectionData = buildSectionData(newBunBuffer, sectionHeaderSize);
    bunSection.content = newSectionData;
    bunSection.virtualSize = BigInt(newSectionData.length);
    bunSection.size = BigInt(newSectionData.length);
    atomicWriteBinary(peBinary, outputPath, binPath, false);
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
