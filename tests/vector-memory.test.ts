import { describe, expect, it } from 'vitest';
import { validateVectorMemoryRow, VectorMetadataError } from '../src/context/vector-memory.js';

const digest = (value: string): string => 'lfcd1_' + value.repeat(64).slice(0, 64);
const validRow = (vector: number[]) => ({ version: 1, contentId: digest('a'), vector, workspaceDigest: digest('b'), sessionDigest: digest('c'), role: 'main', timestamp: '2026-08-08T12:00:00.000Z', sourceKind: 'summary', modelRevision: 'model-r1', payloadDigest: digest('d') });

describe('vector memory metadata', () => {
  it('accepts an immutable normalized 1024-dimensional row', () => {
    const row = validateVectorMemoryRow(validRow([1, ...Array.from({ length: 1023 }, () => 0)]));
    expect(row.vector).toHaveLength(1024);
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.vector)).toBe(true);
  });

  it('rejects wrong dimensions, non-finite values, and non-normalized vectors', () => {
    expect(() => validateVectorMemoryRow(validRow([1]))).toThrow(VectorMetadataError);
    expect(() => validateVectorMemoryRow(validRow([Number.NaN, ...Array.from({ length: 1023 }, () => 0)]))).toThrow(VectorMetadataError);
    expect(() => validateVectorMemoryRow(validRow([2, ...Array.from({ length: 1023 }, () => 0)]))).toThrow(VectorMetadataError);
  });

  it('rejects impossible calendar timestamps', () => {
    expect(() => validateVectorMemoryRow({ ...validRow([1, ...Array.from({ length: 1023 }, () => 0)]), timestamp: '2026-02-30T12:00:00.000Z' })).toThrow(VectorMetadataError);
  });
});