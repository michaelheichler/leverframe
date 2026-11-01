import { expect, it } from 'vitest';
import { writeAnthropicStream } from '../src/sdk-adapter.js';
import type { AnthropicUsageTrace } from '../src/sdk-usage.js';

async function collect(parts: unknown[], options?: Parameters<typeof writeAnthropicStream>[4]) {
  let raw = '';
  async function* stream() { yield* parts; }
  await writeAnthropicStream(stream() as never, 'fixture-model', chunk => { raw += chunk; }, undefined, options);
  const events = raw.split('\n\n').filter(Boolean).map(block => JSON.parse(block.split('\n')[1]!.slice(6)));
  return { events, raw };
}

const responseParts = [
  { type: 'start' },
  { type: 'text-start', id: 'text-fixture' },
  { type: 'text-delta', id: 'text-fixture', text: 'response' },
  { type: 'text-end', id: 'text-fixture' },
];

it('keeps missing provider input usage unknown in the audit callback while retaining wire defaults', async () => {
  const audit: AnthropicUsageTrace[] = [];
  const { events } = await collect([
    ...responseParts,
    { type: 'finish', finishReason: 'stop', totalUsage: { outputTokens: 7 } },
  ], { onUsage: usage => audit.push(usage) });

  expect(events.at(-2)?.usage.input_tokens).toBe(0);
  expect(audit).toEqual([{ model: 'fixture-model', output_tokens: 7 }]);
});

it('preserves valid provider cache usage in the audit callback', async () => {
  const audit: AnthropicUsageTrace[] = [];
  await collect([
    ...responseParts,
    {
      type: 'finish', finishReason: 'stop', totalUsage: {
        inputTokens: 60, outputTokens: 7,
        inputTokenDetails: { noCacheTokens: 35, cacheReadTokens: 10, cacheWriteTokens: 15 },
      },
    },
  ], { inputTokensIncludeCache: true, onUsage: usage => audit.push(usage) });

  expect(audit).toEqual([{
    model: 'fixture-model', input_tokens: 35, output_tokens: 7,
    cache_creation_input_tokens: 15, cache_read_input_tokens: 10,
  }]);
});
