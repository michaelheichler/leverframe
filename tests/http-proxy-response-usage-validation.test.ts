import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

const zlibMocks = vi.hoisted(() => ({
  createGunzip: vi.fn(),
  createBrotliDecompress: vi.fn(),
  createInflate: vi.fn(),
}));

vi.mock('node:zlib', async () => ({
  ...(await vi.importActual<typeof import('node:zlib')>('node:zlib')),
  ...zlibMocks,
}));

import { observeResponseUsage } from '../src/http-proxy/response-usage.js';

describe('response usage decoder validation', () => {
  it('validates every content encoding before creating any decoder', () => {
    const onComplete = vi.fn();

    observeResponseUsage(
      Readable.from([]) as unknown as import('node:http').IncomingMessage,
      'gzip, zstd',
      { onUsage: vi.fn(), onComplete },
    );

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(zlibMocks.createGunzip).not.toHaveBeenCalled();
    expect(zlibMocks.createBrotliDecompress).not.toHaveBeenCalled();
    expect(zlibMocks.createInflate).not.toHaveBeenCalled();
  });
});
