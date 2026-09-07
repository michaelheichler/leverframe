import { describe, it, expect, vi } from 'vitest';
import {
  translateTools,
  writeAnthropicStream,
} from '../src/sdk-adapter.js';

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

describe('writeAnthropicStream tool input handling', () => {
  const webSearchTools = translateTools([{
    name: 'WebSearch',
    description: 'Search the web',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        allowed_domains: { type: 'array', items: { type: 'string' } },
        blocked_domains: { type: 'array', items: { type: 'string' } },
      },
      required: ['query'],
    },
  }]);

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

  it('strips WebSearch empty-array filler while preserving unknown values in streamed tool input', async () => {
    const input = { query: 'who won', allowed_domains: ['fifa.com'], blocked_domains: [], max_uses: null };
    const { events } = await collect([
      { type: 'start' },
      { type: 'tool-input-start', id: 'call_1', toolName: 'WebSearch' },
      { type: 'tool-input-delta', id: 'call_1', delta: JSON.stringify(input).slice(0, 20) },
      { type: 'tool-input-delta', id: 'call_1', delta: JSON.stringify(input).slice(20) },
      { type: 'tool-input-end', id: 'call_1' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'WebSearch', input },
      { type: 'finish', finishReason: 'tool-calls' },
    ], 'm', undefined, webSearchTools);
    expect(toolInputFromEvents(events)).toEqual({ query: 'who won', allowed_domains: ['fifa.com'], max_uses: null });
  });

  it('strips the same WebSearch filler from a non-streamed tool call', async () => {
    const { events } = await collect([
      { type: 'start' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'WebSearch', input: { query: 'who won', blocked_domains: [], allowed_domains: null } },
      { type: 'finish', finishReason: 'tool-calls' },
    ], 'm', undefined, webSearchTools);
    expect(toolInputFromEvents(events)).toEqual({ query: 'who won' });
  });

  it('preserves nullable and unknown values while removing schema-invalid filler', async () => {
    const schemaAwareTools = translateTools([{
      name: 'SchemaAware',
      input_schema: {
        type: 'object',
        properties: {
          nullable_note: { type: ['string', 'null'] },
          optional_count: { type: 'number' },
          nonempty_items: { type: 'array', minItems: 1, items: { type: 'string' } },
        },
      },
    }]);
    const { events } = await collect([
      { type: 'start' },
      {
        type: 'tool-call',
        toolCallId: 'call_schema',
        toolName: 'SchemaAware',
        input: {
          nullable_note: null,
          optional_count: null,
          nonempty_items: [],
          unknown_value: null,
        },
      },
      { type: 'finish', finishReason: 'tool-calls' },
    ], 'm', undefined, schemaAwareTools);

    expect(toolInputFromEvents(events)).toEqual({
      nullable_note: null,
      unknown_value: null,
    });
  });

  it('preserves an intentional empty array for a schema-required property', async () => {
    const todoTools = translateTools([{
      name: 'TodoWrite',
      description: 'Update the todo list',
      input_schema: {
        type: 'object',
        properties: { todos: { type: 'array' } },
        required: ['todos'],
      },
    }]);
    const { events } = await collect([
      { type: 'start' },
      { type: 'tool-input-start', id: 'call_1', toolName: 'TodoWrite' },
      { type: 'tool-input-delta', id: 'call_1', delta: '{"todos":[]}' },
      { type: 'tool-input-end', id: 'call_1' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'TodoWrite', input: { todos: [] } },
      { type: 'finish', finishReason: 'tool-calls' },
    ], 'm', undefined, todoTools);
    expect(toolInputFromEvents(events)).toEqual({ todos: [] });
  });

  it('emits the buffered raw tool input when the stream ends without a tool-call part', async () => {
    const { events } = await collect([
      { type: 'start' },
      { type: 'tool-input-start', id: 'call_1', toolName: 'Read' },
      { type: 'tool-input-delta', id: 'call_1', delta: '{"path":' },
      { type: 'tool-input-delta', id: 'call_1', delta: '"x"}' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    expect(toolInputFromEvents(events)).toEqual({ path: 'x' });

    const start = events.find(e => e.event === 'content_block_start')!;
    expect(events.some(e => e.event === 'content_block_stop' && e.data.index === start.data.index)).toBe(true);
  });

  it('emits thinking block with a signature_delta close (Google SDK)', async () => {
    const { events } = await collect([
      { type: 'start' },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', text: 'thinking...' },
      { type: 'reasoning-end', id: 'r1', providerMetadata: { google: { thoughtSignature: 'RSIG' } } },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'done' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    const thinkStart = events.find(e => e.event === 'content_block_start')!;
    expect(thinkStart.data.content_block.type).toBe('thinking');
    const sigDelta = events.find(e => e.event === 'content_block_delta' && e.data.delta.type === 'signature_delta')!;
    expect(sigDelta.data.delta.signature).toBe('RSIG');
  });

  it('emits thinking block with OpenAI reasoningEncryptedContent in signature_delta', async () => {
    const { events } = await collect([
      { type: 'start' },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', text: 'thinking...' },
      { type: 'reasoning-end', id: 'r1', providerMetadata: { openai: { reasoningEncryptedContent: 'enc_xyz' } } },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'done' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    const sigDelta = events.find(e => e.event === 'content_block_delta' && e.data.delta.type === 'signature_delta')!;
    expect(sigDelta.data.delta.signature).toBe('enc_xyz');
  });

  const strictTools = translateTools([{
    name: 'Write',
    description: 'Write a file',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  }]);

  function eventsFromChunks(chunks: string[]): Array<{ event: string; data: SseEventData }> {
    return chunks.join('').split('\n\n').filter(Boolean).map(block => {
      const [event, data] = block.split('\n');
      return { event: event.replace('event: ', ''), data: JSON.parse(data.replace('data: ', '')) as SseEventData };
    });
  }

  function withEnv(name: string, value: string, fn: () => Promise<void>): Promise<void> {
    const prev = process.env[name];
    process.env[name] = value;
    return fn().finally(() => {
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    });
  }

  async function flushMicrotasks(turns = 8): Promise<void> {
    for (let i = 0; i < turns; i++) await Promise.resolve();
  }

  it('flushes early once buffered tool JSON crosses the size threshold', () => withEnv('LEVERFRAME_TOOL_EARLY_FLUSH_BYTES', '5', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const chunks: string[] = [];
    async function* stream() {
      yield { type: 'start' };
      yield { type: 'tool-input-start', id: 'call_1', toolName: 'Write' };
      yield { type: 'tool-input-delta', id: 'call_1', delta: '{"path":"x.txt"' };
      await paused;
      yield { type: 'tool-input-delta', id: 'call_1', delta: ',"content":"hi"}' };
      yield { type: 'tool-call', toolCallId: 'call_1', toolName: 'Write', input: { path: 'x.txt', content: 'hi' } };
      yield { type: 'finish', finishReason: 'tool-calls' };
    }
    const running = writeAnthropicStream(
      stream() as unknown as AsyncIterable<never>, 'm', chunk => chunks.push(chunk), undefined, undefined, strictTools,
    );
    await flushMicrotasks();
    vi.advanceTimersByTime(2_000);
    expect(chunks.join('')).toContain('input_json_delta');
    release?.();
    await running;
    vi.useRealTimers();
    expect(toolInputFromEvents(eventsFromChunks(chunks))).toEqual({ path: 'x.txt', content: 'hi' });
  }));

  it('flushes early once a tool call has been open past the time threshold, even with a small buffer', () => withEnv('LEVERFRAME_TOOL_EARLY_FLUSH_MS', '500', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const chunks: string[] = [];
    async function* stream() {
      yield { type: 'start' };
      yield { type: 'tool-input-start', id: 'call_1', toolName: 'Write' };
      yield { type: 'tool-input-delta', id: 'call_1', delta: '{"a":1' };
      await paused;
      yield { type: 'tool-input-delta', id: 'call_1', delta: ',"b":2}' };
      yield { type: 'tool-call', toolCallId: 'call_1', toolName: 'Write', input: { a: 1, b: 2 } };
      yield { type: 'finish', finishReason: 'tool-calls' };
    }
    const running = writeAnthropicStream(
      stream() as unknown as AsyncIterable<never>, 'm', chunk => chunks.push(chunk), undefined, undefined, strictTools,
    );
    await flushMicrotasks();

    vi.advanceTimersByTime(2_000);
    expect(chunks.join('')).toContain('input_json_delta');
    release?.();
    await running;
    vi.useRealTimers();
    expect(toolInputFromEvents(eventsFromChunks(chunks))).toEqual({ a: 1, b: 2 });
  }));

  it('never early-flushes an omitEmptyArrays tool (WebSearch) even past both override thresholds', async () => {
    await withEnv('LEVERFRAME_TOOL_EARLY_FLUSH_BYTES', '1', () => withEnv('LEVERFRAME_TOOL_EARLY_FLUSH_MS', '1', async () => {
      vi.useFakeTimers();
      let release: (() => void) | undefined;
      const paused = new Promise<void>(resolve => { release = resolve; });
      const chunks: string[] = [];
      const input = { query: 'who won', allowed_domains: ['fifa.com'], blocked_domains: [] };
      async function* stream() {
        yield { type: 'start' };
        yield { type: 'tool-input-start', id: 'call_1', toolName: 'WebSearch' };
        yield { type: 'tool-input-delta', id: 'call_1', delta: JSON.stringify(input) };
        await paused;
        yield { type: 'tool-call', toolCallId: 'call_1', toolName: 'WebSearch', input };
        yield { type: 'finish', finishReason: 'tool-calls' };
      }
      const running = writeAnthropicStream(
        stream() as unknown as AsyncIterable<never>, 'm', chunk => chunks.push(chunk), undefined, undefined, webSearchTools,
      );
      await flushMicrotasks();
      vi.advanceTimersByTime(6_000);
      expect(chunks.join('')).not.toContain('input_json_delta');
      release?.();
      await running;
      vi.useRealTimers();
      expect(toolInputFromEvents(eventsFromChunks(chunks))).toEqual({ query: 'who won', allowed_domains: ['fifa.com'] });
    }));
  });

  it('rejects tool-input-delta once buffered JSON exceeds the runaway byte cap', () => withEnv('LEVERFRAME_TOOL_JSON_MAX_BYTES', '10', async () => {
    async function* stream() {
      yield { type: 'start' };
      yield { type: 'tool-input-start', id: 'call_1', toolName: 'Read' };
      yield { type: 'tool-input-delta', id: 'call_1', delta: '{"path":"way more than ten bytes of JSON"}' };
    }
    await expect(
      writeAnthropicStream(stream() as unknown as AsyncIterable<never>, 'm', () => {}),
    ).rejects.toMatchObject({ category: 'tool_call_protocol', retryable: true });
  }));

  it('flushes only the over-threshold tool among two tool calls sharing a turn, and both reconcile', () => withEnv('LEVERFRAME_TOOL_EARLY_FLUSH_BYTES', '20', async () => {
    vi.useFakeTimers();
    let releaseBig: (() => void) | undefined;
    const pausedBig = new Promise<void>(resolve => { releaseBig = resolve; });
    let releaseSmall: (() => void) | undefined;
    const pausedSmall = new Promise<void>(resolve => { releaseSmall = resolve; });
    const chunks: string[] = [];
    const bigContent = 'a'.repeat(40);
    async function* stream() {
      yield { type: 'start' };
      yield { type: 'tool-input-start', id: 'call_big', toolName: 'Write' };
      yield { type: 'tool-input-delta', id: 'call_big', delta: `{"path":"big.txt","content":"${bigContent}"}` };
      await pausedBig;
      yield { type: 'tool-call', toolCallId: 'call_big', toolName: 'Write', input: { path: 'big.txt', content: bigContent } };
      yield { type: 'tool-input-start', id: 'call_small', toolName: 'Write' };
      yield { type: 'tool-input-delta', id: 'call_small', delta: '{"pa' };
      await pausedSmall;
      yield { type: 'tool-call', toolCallId: 'call_small', toolName: 'Write', input: { path: 'small.txt', content: 'b' } };
      yield { type: 'finish', finishReason: 'tool-calls' };
    }
    const running = writeAnthropicStream(
      stream() as unknown as AsyncIterable<never>, 'm', chunk => chunks.push(chunk), undefined, undefined, strictTools,
    );
    await flushMicrotasks();
    vi.advanceTimersByTime(2_000);
    const afterBigTick = eventsFromChunks(chunks);
    const bigIndex = afterBigTick.find(e => e.event === 'content_block_start' && e.data.content_block?.id === 'call_big')!.data.index!;
    const flushed = (events: ReturnType<typeof eventsFromChunks>, index: number) => events.some(
      e => e.event === 'content_block_delta' && e.data.index === index && e.data.delta?.type === 'input_json_delta',
    );
    expect(flushed(afterBigTick, bigIndex)).toBe(true);
    releaseBig?.();
    await flushMicrotasks();
    vi.advanceTimersByTime(2_000);
    const afterSmallTick = eventsFromChunks(chunks);
    const smallIndex = afterSmallTick.find(e => e.event === 'content_block_start' && e.data.content_block?.id === 'call_small')!.data.index!;
    expect(flushed(afterSmallTick, smallIndex)).toBe(false);
    releaseSmall?.();
    await running;
    vi.useRealTimers();
    const after = eventsFromChunks(chunks);
    const toolInputAtIndex = (index: number): Record<string, unknown> => {
      const json = after
        .filter(e => e.event === 'content_block_delta' && e.data.index === index && e.data.delta?.type === 'input_json_delta')
        .map(e => e.data.delta?.partial_json ?? '')
        .join('');
      return JSON.parse(json || '{}') as Record<string, unknown>;
    };
    expect(toolInputAtIndex(bigIndex)).toEqual({ path: 'big.txt', content: bigContent });
    expect(toolInputAtIndex(smallIndex)).toEqual({ path: 'small.txt', content: 'b' });
  }));

  it('does not duplicate already-flushed tool JSON or emit an error when the client aborts mid-flush', () => withEnv('LEVERFRAME_TOOL_EARLY_FLUSH_BYTES', '5', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const deadline = new AbortController();
    const client = new AbortController();
    const chunks: string[] = [];
    async function* stream() {
      yield { type: 'start' };
      yield { type: 'tool-input-start', id: 'call_1', toolName: 'Write' };
      yield { type: 'tool-input-delta', id: 'call_1', delta: '{"path":"x.txt"' };
      await paused;
      deadline.abort(new Error('deadline'));
      yield { type: 'abort' };
    }
    const running = writeAnthropicStream(
      stream() as unknown as AsyncIterable<never>,
      'm',
      chunk => chunks.push(chunk),
      undefined,
      { abortSignal: deadline.signal, clientAbortSignal: client.signal },
      strictTools,
    );
    await flushMicrotasks();
    vi.advanceTimersByTime(2_000);
    release?.();
    await running;
    vi.useRealTimers();
    const events = eventsFromChunks(chunks);
    expect(events.map(e => e.event)).not.toContain('error');
    const toolIndex = events.find(e => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use')!.data.index;
    const combined = events
      .filter(e => e.event === 'content_block_delta' && e.data.index === toolIndex && e.data.delta?.type === 'input_json_delta')
      .map(e => e.data.delta?.partial_json ?? '')
      .join('');
    expect(combined).toBe('{"path":"x.txt"');
  }));
});
