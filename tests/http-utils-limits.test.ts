import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import * as zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readBody } from '../src/http-utils.js';

const limit = 1024;
const encoders = [
  ['gzip', zlib.gzipSync],
  ['x-gzip', zlib.gzipSync],
  ['deflate', zlib.deflateSync],
  ['br', zlib.brotliCompressSync],
  ...(typeof zlib.zstdCompressSync === 'function' ? [['zstd', zlib.zstdCompressSync] as const] : []),
] as const;

function request(body: Buffer, encoding: string): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.headers['content-encoding'] = encoding;
  queueMicrotask(() => {
    req.emit('data', body);
    req.emit('end');
  });
  return req;
}

describe('decoded request body limit', () => {
  it.each(encoders)('rejects bounded %s expansion beyond the byte limit', async (encoding, encode) => {
    const body = encode(Buffer.alloc(limit + 1, 'a'));
    expect(body.byteLength).toBeLessThan(limit);
    await expect(readBody(request(body, encoding), limit)).rejects.toThrow();
  });

  it.each(encoders)('accepts %s output exactly at the byte limit', async (encoding, encode) => {
    const text = 'é'.repeat(limit / 2);
    await expect(readBody(request(encode(Buffer.from(text)), encoding), limit)).resolves.toBe(text);
  });

  it('rejects oversized identity input', async () => {
    await expect(readBody(request(Buffer.alloc(limit + 1), 'identity'), limit)).rejects.toThrow('Request body too large');
  });

  it('rejects malformed compressed input', async () => {
    await expect(readBody(request(Buffer.from('not gzip'), 'gzip'), limit)).rejects.toThrow();
  });
});
