import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeAnthropicStream } from '../src/sdk-streaming-response.js';
import type { FullStreamPart } from '../src/proxy-shared.js';

interface Event {
  type: string;
  index?: number;
  content_block?: { type: string; id: string };
  delta?: { type?: string; partial_json?: string; stop_reason?: string };
}

async function collect(parts: FullStreamPart[]) {
  const chunks: string[] = [];
  async function* stream() { yield* parts; }
  await writeAnthropicStream(stream(), 'fake-model', chunk => { chunks.push(chunk); });
  return chunks.join('').split('\n\n').filter(Boolean).map(block =>
    JSON.parse(block.split('\ndata: ')[1]) as Event);
}

function expectTools(events: Event[]) {
  const starts = events.filter(event => event.content_block?.type === 'tool_use');
  expect(starts.map(event => event.content_block?.id)).toEqual(['a', 'b']);
  expect(new Set(starts.map(event => event.index)).size).toBe(2);
  starts.forEach(start => {
    const deltas = events.filter(event => event.index === start.index && event.delta?.type === 'input_json_delta');
    expect(JSON.parse(deltas.map(event => event.delta?.partial_json).join(''))).toEqual({ path: start.content_block?.id });
    const stops = events.filter(event => event.type === 'content_block_stop' && event.index === start.index);
    expect(stops).toHaveLength(1);
    expect(events.indexOf(stops[0])).toBeGreaterThan(events.indexOf(deltas[deltas.length - 1]));
  });
}

afterEach(() => { vi.doUnmock('ai'); vi.resetModules(); });

describe('Anthropic parallel tool completion', () => {
  it('keeps arguments open across interleaved starts and reverse-order completion', async () => {
    const events = await collect([
      { type: 'tool-input-start', id: 'a', toolName: 'Read' },
      { type: 'tool-input-delta', id: 'a', delta: '{"path":' },
      { type: 'tool-input-start', id: 'b', toolName: 'Read' },
      { type: 'tool-input-delta', id: 'b', delta: '{"path":"b"}' },
      { type: 'tool-call', toolCallId: 'b', toolName: 'Read', input: { path: 'b' } },
      { type: 'tool-input-delta', id: 'a', delta: '"a"}' },
      { type: 'tool-call', toolCallId: 'a', toolName: 'Read', input: { path: 'a' } },
      { type: 'finish', finishReason: 'tool-calls' },
    ]);
    expect(events.filter(event => event.type === 'content_block_start')).toHaveLength(2);
    expectTools(events);
  });

  it('emits each complete call without input-start events', async () => {
    const events = await collect([
      { type: 'tool-call', toolCallId: 'a', toolName: 'Read', input: { path: 'a' } },
      { type: 'tool-call', toolCallId: 'b', toolName: 'Read', input: { path: 'b' } },
      { type: 'finish', finishReason: 'tool-calls' },
    ]);
    expect(events.filter(event => event.type === 'content_block_start')).toHaveLength(2);
    expectTools(events);
  });

  it('parses finalized JSON-string tool inputs', async () => {
    const events = await collect([
      { type: 'tool-call', toolCallId: 'a', toolName: 'Read', input: '{"path":"a"}' },
      { type: 'tool-call', toolCallId: 'b', toolName: 'Read', input: '{"path":"b"}' },
      { type: 'finish', finishReason: 'tool-calls' },
    ]);
    expectTools(events);
  });

  it.each(['{broken', 'null', '[]', '"text"'])('normalizes invalid object input %s through the shared boundary', async input => {
    const events = await collect([
      { type: 'tool-call', toolCallId: 'a', toolName: 'Read', input },
      { type: 'finish', finishReason: 'tool-calls' },
    ]);
    const json = events.filter(event => event.delta?.type === 'input_json_delta')
      .map(event => event.delta?.partial_json).join('');
    expect(JSON.parse(json)).toEqual({});
    expect(events.at(-1)?.type).toBe('message_stop');
  });

  it('flushes every unfinished tool at stream termination', async () => {
    const events = await collect([
      { type: 'tool-input-start', id: 'a', toolName: 'Read' },
      { type: 'tool-input-start', id: 'b', toolName: 'Read' },
      { type: 'tool-input-delta', id: 'a', delta: '{"path":"a"}' },
      { type: 'tool-input-delta', id: 'b', delta: '{"path":"b"}' },
      { type: 'finish', finishReason: 'length' },
    ]);
    expect(events.filter(event => event.type === 'content_block_start')).toHaveLength(2);
    expectTools(events);
  });
});

it('propagates provider errors even when the client is listening to partial output', async () => {
  const failure = new Error('fake provider failure');
  const chunks: string[] = [];
  async function* stream(): AsyncIterable<FullStreamPart> {
    yield { type: 'text-delta', text: 'partial' };
    yield { type: 'error', error: failure };
  }
  await expect(writeAnthropicStream(stream(), 'fake-model', chunk => { chunks.push(chunk); }, undefined, {
    clientAbortSignal: new AbortController().signal,
  })).rejects.toBe(failure);
  expect(chunks.join('')).not.toContain('message_stop');
});

const reasons = [
  ['length', 'max_tokens'], ['tool-calls', 'tool_use'], ['stop', 'end_turn'],
] as const;

describe('Anthropic finish reasons', () => {
  it.each(reasons)('maps streaming %s to %s', async (reason, expected) => {
    const events = await collect([
      { type: 'text-delta', text: 'partial' },
      { type: 'finish', finishReason: reason },
    ]);
    expect(events.find(event => event.type === 'message_delta')?.delta?.stop_reason).toBe(expected);
  });

  it('gives length precedence over emitted tools', async () => {
    const events = await collect([
      { type: 'tool-call', toolCallId: 'a', toolName: 'Read', input: {} },
      { type: 'finish', finishReason: 'length' },
    ]);
    expect(events.find(event => event.type === 'message_delta')?.delta?.stop_reason).toBe('max_tokens');
  });

  describe.each([false, true])('non-stream response with forceStream=%s', forceStream => {
    it.each(reasons)('maps %s to %s', async (reason, expected) => {
      vi.doMock('ai', () => ({
        generateText: vi.fn(async () => ({ text: 'partial', toolCalls: [], finishReason: reason })),
        streamText: vi.fn(() => ({ stream: (async function* () {
          yield { type: 'text-delta', text: 'partial' };
          yield { type: 'finish', finishReason: reason };
        })() })),
      }));
      const { generateAnthropicResponse } = await import('../src/sdk-non-streaming-response.js');
      const response = await generateAnthropicResponse({} as never, { messages: [] }, 'fake-model', { forceStream });
      expect(response.stop_reason).toBe(expected);
    });
  });
});
