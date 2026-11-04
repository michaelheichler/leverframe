import { expect, it } from 'vitest';
import { computePatchConfigHash } from '../src/patcher.js';

it('changes the patch hash when the visible routing entry is activated', () => {
  const ordinary = { auto: {} };
  const routed = { auto: { routingEnabled: true as const } };

  expect(computePatchConfigHash(ordinary)).not.toBe(computePatchConfigHash(routed));
  expect(computePatchConfigHash(routed)).not.toBe('0024f09e8ae18357ad67bb5c90cce9433adef290590bcb64f81e750a6214468e');
});

it('computes the same patch hash for equivalent active routing configurations', () => {
  const first = { auto: { routingEnabled: true as const } };
  const second = { auto: { routingEnabled: true as const } };

  expect(computePatchConfigHash(first)).toBe(computePatchConfigHash(second));
});
