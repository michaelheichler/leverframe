import { describe, expect, it, vi } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { collectOpenAiStream, generateOpenAiResponse, streamOpenAiResponse, translateOpenAiRequest } from '../src/openai-adapter.js';
import type { OpenAiRequest } from '../src/openai-adapter.js';

const tools: OpenAiRequest['tools'] = [{
  type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
}];
const usage = { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 };

function fakeProvider(finishReason = 'stop', deltas: unknown[] = [{ content: 'ok' }]) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (!body.stream) return Response.json({
      id: 'test', object: 'chat.completion', created: 1, model: 'test',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: finishReason }], usage,
    });
    const chunks = [...deltas.map(delta => ({ choices: [{ index: 0, delta, finish_reason: null }] })),
      { choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage }];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify({ id: 'test', created: 1, model: 'test', ...chunk })}\n\n`).join('') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  return { model: createOpenAI({ apiKey: 'fake-test-key', fetch }).chat('test'), bodies, fetch };
}

async function execute(mode: string, provider: ReturnType<typeof fakeProvider>, request: OpenAiRequest) {
  const params = translateOpenAiRequest(request);
  if (mode === 'stream') {
    const chunks: string[] = [];
    await streamOpenAiResponse(provider.model, params, 'test', chunk => chunks.push(chunk));
    expect(chunks.at(-1)).toBe('data: [DONE]\n\n');
    return chunks.filter(chunk => !chunk.includes('[DONE]')).map(chunk => JSON.parse(chunk.slice(6)));
  }
  return generateOpenAiResponse(provider.model, params, 'test', { forceStream: mode === 'collect' });
}

const modes = ['generate', 'collect', 'stream'];

it.each([false, true])('rejects aborted non-streaming responses (forceStream=%s)', async forceStream => {
  const abort = new AbortController();
  const provider = fakeProvider();
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const response = await provider.fetch(url, init);
    abort.abort(new Error('cancelled during fetch'));
    return response;
  });
  const model = createOpenAI({ apiKey: 'fake-test-key', fetch }).chat('test');
  await expect(generateOpenAiResponse(model, translateOpenAiRequest({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }), 'test', {
    forceStream, abortSignal: abort.signal,
  })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});
describe('OpenAI adapter with installed SDK and injected provider fetch', () => {
  it.each(modes)('preserves disabled tools on the wire (%s)', async mode => {
    const provider = fakeProvider();
    await execute(mode, provider, { model: 'test', messages: [{ role: 'user', content: 'hi' }], tools, tool_choice: 'none' });
    expect(provider.bodies).toHaveLength(1);
    expect(provider.bodies[0].tool_choice).toBe('none');
  });

  it.each(modes)('accepts inline system messages through real SDK validation (%s)', async mode => {
    const provider = fakeProvider();
    await execute(mode, provider, { model: 'test', messages: [
      { role: 'system', content: 'prefix' }, { role: 'user', content: 'first' },
      { role: 'system', content: 'reminder' }, { role: 'user', content: 'second' },
    ] });
    expect(provider.bodies[0].messages).toEqual([
      { role: 'system', content: 'prefix' }, { role: 'user', content: 'first' },
      { role: 'system', content: 'reminder' }, { role: 'user', content: 'second' },
    ]);
  });

  it.each(modes)('serializes text and remote/data images without downloading them (%s)', async mode => {
    const provider = fakeProvider();
    const content = [
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'https://images.invalid/test.png', detail: 'low' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID', detail: 'high' } },
    ];
    await execute(mode, provider, { model: 'test', messages: [{ role: 'user', content }] });
    expect(provider.fetch).toHaveBeenCalledOnce();
    expect(provider.bodies[0].messages).toEqual([{ role: 'user', content }]);
  });

});

describe('OpenAI streamed tools and completion', () => {
  it.each(modes.flatMap(mode => ['stop', 'length', 'tool_calls', 'content_filter'].map(reason => [mode, reason])))('maps finish reasons (%s, %s)', async (mode, reason) => {
    const response = await execute(mode, fakeProvider(reason), { model: 'test', messages: [{ role: 'user', content: 'hi' }] });
    const terminal = Array.isArray(response) ? response.find(chunk => chunk.choices[0]?.finish_reason) : response;
    expect(terminal.choices[0].finish_reason).toBe(reason);
  });

  it('assigns distinct stable indices to interleaved tool arguments', async () => {
    const provider = fakeProvider('tool_calls', [
      { tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] },
      { tool_calls: [{ index: 1, id: 'b', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] },
      { tool_calls: [{ index: 1, function: { arguments: '"B"}' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '"A"}' } }] },
    ]);
    const chunks = await execute('stream', provider, { model: 'test', messages: [{ role: 'user', content: 'hi' }], tools });
    expect(Array.isArray(chunks)).toBe(true);
    const calls = new Map<number, { id: string; args: string }>();
    for (const chunk of chunks as Array<{ choices: Array<{ delta: { tool_calls?: Array<{ index: number; id?: string; function: { arguments: string } }> } }> }>) {
      for (const call of chunk.choices[0]?.delta.tool_calls ?? []) {
        const state = calls.get(call.index) ?? { id: '', args: '' };
        if (call.id) state.id = call.id;
        state.args += call.function.arguments;
        calls.set(call.index, state);
      }
    }
    expect([...calls]).toEqual([[0, { id: 'a', args: '{"q":"A"}' }], [1, { id: 'b', args: '{"q":"B"}' }]]);
  });

});

describe('OpenAI SDK terminal events', () => {
  it('emits distinct complete calls without input-start events', async () => {
    const model = new MockLanguageModelV4({ doStream: async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
        const parts: LanguageModelV4StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'a', toolName: 'lookup', input: '{"q":"A"}' },
        { type: 'tool-call', toolCallId: 'b', toolName: 'lookup', input: '{"q":"B"}' },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: {
          inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 3, text: 3, reasoning: 0 },
        } },
        ];
        for (const part of parts) controller.enqueue(part);
        controller.close();
      } }),
    }) });
    const chunks: string[] = [];
    await streamOpenAiResponse(model, translateOpenAiRequest({ model: 'test', messages: [{ role: 'user', content: 'hi' }], tools }), 'test', chunk => chunks.push(chunk));
    const calls = chunks.filter(chunk => !chunk.includes('[DONE]')).flatMap(chunk => JSON.parse(chunk.slice(6)).choices[0]?.delta.tool_calls ?? []);
    expect(calls).toEqual([
      { index: 0, id: 'a', type: 'function', function: { name: 'lookup', arguments: '{"q":"A"}' } },
      { index: 1, id: 'b', type: 'function', function: { name: 'lookup', arguments: '{"q":"B"}' } },
    ]);
  });

  it('rejects an SDK abort event instead of collecting partial success', async () => {
    async function* parts() {
      yield { type: 'text-delta', text: 'partial' };
      yield { type: 'abort', reason: 'cancelled' };
    }
    await expect(collectOpenAiStream(parts())).rejects.toThrow();
  });

  it('rejects cancellation during actual SDK streaming without DONE or success finish', async () => {
    const provider = fakeProvider();
    const abort = new AbortController();
    const chunks: string[] = [];
    await expect(streamOpenAiResponse(provider.model, translateOpenAiRequest({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }), 'test', chunk => {
      chunks.push(chunk);
      if (chunk.includes('"content":"ok"')) abort.abort(new Error('cancelled'));
    }, { abortSignal: abort.signal })).rejects.toThrow('cancelled');
    expect(chunks.join('')).not.toContain('[DONE]');
    expect(chunks.join('')).not.toContain('"finish_reason":"stop"');
  });
});
