import { createHash } from 'node:crypto';

export interface CopilotImageReference {
  reference: string;
  mediaType: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertImageMediaType(mediaType: string): void {
  if (!mediaType.startsWith('image/')) {
    throw new TypeError('Copilot supports only image prompt files');
  }
}

export function copilotImageReference(data: unknown, mediaType: string): CopilotImageReference {
  assertImageMediaType(mediaType);
  if (data instanceof URL) return { reference: data.href, mediaType };
  if (data instanceof Uint8Array || typeof data === 'string') {
    const payload = data instanceof Uint8Array ? Buffer.from(data).toString('base64') : data;
    return { reference: `sha256:${sha256(payload)}`, mediaType };
  }
  throw new TypeError('Copilot image data must be bytes, base64, or a URL');
}

export function copilotImageBlob(data: unknown, mediaType: string): string | undefined {
  assertImageMediaType(mediaType);
  if (data instanceof URL) return undefined;
  if (data instanceof Uint8Array) return Buffer.from(data).toString('base64');
  if (typeof data === 'string') return data;
  throw new TypeError('GitHub Copilot image data must be bytes or base64');
}
