import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { observeResponseUsage } from '../src/http-proxy/response-usage.js';

describe('response usage decoding', () => {
  it('decodes stacked content codings in reverse header order', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":123}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":9}}',
      '',
      '',
    ].join('\n');
    const encoded = brotliCompressSync(gzipSync(sse));
    const upstream = Readable.from([encoded]);
    const usages: Array<{ usageStage: string; inputTokens?: number; outputTokens?: number }> = [];

    await new Promise<void>(resolve => {
      observeResponseUsage(upstream as unknown as import('node:http').IncomingMessage, 'gzip, br', {
        onUsage: usage => usages.push(usage),
        onComplete: resolve,
      });
    });

    expect(usages).toEqual([
      { usageStage: 'message_start', inputTokens: 123, outputTokens: undefined, cacheCreationInputTokens: undefined, cacheReadInputTokens: undefined },
      { usageStage: 'message_delta', inputTokens: undefined, outputTokens: 9, cacheCreationInputTokens: undefined, cacheReadInputTokens: undefined },
    ]);
  });
});
