import { describe, expect, it } from 'vitest';
import { findUniqueBunCompiledPointer } from '../src/claude-bundle-repack-native.js';

const segmentVirtualAddress = 0x5c882d0n;
const payload = { vaddr: 0x5c8c000n, size: 0x100n };
const pointerVirtualAddress = 0x5c89eb8n;

function writeAddressAt(segment: Buffer, virtualAddress: bigint): void {
  segment.writeBigUInt64LE(payload.vaddr, Number(virtualAddress - segmentVirtualAddress));
}

function repackedSegment(): Buffer {
  const segment = Buffer.alloc(Number(payload.vaddr + payload.size - segmentVirtualAddress));
  writeAddressAt(segment, pointerVirtualAddress);
  writeAddressAt(segment, 0x5c8b5e6n);
  writeAddressAt(segment, payload.vaddr + 0x40n);
  return segment;
}

describe('findUniqueBunCompiledPointer on a repacked Linux binary', () => {
  it('ignores address bytes in stale data and inside the payload', () => {
    expect(findUniqueBunCompiledPointer(repackedSegment(), segmentVirtualAddress, payload))
      .toBe(pointerVirtualAddress);
  });

  it('still rejects two aligned slots outside the payload', () => {
    const segment = repackedSegment();
    writeAddressAt(segment, 0x5c8a000n);

    expect(() => findUniqueBunCompiledPointer(segment, segmentVirtualAddress, payload))
      .toThrow(/multiple BUN_COMPILED locations in writable ELF segment \(0x5c89eb8 and 0x5c8a000\)/);
  });
});
