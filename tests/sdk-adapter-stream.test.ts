import { describe, it, expect, vi } from 'vitest';
import { writeAnthropicStream } from '../src/sdk-adapter.js';

async function collect(
  parts: any[],
  model = 'm',
  observer?: Parameters<typeof writeAnthropicStream>[4],
  tools?: Parameters<typeof writeAnthropicStream>[5],
): Promise<{ events: Array<{ event: string; data: any }>; raw: string }> {
  let raw = '';
  async function* gen() { for (const p of parts) yield p; }
  await writeAnthropicStream(gen() as any, model, (c) => { raw += c; }, undefined, observer, tools);
  const events = raw.split('\n\n').filter(Boolean).map(block => {
    const [evLine, dataLine] = block.split('\n');
    return { event: evLine.replace('event: ', ''), data: JSON.parse(dataLine.replace('data: ', '')) };
  });
  return { events, raw };
}

interface SseEventData {
  index?: number;
  delta?: { type?: string; partial_json?: string };
  content_block?: { id?: string; type?: string };
}

function toolInputFromEvents(events: Array<{ event: string; data: SseEventData }>): Record<string, unknown> {
  const start = events.find(e => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use')!;
  const json = events
    .filter(e => e.event === 'content_block_delta' && e.data.index === start.data.index && e.data.delta?.type === 'input_json_delta')
    .map(e => e.data.delta?.partial_json ?? '')
    .join('');
  return JSON.parse(json || '{}') as Record<string, unknown>;
}

describe('writeAnthropicStream', () => {
  it('emits a well-formed text turn', async () => {
    const { events } = await collect([
      { type: 'start' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'Hello' },
      { type: 'text-delta', id: 't1', text: ' world' },
      { type: 'text-end', id: 't1' },
      { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 5, outputTokens: 2 } },
    ], 'm', { initialInputTokens: 37 });
    const types = events.map(e => e.event);
    expect(types).toEqual([
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
      'content_block_stop', 'message_delta', 'message_stop',
    ]);
    const start = events.find(e => e.event === 'message_start')!;
    expect(start.data.message.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    const delta = events.find(e => e.event === 'message_delta')!;
    expect(delta.data.delta.stop_reason).toBe('end_turn');
    expect(delta.data.usage).toEqual({
      input_tokens: 5,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it('does not double-count the local estimate when final input is fully cached', async () => {
    const { events } = await collect([
      { type: 'start' },
      {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: {
          inputTokens: 173_000,
          outputTokens: 100,
          inputTokenDetails: { cacheReadTokens: 173_000 },
        },
      },
    ], 'm', { initialInputTokens: 61_500, inputTokensIncludeCache: true });

    const start = events.find(e => e.event === 'message_start')!.data.message.usage;
    const delta = events.find(e => e.event === 'message_delta')!.data.usage;
    const claudeMergedUsage = {
      input_tokens: delta.input_tokens > 0 ? delta.input_tokens : start.input_tokens,
      cache_creation_input_tokens: delta.cache_creation_input_tokens > 0
        ? delta.cache_creation_input_tokens
        : start.cache_creation_input_tokens,
      cache_read_input_tokens: delta.cache_read_input_tokens > 0
        ? delta.cache_read_input_tokens
        : start.cache_read_input_tokens,
    };

    expect(
      claudeMergedUsage.input_tokens
      + claudeMergedUsage.cache_creation_input_tokens
      + claudeMergedUsage.cache_read_input_tokens,
    ).toBe(173_000);
  });

  it('uses the local input estimate when final usage omits input tokens', async () => {
    const { events } = await collect([
      { type: 'start' },
      {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 0, outputTokens: 7 },
      },
    ], 'm', { initialInputTokens: 37 });

    expect(events.find(e => e.event === 'message_delta')!.data.usage).toEqual({
      input_tokens: 37,
      output_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it('reports cache hits: inputTokenDetails.cacheReadTokens → cache_read_input_tokens', async () => {

    const { events } = await collect([
      { type: 'start' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'hi' },
      { type: 'text-end', id: 't1' },
      {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 100, outputTokens: 7, inputTokenDetails: { cacheReadTokens: 80 } },
      },
    ], 'm', { inputTokensIncludeCache: true });
    expect(events.find(e => e.event === 'message_delta')!.data.usage).toEqual({
      input_tokens: 20,
      output_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 80,
    });
  });

  it('preserves cache usage reported separately from uncached input', async () => {
    const { events } = await collect([
      { type: 'start' },
      {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: {
          inputTokens: 20,
          outputTokens: 4,
          inputTokenDetails: { cacheReadTokens: 80 },
        },
      },
    ]);

    expect(events.find(e => e.event === 'message_delta')?.data.usage).toEqual({
      input_tokens: 20,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 80,
    });
  });

  it('clamps inclusive input at zero when cache usage exceeds the total', async () => {
    const onUsage = vi.fn();
    const { events } = await collect([
      { type: 'start' },
      {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: {
          inputTokens: 20,
          outputTokens: 4,
          inputTokenDetails: { cacheReadTokens: 80 },
        },
      },
    ], 'gpt-test', {
      inputTokensIncludeCache: true,
      promptCacheKeyHash: '0123456789abcdef',
      onUsage,
    });

    expect(events.find(e => e.event === 'message_delta')?.data.usage).toEqual({
      input_tokens: 0,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 80,
    });
    expect(onUsage).toHaveBeenCalledWith({
      model: 'gpt-test',
      input_tokens: 0,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 80,
      promptCacheKeyHash: '0123456789abcdef',
    });
  });

  it('sanitizes malformed usage and retains the local input fallback', async () => {
    const { events } = await collect([
      { type: 'start' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'ok' },
      { type: 'text-end', id: 't1' },
      {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: {
          inputTokens: Number.NaN,
          outputTokens: -2,
          inputTokenDetails: {
            cacheReadTokens: -3,
            cacheWriteTokens: Number.POSITIVE_INFINITY,
          },
        },
      },
    ], 'm', { initialInputTokens: 37 });

    expect(events.find(e => e.event === 'message_delta')?.data.usage).toEqual({
      input_tokens: 37,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it('uses legacy cached input only when detailed cache usage is absent', async () => {
    const legacy = await collect([
      { type: 'start' },
      {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 100, outputTokens: 1, cachedInputTokens: 80 },
      },
    ], 'm', { inputTokensIncludeCache: true });
    const detailedZero = await collect([
      { type: 'start' },
      {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: {
          inputTokens: 100,
          outputTokens: 1,
          cachedInputTokens: 80,
          inputTokenDetails: { cacheReadTokens: 0 },
        },
      },
    ], 'm', { inputTokensIncludeCache: true });

    expect(legacy.events.find(e => e.event === 'message_delta')?.data.usage).toMatchObject({
      input_tokens: 20,
      cache_read_input_tokens: 80,
    });
    expect(detailedZero.events.find(e => e.event === 'message_delta')?.data.usage).toMatchObject({
      input_tokens: 100,
      cache_read_input_tokens: 0,
    });
  });

  it('reports GPT-5.6 cache writes as Anthropic cache creation tokens', async () => {
    const { events } = await collect([
      { type: 'start' },
      {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: {
          inputTokens: 120,
          outputTokens: 3,
          inputTokenDetails: { cacheReadTokens: 20, cacheWriteTokens: 80 },
        },
      },
    ], 'm', { inputTokensIncludeCache: true });
    expect(events.find(e => e.event === 'message_delta')!.data.usage).toEqual({
      input_tokens: 20,
      output_tokens: 3,
      cache_creation_input_tokens: 80,
      cache_read_input_tokens: 20,
    });
  });

  it('propagates an AI SDK stream failure so the HTTP layer can preserve its status', async () => {
    const upstreamError = { statusCode: 401, message: 'Unauthorized' };
    async function* parts() {
      yield { type: 'error', error: upstreamError };
    }

    await expect(writeAnthropicStream(parts() as any, 'm', () => {})).rejects.toBe(upstreamError);
  });

  it('reports every SDK stream part to the lifecycle observer', async () => {
    const observed: string[] = [];
    async function* parts() {
      yield { type: 'start' };
      yield { type: 'text-start', id: 't1' };
      yield { type: 'text-delta', id: 't1', text: 'hi' };
      yield { type: 'finish', finishReason: 'stop' };
    }

    await writeAnthropicStream(
      parts() as any,
      'm',
      () => {},
      undefined,
      { onPart: type => observed.push(type) },
    );

    expect(observed).toEqual(['start', 'text-start', 'text-delta', 'finish']);
  });

  it('delivers a truncated response when a deadline aborts an active stream', async () => {
    const deadline = new AbortController();
    const client = new AbortController();
    let raw = '';
    async function* stream() {
      yield { type: 'start' };
      yield { type: 'text-start', id: 't1' };
      yield { type: 'text-delta', id: 't1', text: 'partial' };
      deadline.abort(new Error('deadline'));
      yield { type: 'abort' };
    }
    await writeAnthropicStream(
      stream() as unknown as AsyncIterable<never>,
      'm',
      chunk => { raw += chunk; },
      undefined,
      { abortSignal: deadline.signal, clientAbortSignal: client.signal },
    );
    const events = raw.split('\n\n').filter(Boolean).map(block => {
      const [event, data] = block.split('\n');
      return { event: event.replace('event: ', ''), data: JSON.parse(data.replace('data: ', '')) };
    });
    expect(events.map(event => event.event)).toContain('message_delta');
    expect(events.find(event => event.event === 'message_delta')?.data.delta.stop_reason).toBe('max_tokens');
    expect(events.map(event => event.event)).toContain('message_stop');
    expect(events.map(event => event.event)).not.toContain('error');
  });

  it('delivers buffered tool JSON when a deadline aborts an active stream', async () => {
    const deadline = new AbortController();
    const client = new AbortController();
    const parts = [
      { type: 'start' },
      { type: 'tool-input-start', id: 'call_1', toolName: 'Read' },
      { type: 'tool-input-delta', id: 'call_1', delta: '{"path":"x"}' },
      { type: 'abort' },
    ];
    let raw = '';
    async function* stream() {
      yield parts[0];
      yield parts[1];
      yield parts[2];
      deadline.abort(new Error('deadline'));
      yield parts[3];
    }
    await writeAnthropicStream(
      stream() as unknown as AsyncIterable<never>,
      'm',
      chunk => { raw += chunk; },
      undefined,
      { abortSignal: deadline.signal, clientAbortSignal: client.signal },
    );
    const events = raw.split('\n\n').filter(Boolean).map(block => {
      const [event, data] = block.split('\n');
      return { event: event.replace('event: ', ''), data: JSON.parse(data.replace('data: ', '')) };
    });
    expect(toolInputFromEvents(events)).toEqual({ path: 'x' });
    expect(events.map(event => event.event)).not.toContain('error');
  });

  it('flushes cumulative tool JSON without duplicating already emitted prefixes', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const chunks: string[] = [];
    async function* stream() {
      yield { type: 'start' };
      yield { type: 'tool-input-start', id: 'call_1', toolName: 'Read' };
      yield { type: 'tool-input-delta', id: 'call_1', delta: '{"a":' };
      await paused;
      yield { type: 'tool-input-delta', id: 'call_1', delta: '1}' };
      yield { type: 'tool-call', toolCallId: 'call_1', toolName: 'Read', input: { a: 1 } };
      yield { type: 'finish', finishReason: 'tool-calls' };
    }
    const running = writeAnthropicStream(
      stream() as unknown as AsyncIterable<never>,
      'm',
      chunk => chunks.push(chunk),
    );
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(2_000);
    release?.();
    await running;
    vi.useRealTimers();
    const json = chunks
      .join('')
      .split('\n\n')
      .filter(Boolean)
      .map(block => JSON.parse(block.split('\n')[1].replace('data: ', '')))
      .filter(event => event.type === 'content_block_delta' && event.delta.type === 'input_json_delta')
      .map(event => event.delta.partial_json)
      .join('');
    expect(json).toBe('{"a":1}');
  });

  it('falls back to raw JSON when final key order differs after an early flush', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const chunks: string[] = [];
    async function* stream() {
      yield { type: 'start' };
      yield { type: 'tool-input-start', id: 'call_1', toolName: 'Read' };
      yield { type: 'tool-input-delta', id: 'call_1', delta: '{"a": 1, "b": 2}' };
      await paused;
      yield { type: 'tool-call', toolCallId: 'call_1', toolName: 'Read', input: { b: 2, a: 1 } };
      yield { type: 'finish', finishReason: 'tool-calls' };
    }
    const running = writeAnthropicStream(
      stream() as unknown as AsyncIterable<never>,
      'm',
      chunk => chunks.push(chunk),
    );
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(2_000);
    release?.();
    await running;
    vi.useRealTimers();
    const events = chunks.join('').split('\n\n').filter(Boolean).map(block => {
      const [event, data] = block.split('\n');
      return { event: event.replace('event: ', ''), data: JSON.parse(data.replace('data: ', '')) };
    });
    expect(toolInputFromEvents(events)).toEqual({ a: 1, b: 2 });
  });

  it('propagates an SDK abort without synthesizing a completed response', async () => {
    const abort = new AbortController();
    const reason = new Error('Client disconnected');
    const observed: string[] = [];
    const writes: string[] = [];
    async function* parts() {
      yield { type: 'start' };
      abort.abort(reason);
      yield { type: 'abort', reason: 'abort' };
    }

    await expect(writeAnthropicStream(
      parts() as any,
      'm',
      chunk => writes.push(chunk),
      undefined,
      { abortSignal: abort.signal, clientAbortSignal: abort.signal, onPart: type => observed.push(type) },
    )).rejects.toBe(reason);

    expect(observed).toEqual(['start', 'abort']);
    expect(writes).toEqual([]);
  });

  it('wraps a string stream failure for the HTTP layer', async () => {
    async function* parts() {
      yield { type: 'error', error: 'Something went wrong' };
    }

    await expect(writeAnthropicStream(parts() as any, 'm', () => {})).rejects.toThrow('Something went wrong');
  });

  it('encodes thought_signature into the tool_use id and reports tool_use stop', async () => {
    const { events } = await collect([
      { type: 'start' },
      { type: 'tool-input-start', id: 'call_9', toolName: 'Read', providerMetadata: { google: { thoughtSignature: 'SIG9' } } },
      { type: 'tool-input-delta', id: 'call_9', delta: '{"path":"x"}' },
      { type: 'tool-input-end', id: 'call_9' },
      { type: 'tool-call', toolCallId: 'call_9', toolName: 'Read', input: { path: 'x' } },
      { type: 'finish', finishReason: 'tool-calls' },
    ]);
    const start = events.find(e => e.event === 'content_block_start')!;
    expect(start.data.content_block.type).toBe('tool_use');
    expect(start.data.content_block.id).toBe('call_9__ts__U0lHOQ');
    expect(events.find(e => e.event === 'message_delta')!.data.delta.stop_reason).toBe('tool_use');
  });
});
