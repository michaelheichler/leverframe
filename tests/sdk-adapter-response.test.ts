import { describe, it, expect, vi } from 'vitest';

describe('generateAnthropicResponse', () => {
  it('encodes non-streaming tool-call provider signatures for Gemini round-trip', async () => {
    vi.resetModules();
    const generateText = vi.fn(async (_options: { abortSignal: AbortSignal }) => ({
      text: '',
      toolCalls: [{
        toolCallId: 'call_1',
        toolName: 'Read',
        input: { path: 'a' },
        providerMetadata: { google: { thoughtSignature: 'SIG' } },
      }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    vi.doMock('ai', () => ({
      generateText,
      streamText: vi.fn(),
      tool: vi.fn((spec: unknown) => spec),
      jsonSchema: vi.fn((schema: unknown) => schema),
    }));

    const { generateAnthropicResponse } = await import('../src/sdk-adapter.js');
    const body = await generateAnthropicResponse({} as never, { messages: [] }, 'gemini-2.5-pro');
    const toolUse = (body.content as any[]).find(item => item.type === 'tool_use');
    expect(toolUse.id).toBe('call_1__ts__U0lH');
    expect(generateText.mock.calls[0]![0]).not.toHaveProperty('timeout');
    expect(generateText.mock.calls[0]![0].abortSignal.aborted).toBe(true);

    vi.doUnmock('ai');
    vi.resetModules();
  });

  it('applies schema-aware tool input sanitization to non-stream responses', async () => {
    vi.resetModules();
    const generateText = vi.fn(async () => ({
      text: '',
      toolCalls: [{
        toolCallId: 'call_schema',
        toolName: 'SchemaAware',
        input: {
          nullable_note: null,
          optional_count: null,
          optional_items: [],
          nonempty_items: [],
          unknown_value: null,
        },
      }],
      finishReason: 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    vi.doMock('ai', () => ({
      generateText,
      streamText: vi.fn(),
      tool: vi.fn((spec: unknown) => spec),
      jsonSchema: vi.fn((schema: unknown) => schema),
    }));

    const { generateAnthropicResponse } = await import('../src/sdk-adapter.js');
    const body = await generateAnthropicResponse({} as never, {
      messages: [],
      tools: {
        SchemaAware: {
          inputSchema: {
            jsonSchema: {
              type: 'object',
              properties: {
                nullable_note: { type: ['string', 'null'] },
                optional_count: { type: 'number' },
                optional_items: { type: 'array' },
                nonempty_items: { type: 'array', minItems: 1 },
              },
            },
          },
        } as never,
      },
    }, 'test-model');
    const toolUse = (body.content as Array<{ type: string; input?: unknown }>)
      .find(item => item.type === 'tool_use');
    expect(toolUse?.input).toEqual({
      nullable_note: null,
      optional_items: [],
      unknown_value: null,
    });

    vi.doUnmock('ai');
    vi.resetModules();
  });

  it('normalizes non-stream usage with the same disjoint cache invariant', async () => {
    const cases = [
      [
        { inputTokens: 100, outputTokens: 5 },
        false,
        { input_tokens: 100, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      ],
      [
        {
          inputTokens: 120,
          outputTokens: 3,
          inputTokenDetails: { cacheReadTokens: 20, cacheWriteTokens: 80 },
        },
        true,
        { input_tokens: 20, output_tokens: 3, cache_creation_input_tokens: 80, cache_read_input_tokens: 20 },
      ],
      [
        { inputTokens: 20, outputTokens: 4, inputTokenDetails: { cacheReadTokens: 80 } },
        false,
        { input_tokens: 20, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 80 },
      ],
      [
        {
          inputTokens: 120,
          outputTokens: 4,
          inputTokenDetails: { noCacheTokens: 33, cacheReadTokens: 80 },
        },
        true,
        { input_tokens: 33, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 80 },
      ],
      [
        {
          inputTokens: 80,
          outputTokens: 4,
          inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 80 },
        },
        true,
        { input_tokens: 0, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 80 },
      ],
      [
        {
          inputTokens: Number.NaN,
          outputTokens: -1,
          inputTokenDetails: { cacheReadTokens: -2, cacheWriteTokens: Number.POSITIVE_INFINITY },
        },
        false,
        { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      ],
    ] as const;

    for (const [usage, inputTokensIncludeCache, expected] of cases) {
      vi.resetModules();
      vi.doMock('ai', () => ({
        generateText: vi.fn(async (_options: { abortSignal: AbortSignal }) => ({
          text: 'ok',
          toolCalls: [],
          finishReason: 'stop',
          usage,
        })),
        streamText: vi.fn(),
        tool: vi.fn((spec: unknown) => spec),
        jsonSchema: vi.fn((schema: unknown) => schema),
      }));

      const { generateAnthropicResponse } = await import('../src/sdk-adapter.js');
      const body = await generateAnthropicResponse(
        {} as never,
        { messages: [], inputTokensIncludeCache },
        'test-model',
      );
      expect(body.usage).toEqual(expected);
      vi.doUnmock('ai');
    }
    vi.resetModules();
  });

  it('falls back to a local estimate when usage is entirely absent for real content', async () => {
    vi.resetModules();
    const generateText = vi.fn(async (_options: { abortSignal: AbortSignal }) => ({
      text: 'Here is the answer you asked for.',
      toolCalls: [],
      finishReason: 'stop',
      usage: undefined,
    }));
    vi.doMock('ai', () => ({
      generateText,
      streamText: vi.fn(),
      tool: vi.fn((spec: unknown) => spec),
      jsonSchema: vi.fn((schema: unknown) => schema),
    }));

    const { generateAnthropicResponse } = await import('../src/sdk-adapter.js');
    const body = await generateAnthropicResponse(
      {} as never,
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as never },
      'test-model',
    );
    const usage = body.usage as { input_tokens: number; output_tokens: number };
    expect(usage.input_tokens).toBeGreaterThan(0);
    expect(usage.output_tokens).toBeGreaterThan(0);
    vi.doUnmock('ai');
    vi.resetModules();
  });

  it('forceStream collects a real stream into one response instead of calling generateText', async () => {
    vi.resetModules();
    const generateText = vi.fn();
    async function* stream() {
      yield { type: 'start' };
      yield { type: 'text-delta', text: 'hello' };
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 3, outputTokens: 4 } };
    }
    const result: Record<string, unknown> = { stream: stream() };
    for (const property of ['text', 'toolCalls', 'toolResults', 'finishReason', 'usage']) {
      Object.defineProperty(result, property, {
        get() { throw new Error(`unexpected ${property} getter access`); },
      });
    }
    const streamText = vi.fn((_options: { abortSignal: AbortSignal }) => result);
    vi.doMock('ai', () => ({
      generateText,
      streamText,
      tool: vi.fn((spec: unknown) => spec),
      jsonSchema: vi.fn((schema: unknown) => schema),
    }));

    const { generateAnthropicResponse } = await import('../src/sdk-adapter.js');
    const abort = new AbortController();
    const abortSignalAny = vi.spyOn(AbortSignal, 'any');
    const onPart = vi.fn();
    const body = await generateAnthropicResponse(
      {} as never,
      { messages: [] },
      'gpt-5.6-sol',
      { forceStream: true, abortSignal: abort.signal, onPart },
    );

    expect(generateText).not.toHaveBeenCalled();
    expect(streamText).toHaveBeenCalledOnce();
    expect(streamText.mock.calls[0]![0].abortSignal).toBeInstanceOf(AbortSignal);
    expect(streamText.mock.calls[0]![0]).not.toHaveProperty('timeout');
    expect(abortSignalAny).not.toHaveBeenCalled();
    expect(streamText.mock.calls[0]![0].abortSignal.aborted).toBe(true);
    expect(abort.signal.aborted).toBe(false);
    expect(onPart.mock.calls).toEqual([['start'], ['text-delta'], ['finish']]);
    expect((body.content as any[])[0]).toEqual({ type: 'text', text: 'hello' });
    expect(body.usage).toEqual({
      input_tokens: 3,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    abortSignalAny.mockRestore();

    vi.doUnmock('ai');
    vi.resetModules();
  });

  it('forceStream propagates an SDK error part with its upstream status', async () => {
    vi.resetModules();
    const upstreamError = { statusCode: 401, message: 'Unauthorized' };
    async function* stream() {
      yield { type: 'start' };
      yield { type: 'text-delta', text: 'partial' };
      yield { type: 'error', error: upstreamError };
    }
    const streamText = vi.fn(() => ({ stream: stream() }));
    vi.doMock('ai', () => ({
      generateText: vi.fn(),
      streamText,
      tool: vi.fn((spec: unknown) => spec),
      jsonSchema: vi.fn((schema: unknown) => schema),
    }));

    const { generateAnthropicResponse } = await import('../src/sdk-adapter.js');
    await expect(generateAnthropicResponse(
      {} as never,
      { messages: [] },
      'gpt-5.6-sol',
      { forceStream: true },
    )).rejects.toBe(upstreamError);

    vi.doUnmock('ai');
    vi.resetModules();
  });

  it('forceStream propagates an SDK abort even when lifecycle observation is disabled', async () => {
    vi.resetModules();
    const abort = new AbortController();
    const reason = new Error('Client disconnected');
    async function* stream() {
      yield { type: 'start' };
      abort.abort(reason);
      yield { type: 'abort' };
    }
    const streamText = vi.fn(() => ({
      text: Promise.resolve(''),
      toolCalls: Promise.resolve([]),
      toolResults: Promise.resolve([]),
      finishReason: Promise.resolve('stop'),
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
      stream: stream(),
    }));
    vi.doMock('ai', () => ({
      generateText: vi.fn(),
      streamText,
      tool: vi.fn((spec: unknown) => spec),
      jsonSchema: vi.fn((schema: unknown) => schema),
    }));

    const { generateAnthropicResponse } = await import('../src/sdk-adapter.js');
    await expect(generateAnthropicResponse(
      {} as never,
      { messages: [] },
      'gpt-5.6-sol',
      { forceStream: true, abortSignal: abort.signal },
    )).rejects.toBe(reason);

    vi.doUnmock('ai');
    vi.resetModules();
  });
});
