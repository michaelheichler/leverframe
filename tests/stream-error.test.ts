import { describe, expect, it } from 'vitest';
import { toUpstreamStreamError } from '../src/stream-error.js';

describe('toUpstreamStreamError', () => {
  it('preserves Error instances', () => {
    const error = new Error('failed');

    expect(toUpstreamStreamError(error)).toBe(error);
  });

  it('preserves structured provider errors', () => {
    const error = { statusCode: 429, message: 'rate limited' };

    expect(toUpstreamStreamError(error)).toBe(error);
  });

  it('wraps primitive failures in an Error', () => {
    const error = toUpstreamStreamError('connection closed');

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('connection closed');
  });
});
