import type { IncomingMessage } from 'node:http';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

const MAX_USAGE_SSE_BLOCK_BYTES = 64 * 1024;

export type ResponseUsage = {
  usageStage: 'message_start' | 'message_delta';
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
};

function numericUsage(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function responseUsageFromSseBlock(block: string): ResponseUsage | undefined {
  const lines = block.split('\n');
  const event = lines.find(line => line.startsWith('event:'))?.slice('event:'.length).trim();
  const data = lines
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trimStart())
    .join('\n');
  if (!data) return undefined;

  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const type = parsed.type;
    if (type !== 'message_start' && type !== 'message_delta') return undefined;
    if (event && event !== type) return undefined;
    const message = type === 'message_start'
      ? parsed.message as Record<string, unknown> | undefined
      : undefined;
    const usage = (type === 'message_start' ? message?.usage : parsed.usage) as Record<string, unknown> | undefined;
    if (!usage) return undefined;
    return {
      usageStage: type,
      inputTokens: numericUsage(usage.input_tokens),
      outputTokens: numericUsage(usage.output_tokens),
      cacheCreationInputTokens: numericUsage(usage.cache_creation_input_tokens),
      cacheReadInputTokens: numericUsage(usage.cache_read_input_tokens),
    };
  } catch {
    return undefined;
  }
}

type ResponseUsageCapture = {
  capture: (chunk: Buffer) => void;
  flush: () => void;
};

function createResponseUsageCapture(
  onUsage: (usage: ResponseUsage) => void,
): ResponseUsageCapture {
  let buffered = '';
  const processBuffer = (flush: boolean) => {
    let boundary: number;
    while ((boundary = buffered.indexOf('\n\n')) >= 0) {
      const block = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      if (Buffer.byteLength(block) > MAX_USAGE_SSE_BLOCK_BYTES) continue;
      const usage = responseUsageFromSseBlock(block);
      if (usage) onUsage(usage);
    }
    if (flush && buffered.length > 0) {
      const block = buffered;
      buffered = '';
      if (Buffer.byteLength(block) <= MAX_USAGE_SSE_BLOCK_BYTES) {
        const usage = responseUsageFromSseBlock(block);
        if (usage) onUsage(usage);
      }
    }
    if (Buffer.byteLength(buffered) > MAX_USAGE_SSE_BLOCK_BYTES) buffered = '';
  };

  return {
    capture: chunk => {
      buffered = (buffered + chunk.toString('utf8')).replace(/\r\n/g, '\n');
      processBuffer(false);
    },
    flush: () => processBuffer(true),
  };
}

export function observeResponseUsage(
  upstream: IncomingMessage,
  contentEncoding: string | string[] | undefined,
  callbacks: { onUsage: (usage: ResponseUsage) => void; onComplete: () => void },
): void {
  const encoding = (Array.isArray(contentEncoding) ? contentEncoding[0] : contentEncoding)
    ?.trim()
    .toLowerCase();
  if (!encoding || encoding === 'identity') {
    const capture = createResponseUsageCapture(callbacks.onUsage);
    upstream.on('data', capture.capture);
    upstream.once('end', () => {
      capture.flush();
      upstream.off('data', capture.capture);
      callbacks.onComplete();
    });
    return;
  }

  const decoder = encoding === 'gzip'
    ? createGunzip()
    : encoding === 'br'
      ? createBrotliDecompress()
      : encoding === 'deflate'
        ? createInflate()
        : undefined;
  if (!decoder) {
    callbacks.onComplete();
    return;
  }

  const onCompressedData = (chunk: Buffer) => {
    if (!decoder.destroyed) decoder.write(chunk);
  };
  const onCompressedEnd = () => {
    if (!decoder.destroyed) decoder.end();
  };
  const cleanup = () => {
    upstream.off('data', onCompressedData);
    upstream.off('end', onCompressedEnd);
    decoder.destroy();
  };
  const capture = createResponseUsageCapture(callbacks.onUsage);
  decoder.on('data', capture.capture);
  decoder.once('error', () => {
    cleanup();
    callbacks.onComplete();
  });
  decoder.once('end', () => {
    capture.flush();
    cleanup();
    callbacks.onComplete();
  });
  upstream.on('data', onCompressedData);
  upstream.once('end', onCompressedEnd);
}
