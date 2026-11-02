import { expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { observeResponseUsage } from '../src/http-proxy/response-usage.js';

async function observe(sse: string) {
  const upstream = Readable.from([sse]);
  const usages: Record<string, unknown>[] = [];
  await new Promise<void>(resolve => {
    observeResponseUsage(upstream as unknown as import('node:http').IncomingMessage, undefined, {
      onUsage: usage => usages.push(usage), onComplete: resolve,
    });
  });
  return usages;
}

it('retains valid cumulative input and cache usage when later stream events are partial', async () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":40,"cache_creation":{"ephemeral_5m_input_tokens":3},"cache_read_input_tokens":5}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":6,"cache_creation":{"ephemeral_1h_input_tokens":4}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"cache_creation":{"ephemeral_5m_input_tokens":4,"ephemeral_1h_input_tokens":6}}}',
    '', '',
  ].join('\n');

  const usages = await observe(sse);
  expect(usages.map(usage => ({
    usageStage: usage.usageStage, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheCreation5mInputTokens: usage.cacheCreation5mInputTokens,
    cacheCreation1hInputTokens: usage.cacheCreation1hInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens, totalInputTokens: usage.totalInputTokens,
  }))).toEqual([
    {
      usageStage: 'message_start', inputTokens: 40, outputTokens: undefined,
      cacheCreationInputTokens: undefined, cacheCreation5mInputTokens: 3,
      cacheCreation1hInputTokens: undefined, cacheReadInputTokens: 5, totalInputTokens: undefined,
    },
    {
      usageStage: 'message_delta', inputTokens: 40, outputTokens: 6,
      cacheCreationInputTokens: 7, cacheCreation5mInputTokens: 3,
      cacheCreation1hInputTokens: 4, cacheReadInputTokens: 5, totalInputTokens: 52,
    },
    {
      usageStage: 'message_delta', inputTokens: 40, outputTokens: 6,
      cacheCreationInputTokens: 10, cacheCreation5mInputTokens: 4,
      cacheCreation1hInputTokens: 6, cacheReadInputTokens: 5, totalInputTokens: 55,
    },
  ]);
});

it('leaves malformed and missing usage components unknown', async () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":-1,"cache_creation":{"ephemeral_5m_input_tokens":2.5},"cache_read_input_tokens":"5"}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":null}}',
    '', '',
  ].join('\n');

  expect(await observe(sse)).toEqual([
    {
      usageStage: 'message_start', inputTokens: undefined, totalInputTokens: undefined, outputTokens: undefined,
      cacheCreationInputTokens: undefined, cacheCreation5mInputTokens: undefined,
      cacheCreation1hInputTokens: undefined, cacheReadInputTokens: undefined,
    },
    {
      usageStage: 'message_delta', inputTokens: undefined, totalInputTokens: undefined, outputTokens: undefined,
      cacheCreationInputTokens: undefined, cacheCreation5mInputTokens: undefined,
      cacheCreation1hInputTokens: undefined, cacheReadInputTokens: undefined,
    },
  ]);
});
