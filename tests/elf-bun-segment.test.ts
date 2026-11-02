import { expect, it } from 'vitest';
import { selectBunLoadSegment } from '../src/elf-bun-segment';

const firstWritableLoad = {
  type: 'LOAD',
  flags: 6,
  virtualAddress: 0x70cc770n,
  virtualSize: 55_440n,
};
const bunWritableLoad = {
  type: 'LOAD',
  flags: 6,
  virtualAddress: 0x70da5a8n,
  virtualSize: 181_946_968n,
};
const bunPayload = { vaddr: 0x72db000n, size: 179_845_015n };

it('selects the writable load that contains the complete Bun payload', () => {
  expect(selectBunLoadSegment([firstWritableLoad, bunWritableLoad], bunPayload))
    .toBe(bunWritableLoad);
});

it('ignores readonly loads and writable non-load segments', () => {
  const readonlyLoad = { ...bunWritableLoad, flags: 4 };
  const writableNote = { ...bunWritableLoad, type: 'NOTE' };

  expect(selectBunLoadSegment(
    [firstWritableLoad, readonlyLoad, writableNote, bunWritableLoad],
    bunPayload,
  )).toBe(bunWritableLoad);
});

it('rejects a Bun payload outside every writable load', () => {
  expect(() => selectBunLoadSegment([firstWritableLoad], bunPayload)).toThrow();
});

it('rejects multiple writable loads that contain the Bun payload', () => {
  const overlappingLoad = {
    type: 'LOAD',
    flags: 6,
    virtualAddress: 0x7000000n,
    virtualSize: 0x10000000n,
  };

  expect(() => selectBunLoadSegment(
    [bunWritableLoad, overlappingLoad],
    bunPayload,
  )).toThrow();
});
