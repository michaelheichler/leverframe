
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as zlib from 'node:zlib';

function decodeRequestBody(raw: Buffer, encoding: string | string[] | undefined, maxOutputLength: number): string {
  const enc = (Array.isArray(encoding) ? encoding.join(',') : encoding ?? '').toLowerCase().trim();
  if (!enc || enc === 'identity') return raw.toString();
  switch (enc) {
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(raw, { maxOutputLength }).toString();
    case 'deflate':
      return zlib.inflateSync(raw, { maxOutputLength }).toString();
    case 'br':
      return zlib.brotliDecompressSync(raw, { maxOutputLength }).toString();
    case 'zstd':
      if (typeof zlib.zstdDecompressSync !== 'function') {
        throw new Error('zstd request encoding requires Node >= 22.15');
      }
      return zlib.zstdDecompressSync(raw, { maxOutputLength }).toString();
    default:

      return raw.toString();
  }
}

export function readBody(req: IncomingMessage, maxBodyBytes = 50 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (c: Buffer) => {
      totalSize += c.length;
      if (totalSize > maxBodyBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(decodeRequestBody(Buffer.concat(chunks), req.headers['content-encoding'], maxBodyBytes));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function extractApiKey(req: IncomingMessage): string | null {
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string') return xApiKey;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') return auth.replace(/^Bearer\s+/i, '').trim();
  return null;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}
