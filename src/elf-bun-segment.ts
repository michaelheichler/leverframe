interface LoadSegment {
  type: string;
  flags: number;
  virtualAddress: bigint;
  virtualSize: bigint;
}

export function selectBunLoadSegment<T extends LoadSegment>(
  segments: readonly T[],
  payload: { vaddr: bigint; size: bigint },
): T {
  const matches = segments.filter(segment => segment.type === 'LOAD'
    && (segment.flags & 2) !== 0
    && payload.vaddr >= segment.virtualAddress
    && payload.vaddr + payload.size <= segment.virtualAddress + segment.virtualSize);
  if (matches.length !== 1) {
    throw new Error(`Expected one writable ELF segment containing the Bun payload, found ${matches.length}`);
  }
  return matches[0]!;
}
