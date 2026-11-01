import { expect, it } from 'vitest';
import { parseUsdMicros } from '../src/account-management-prompts.js';

it.each([
  { value: '0', expected: 0 },
  { value: '0.000001', expected: 1 },
  { value: '1.234567', expected: 1_234_567 },
  { value: '9007199254.740991', expected: Number.MAX_SAFE_INTEGER },
])('converts $value USD to exact integer micros', ({ value, expected }) => {
  expect(parseUsdMicros(value)).toBe(expected);
});

it.each([
  '', 'not-a-price', '-0.000001', '1.0000001', '9007199254.740992',
])('rejects invalid, negative, over-precise, or overflowing USD input', value => {
  expect(parseUsdMicros(value)).toBeUndefined();
});
