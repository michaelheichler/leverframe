import { describe, it, expect, vi } from 'vitest';
import {
  translateRequest,
  writeAnthropicStream,
  streamAnthropicResponse,
  extractClaudeSessionId,
  claudeSessionPromptCacheKey,
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

describe('streamAnthropicResponse idle timeout', () => {
  it('consumes only the stream without touching lazy aggregate getters', async () => {
    vi.resetModules();
    async function* stream() {
      yield { type: 'start' };
      yield { type: 'text-start', id: 't1' };
      yield { type: 'text-delta', id: 't1', text: 'ok' };
      yield { type: 'text-end', id: 't1' };
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } };
    }
    const result: Record<string, unknown> = { stream: stream() };
    for (const property of ['text', 'toolCalls', 'toolResults', 'finishReason', 'usage']) {
      Object.defineProperty(result, property, {
        get() { throw new Error(`unexpected ${property} getter access`); },
      });
    }
    const streamText = vi.fn((_options: { abortSignal: AbortSignal }) => result);
    vi.doMock('ai', () => ({
      generateText: vi.fn(),
      streamText,
      tool: vi.fn((spec: unknown) => spec),
      jsonSchema: vi.fn((schema: unknown) => schema),
    }));

    const { streamAnthropicResponse } = await import('../src/sdk-adapter.js');
    await streamAnthropicResponse({} as never, { messages: [] }, 'test-model', () => {});
    expect(streamText).toHaveBeenCalledOnce();
    expect(streamText.mock.calls[0]![0]).not.toHaveProperty('timeout');
    expect(streamText.mock.calls[0]![0].abortSignal.aborted).toBe(true);

    vi.doUnmock('ai');
    vi.resetModules();
  });

  it('aborts an upstream that never produces its first stream event', async () => {
    const hangingModel = {
      specificationVersion: 'v3' as const,
      provider: 'test',
      modelId: 'test-model',
      supportedUrls: {},
      async doStream(options: { abortSignal?: AbortSignal }) {
        return new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => {
            reject(options.abortSignal?.reason ?? new DOMException('Aborted', 'AbortError'));
          });
        });
      },
      async doGenerate(): Promise<never> {
        throw new Error('not used');
      },
    };

    await expect(streamAnthropicResponse(
      hangingModel as never,
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as never },
      'test-model',
      () => {},
      undefined,
      { idleTimeoutMs: 50 },
    )).rejects.toThrow('no data received from provider');
  }, 10_000);
});

describe('streamAnthropicResponse output-idle watchdog', () => {
  it('rejects with output_stall_timeout when tool-input deltas keep arriving but no output reaches the client', async () => {
    vi.resetModules();
    const streamTextMock = vi.fn((options: { abortSignal: AbortSignal }) => {
      async function* gen() {
        yield { type: 'start' };
        yield { type: 'tool-input-start', id: 'call_1', toolName: 'Write' };
        yield { type: 'tool-input-delta', id: 'call_1', delta: '{"path":"x"' };
        await new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener('abort', () => reject(options.abortSignal.reason));
        });
      }
      return { stream: gen() };
    });
    vi.doMock('ai', () => ({
      generateText: vi.fn(),
      streamText: streamTextMock,
      tool: vi.fn((spec: unknown) => spec),
      jsonSchema: vi.fn((schema: unknown) => schema),
    }));

    const { streamAnthropicResponse: freshStreamAnthropicResponse } = await import('../src/sdk-adapter.js');
    await expect(freshStreamAnthropicResponse(
      {} as never,
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as never },
      'test-model',
      () => {},
      undefined,
      { idleTimeoutMs: 10_000, outputIdleTimeoutMs: 50 },
    )).rejects.toMatchObject({ category: 'output_stall_timeout', retryable: true });

    vi.doUnmock('ai');
    vi.resetModules();
  }, 10_000);

  it('does not trip while reasoning-deltas keep arriving within the watchdog window', async () => {
    vi.resetModules();
    const streamTextMock = vi.fn(() => {
      async function* gen() {
        yield { type: 'start' };
        for (let i = 0; i < 4; i++) {
          await new Promise(resolve => setTimeout(resolve, 20));
          yield { type: 'reasoning-delta', id: 'r1', text: `thinking ${i}` };
        }
        yield { type: 'reasoning-end', id: 'r1' };
        yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } };
      }
      return { stream: gen() };
    });
    vi.doMock('ai', () => ({
      generateText: vi.fn(),
      streamText: streamTextMock,
      tool: vi.fn((spec: unknown) => spec),
      jsonSchema: vi.fn((schema: unknown) => schema),
    }));

    const { streamAnthropicResponse: freshStreamAnthropicResponse } = await import('../src/sdk-adapter.js');
    let raw = '';
    await expect(freshStreamAnthropicResponse(
      {} as never,
      { messages: [] },
      'test-model',
      chunk => { raw += chunk; },
      undefined,
      { outputIdleTimeoutMs: 50 },
    )).resolves.toBeUndefined();
    expect(raw).toContain('thinking 0');

    vi.doUnmock('ai');
    vi.resetModules();
  }, 10_000);
});

