import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeAnthropicStream } from '../src/sdk-streaming-response.js';
import type { FullStreamPart } from '../src/proxy-shared.js';

const usage = {
  inputTokens: 115_000,
  inputTokenDetails: { noCacheTokens: 500, cacheReadTokens: 114_500 },
  outputTokens: 100,
};

async function render(parts: FullStreamPart[], contextWindow = 272_000) {
  const chunks: string[] = [];
  let error: unknown;
  try {
    await writeAnthropicStream((async function* () { yield* parts; })(), 'test-model',
      chunk => { chunks.push(chunk); }, undefined, { contextWindow });
  } catch (caught) {
    error = caught;
  }
  return { error, output: chunks.join('') };
}

afterEach(() => { vi.doUnmock('ai'); vi.resetModules(); });

describe('stream completion validation', () => {
  it.each(['stop', 'other', 'error', 'length'])('rejects an empty %s finish despite token usage', async finishReason => {
    const result = await render([{ type: 'finish', finishReason, totalUsage: usage }]);
    expect(result.error).toMatchObject({ httpStatus: 502, retryable: true, outputEmitted: false });
    expect(result.output).toBe('');
  });

  it.each(['text', 'reasoning'])('keeps replay safe after an empty %s block', async type => {
    const result = await render([
      { type: `${type}-start`, id: 'empty' },
      { type: `${type}-delta`, id: 'empty', text: '' },
      { type: `${type}-end`, id: 'empty' },
      { type: 'finish', finishReason: 'stop', totalUsage: usage },
    ]);
    expect(result.error).toMatchObject({ httpStatus: 502, retryable: true, outputEmitted: false });
    expect(result.output).toBe('');
  });

  it('counts cached input when classifying context overflow', async () => {
    const result = await render([{ type: 'finish', finishReason: 'stop', totalUsage: usage }], 100_000);
    expect(result.error).toMatchObject({ category: 'context_length', httpStatus: 400, retryable: false });
    expect(String(result.error)).toContain('115000 > 100000');
  });

  it('rejects a failed finish after partial output without permitting replay', async () => {
    const result = await render([
      { type: 'text-delta', text: 'partial' },
      { type: 'finish', finishReason: 'error', totalUsage: usage },
    ]);
    expect(result.error).toMatchObject({ httpStatus: 502, retryable: false, outputEmitted: true });
    expect(result.output).toContain('partial');
    expect(result.output).not.toContain('message_stop');
  });

  it.each(['text', 'reasoning'])('rejects %s output without a terminal finish', async type => {
    const result = await render([{ type: `${type}-delta`, text: 'partial' }]);
    expect(result.error).toMatchObject({ httpStatus: 502, retryable: false, outputEmitted: true });
    expect(result.output).not.toContain('message_stop');
  });

  it.each([
    { openai: { reasoningEncryptedContent: 'encrypted-state' } },
    { google: { thoughtSignature: 'thought-state' } },
  ])('preserves signed reasoning without summary text', async providerMetadata => {
    const result = await render([
      { type: 'reasoning-start', id: 'reasoning' },
      { type: 'reasoning-end', id: 'reasoning', providerMetadata },
      { type: 'finish', finishReason: 'stop', totalUsage: usage },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('signature_delta');
    expect(result.output).toContain('message_stop');
  });

  it('preserves the raw provider reason through the streaming adapter', async () => {
    const result = await render([
      { type: 'finish', finishReason: 'other', rawFinishReason: 'provider_reason', totalUsage: usage },
    ]);
    expect(result.error).toMatchObject({ diagnosticDetail: expect.stringContaining('"rawFinishReason":"provider_reason"') });
  });

  it.each(['text', 'reasoning'])('preserves nonempty %s output on truncation', async type => {
    const result = await render([
      { type: `${type}-delta`, text: 'partial' },
      { type: 'finish', finishReason: 'length', totalUsage: usage },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('partial');
    expect(result.output).toContain('max_tokens');
    expect(result.output).toContain('message_stop');
  });
});

describe.each([false, true])('collected completion validation with forceStream=%s', forceStream => {
  async function generate(text: string, finishReason: string | undefined, contextWindow = 272_000, rawFinishReason?: string) {
    vi.doMock('ai', () => ({
      generateText: vi.fn(async () => ({ text, toolCalls: [], finishReason, rawFinishReason, usage })),
      streamText: vi.fn(() => ({ stream: (async function* () {
        if (text) yield { type: 'text-delta', text };
        if (finishReason !== undefined) yield { type: 'finish', finishReason, rawFinishReason, totalUsage: usage };
      })() })),
    }));
    const { generateAnthropicResponse } = await import('../src/sdk-non-streaming-response.js');
    return generateAnthropicResponse({} as never, { messages: [] }, 'test-model', { forceStream, contextWindow });
  }

  it.each(['stop', 'other', 'error', 'length'])('rejects empty %s despite reasoning usage', async reason => {
    await expect(generate('', reason)).rejects.toMatchObject({ httpStatus: 502 });
  });

  it('rejects failed responses containing text', async () => {
    await expect(generate('partial', 'error')).rejects.toMatchObject({ httpStatus: 502 });
  });

  it('rejects output without a terminal finish', async () => {
    await expect(generate('partial', undefined)).rejects.toMatchObject({ httpStatus: 502 });
  });

  it('preserves normalized and raw reasons through collection', async () => {
    await expect(generate('', 'other', 272_000, 'provider_reason')).rejects.toMatchObject({
      diagnosticDetail: expect.stringContaining('"rawFinishReason":"provider_reason"'),
    });
  });

  it('uses total input for context errors', async () => {
    await expect(generate('', 'stop', 100_000)).rejects.toMatchObject({ category: 'context_length' });
  });

  it('preserves partial output at the output limit', async () => {
    await expect(generate('partial', 'length')).resolves.toMatchObject({
      content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens',
    });
  });
});