describe('translateRequest openai promptCacheKey', () => {
  const READ_TOOL = { name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } };
  const req = (over: Partial<Parameters<typeof translateRequest>[0]> = {}) => ({
    model: 'gpt-5.5',
    system: 'You are a coding assistant.',
    messages: [{ role: 'user' as const, content: 'hello' }],
    tools: [READ_TOOL],
    ...over,
  });
  const keyOf = (body: Parameters<typeof translateRequest>[0], npm = '@ai-sdk/openai', opts?: Parameters<typeof translateRequest>[2]) =>
    translateRequest(body, npm, opts).providerOptions?.openai?.promptCacheKey as string | undefined;

  it('sets a stable key for the API-key OpenAI path; identical prefix → identical key', () => {
    const a = keyOf(req());
    const b = keyOf(req());
    expect(typeof a).toBe('string');
    expect(a).toBe(b);
  });

  it('changes the key when the top-level system prompt differs (distinct sessions)', () => {
    expect(keyOf(req({ system: 'date: 2026-07-12' }))).not.toBe(keyOf(req({ system: 'date: 2026-07-13' })));
  });

  it('changes the key when the tool set differs', () => {
    const write = { ...READ_TOOL, name: 'Write' };
    expect(keyOf(req({ tools: [READ_TOOL] }))).not.toBe(keyOf(req({ tools: [READ_TOOL, write] })));
  });

  it('keeps the key stable across volatile inline system-reminders (within-session turns)', () => {

    const withReminder = (t: string) => req({
      messages: [
        { role: 'system' as const, content: `<system-reminder>current time ${t}</system-reminder>` },
        { role: 'user' as const, content: 'hello' },
      ],
    });
    expect(keyOf(withReminder('10:00:01'))).toBe(keyOf(withReminder('10:05:42')));
  });

  it('sends a session-derived key but omits risky cache options on ChatGPT/Codex OAuth', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const params = translateRequest({
      ...req(),
      model: 'gpt-5.6-sol',
      metadata: { user_id: JSON.stringify({ session_id: sessionId, device_id: 'private' }) },
    }, '@ai-sdk/openai', {
      openAiOAuth: true,
      reasoningMetadata: { upstreamModelId: 'gpt-5.6-sol' },
    });
    expect(params.providerOptions?.openai?.promptCacheKey).toBe(claudeSessionPromptCacheKey(sessionId));
    expect(params.providerOptions?.openai?.promptCacheOptions).toBeUndefined();
  });

  it('uses the body session before the header and falls back safely on malformed metadata', () => {
    const bodySession = '11111111-1111-4111-8111-111111111111';
    const headerSession = '22222222-2222-4222-8222-222222222222';
    expect(extractClaudeSessionId({
      metadata: { user_id: JSON.stringify({ session_id: bodySession }) },
    }, headerSession)).toBe(bodySession);
    expect(extractClaudeSessionId({ metadata: { user_id: '{bad json' } }, headerSession)).toBe(headerSession);
    expect(extractClaudeSessionId({ metadata: { user_id: JSON.stringify({ session_id: 'not-a-uuid' }) } })).toBeUndefined();
  });

  it('keeps a Claude session key stable across system/tool changes', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const options = { openAiOAuth: true, claudeSessionId: sessionId };
    expect(keyOf(req({ system: 'first' }), '@ai-sdk/openai', options))
      .toBe(keyOf(req({ system: 'second', tools: [] }), '@ai-sdk/openai', options));
  });

  it('omits the key for non-OpenAI providers', () => {
    expect(keyOf(req(), '@ai-sdk/xai')).toBeUndefined();
  });
});

describe('writeAnthropicStream usage propagation', () => {
  const textParts = [
    { type: 'start' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', text: 'ok' },
    { type: 'text-end', id: 't1' },
  ];
  const byEvent = (events: Awaited<ReturnType<typeof collect>>['events'], name: string) =>
    events.filter(e => e.event === name);

  it('replaces the message_start estimate with provider usage in message_delta', async () => {
    const { events } = await collect(
      [...textParts, {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 239_000, outputTokens: 10, cachedInputTokens: 100_000 },
      }],
      'gpt-5.6-terra',
      { initialInputTokens: 297_000, inputTokensIncludeCache: true },
    );
    const finalUsage = byEvent(events, 'message_delta').at(-1)!.data.usage;
    expect(finalUsage.input_tokens).toBe(139_000);
    expect(finalUsage.cache_read_input_tokens).toBe(100_000);
    expect(finalUsage.input_tokens + finalUsage.cache_read_input_tokens).toBe(239_000);
  });

  it('keeps the estimate when the finish part carries no input usage', async () => {
    const { events } = await collect(
      [...textParts, {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { outputTokens: 10 },
      }],
      'gpt-5.6-terra',
      { initialInputTokens: 297_000, inputTokensIncludeCache: true },
    );
    const finalUsage = byEvent(events, 'message_delta').at(-1)!.data.usage;
    expect(finalUsage.input_tokens).toBe(297_000);
    expect(finalUsage.output_tokens).toBe(10);
  });

  it('falls back to a local output estimate when totalUsage omits outputTokens', async () => {
    const { events } = await collect([
      { type: 'start' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'a much longer completion than the malformed-usage case' },
      { type: 'text-end', id: 't1' },
      { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 100 } },
    ], 'm', { initialInputTokens: 37 });

    const finalUsage = byEvent(events, 'message_delta').at(-1)!.data.usage;
    expect(finalUsage.input_tokens).toBe(100);
    expect(finalUsage.output_tokens).toBeGreaterThan(0);
  });
});
