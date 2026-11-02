import { afterEach, expect, it, vi } from 'vitest';
import { generateText, streamText } from 'ai';
import { createLanguageModel } from '../src/language-model-factory.js';
import { generateAnthropicResponse } from '../src/sdk-non-streaming-response.js';
import { translateRequest } from '../src/sdk-request-translation.js';
import type { AnthropicUsageTrace } from '../src/sdk-usage.js';

vi.mock('../src/registry/url-security.js', () => ({
  revalidateCustomEndpointUrl: vi.fn(async () => ({ ok: true })),
}));

afterEach(() => vi.restoreAllMocks());

function completion(usage: Record<string, unknown>) {
  return Response.json({
    id: 'chatcmpl_fixture', object: 'chat.completion', created: 1, model: 'fixture-model',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'fixture reply' } }],
    usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, ...usage },
  });
}

function requestParams(prompt: string) {
  return translateRequest({
    model: 'fixture-model', messages: [{ role: 'user', content: prompt }],
  }, '@ai-sdk/openai-compatible');
}

async function runJsonUsage(usage: Record<string, unknown>, baseURL = 'https://fixture.invalid/v1') {
  const fetchImpl = vi.fn(async () => completion(usage));
  const model = await createLanguageModel({
    npm: '@ai-sdk/openai-compatible', modelId: 'fixture-model', apiKey: 'fixture-sentinel',
    providerId: 'fixture', baseURL, authType: 'api', fetch: fetchImpl as typeof fetch,
  });
  const audit: AnthropicUsageTrace[] = [];
  const result = await generateAnthropicResponse(model, requestParams('fixture prompt'), 'fixture-model', {
    onUsage: value => audit.push(value),
  });
  return { result, audit, fetchImpl };
}

function streamedCompletion(usageChunks: Record<string, unknown>[]) {
  const frames = [
    { id: 'chatcmpl_fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { id: 'chatcmpl_fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'fixture reply' }, finish_reason: null }] },
    { id: 'chatcmpl_fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ...usageChunks.map(usage => ({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, ...usage } })),
  ];
  return new Response(`${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function runStreamUsage(usageChunks: Record<string, unknown>[], baseURL: string) {
  const fetchImpl = vi.fn(async () => streamedCompletion(usageChunks));
  const model = await createLanguageModel({
    npm: '@ai-sdk/openai-compatible', modelId: 'fixture-model', apiKey: 'fixture-sentinel',
    providerId: 'fixture', baseURL, authType: 'api', fetch: fetchImpl as typeof fetch,
  });
  const audit: AnthropicUsageTrace[] = [];
  const result = await generateAnthropicResponse(model, requestParams('fixture prompt'), 'fixture-model', {
    forceStream: true, onUsage: value => audit.push(value),
  });
  return { result, audit, fetchImpl };
}

async function createOpenCodeModel(fetchImpl: typeof fetch, baseURL = 'https://opencode.ai/zen/go/v1') {
  return createLanguageModel({
    npm: '@ai-sdk/openai-compatible', modelId: 'fixture-model', apiKey: 'fixture-sentinel',
    providerId: 'fixture', baseURL, authType: 'api', fetch: fetchImpl,
  });
}

function openCodeSampleUsage() {
  return {
    prompt_tokens: 1_200, completion_tokens: 300, total_tokens: 1_500,
    opencode: { tokens: {
      input: 1_200, output: 300, reasoning: 120, cache_read: 8_000, cache_write_5m: 0, cache_write_1h: 0,
    } },
  };
}

it('keeps absent cache counters unknown in measured usage while preserving wire defaults', async () => {
  const { result, audit, fetchImpl } = await runJsonUsage({});

  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(audit).toEqual([{ model: 'fixture-model', output_tokens: 5 }]);
  expect(result.usage).toMatchObject({
    input_tokens: 100, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  });
});

it('preserves an explicit zero cache read as measured provider usage', async () => {
  const { audit } = await runJsonUsage({ prompt_tokens_details: { cached_tokens: 0 } });

  expect(audit).toEqual([{
    model: 'fixture-model', output_tokens: 5, cache_read_input_tokens: 0,
  }]);
});

it('reports standard cached input tokens as measured reads', async () => {
  const { audit, result } = await runJsonUsage({ prompt_tokens_details: { cached_tokens: 37 } });

  expect(audit).toEqual([{
    model: 'fixture-model', output_tokens: 5, cache_read_input_tokens: 37,
  }]);
  expect(result.usage).toMatchObject({ cache_read_input_tokens: 37 });
});

it('keeps absent standard cache counters unknown in streamed measurements', async () => {
  const { audit, result } = await runStreamUsage([{}], 'https://fixture.invalid/v1');

  expect(audit).toEqual([{ model: 'fixture-model', output_tokens: 5 }]);
  expect(result.usage).toMatchObject({ cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
});

it('preserves an explicit zero standard cache read in streamed measurements', async () => {
  const { audit } = await runStreamUsage([
    { prompt_tokens_details: { cached_tokens: 0 } },
  ], 'https://fixture.invalid/v1');

  expect(audit).toEqual([{
    model: 'fixture-model', output_tokens: 5, cache_read_input_tokens: 0,
  }]);
});

it('reports standard cached reads from streamed usage', async () => {
  const { audit } = await runStreamUsage([
    { prompt_tokens_details: { cached_tokens: 37 } },
  ], 'https://fixture.invalid/v1');

  expect(audit).toEqual([{
    model: 'fixture-model', output_tokens: 5, cache_read_input_tokens: 37,
  }]);
});

it('maps documented OpenCode Go counters through the real compatible SDK response path', async () => {
  const { audit, result } = await runJsonUsage({
    opencode: { tokens: {
      input: 80, output: 5, reasoning: 3, cache_read: 20, cache_write_5m: 4, cache_write_1h: 6,
    } },
  }, 'https://opencode.ai/zen/go/v1');

  expect(audit).toEqual([{
    model: 'fixture-model', input_tokens: 80, output_tokens: 5,
    cache_creation_input_tokens: 10, cache_creation_5m_input_tokens: 4,
    cache_creation_1h_input_tokens: 6, cache_read_input_tokens: 20,
  }]);
  expect(result.usage).toMatchObject({
    input_tokens: 80, output_tokens: 5, cache_creation_input_tokens: 10, cache_read_input_tokens: 20,
  });
});

it('uses the documented OpenCode Go output counter when the standard output count is absent', async () => {
  const { audit } = await runJsonUsage({
    completion_tokens: undefined,
    opencode: { tokens: { input: 80, output: 5, reasoning: 3 } },
  }, 'https://opencode.ai/zen/go/v1');

  expect(audit).toEqual([{ model: 'fixture-model', input_tokens: 80, output_tokens: 5 }]);
});

it('keeps the documented OpenCode Go usage partition when gateway and chat totals differ', async () => {
  const { audit, result } = await runJsonUsage({
    prompt_tokens: 1_200, completion_tokens: 300, total_tokens: 1_500,
    opencode: { tokens: {
      input: 1_200, output: 300, reasoning: 120, cache_read: 8_000, cache_write_5m: 0, cache_write_1h: 0,
    } },
  }, 'https://opencode.ai/zen/go/v1');

  expect(audit).toEqual([{
    model: 'fixture-model', input_tokens: 1_200, output_tokens: 300,
    cache_creation_input_tokens: 0, cache_creation_5m_input_tokens: 0,
    cache_creation_1h_input_tokens: 0, cache_read_input_tokens: 8_000,
  }]);
  expect(result.usage).toMatchObject({
    input_tokens: 1_200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 8_000,
  });
});

it('does not infer an OpenCode Go cache write when one TTL counter is absent', async () => {
  const { audit } = await runJsonUsage({
    opencode: { tokens: { input: 80, output: 5, cache_read: 20, cache_write_5m: 4 } },
  }, 'https://opencode.ai/zen/go/v1');

  expect(audit).toEqual([{
    model: 'fixture-model', input_tokens: 80, output_tokens: 5,
    cache_creation_5m_input_tokens: 4, cache_read_input_tokens: 20,
  }]);
});

it('maps Kimi Platform cache reads and writes only on its documented API endpoint', async () => {
  const { audit, result } = await runJsonUsage({
    prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 6 },
  }, 'https://api.moonshot.ai/v1');

  expect(audit).toEqual([{
    model: 'fixture-model', input_tokens: 74, output_tokens: 5,
    cache_creation_input_tokens: 6, cache_read_input_tokens: 20,
  }]);
  expect(result.usage).toMatchObject({
    input_tokens: 74, cache_creation_input_tokens: 6, cache_read_input_tokens: 20,
  });
});

it('maps OpenCode Go cache reads and TTL writes on the final streaming usage frame', async () => {
  const { audit, result, fetchImpl } = await runStreamUsage([{
    opencode: { tokens: {
      input: 80, output: 5, reasoning: 3, cache_read: 20, cache_write_5m: 4, cache_write_1h: 6,
    } },
  }], 'https://opencode.ai/zen/go/v1');

  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(audit).toEqual([{
    model: 'fixture-model', input_tokens: 80, output_tokens: 5,
    cache_creation_input_tokens: 10, cache_creation_5m_input_tokens: 4,
    cache_creation_1h_input_tokens: 6, cache_read_input_tokens: 20,
  }]);
  expect(result.usage).toMatchObject({ cache_creation_input_tokens: 10, cache_read_input_tokens: 20 });
  expect(result.usage).not.toHaveProperty('cache_creation_5m_input_tokens');
  expect(result.usage).not.toHaveProperty('cache_creation_1h_input_tokens');
});

it('uses the OpenCode Go output counter when the standard output count is absent in a stream', async () => {
  const { audit } = await runStreamUsage([{
    completion_tokens: undefined,
    opencode: { tokens: { input: 80, output: 5, reasoning: 3 } },
  }], 'https://opencode.ai/zen/go/v1');

  expect(audit).toEqual([{ model: 'fixture-model', input_tokens: 80, output_tokens: 5 }]);
});

it('keeps the documented OpenCode Go usage partition when gateway and chat totals differ in a stream', async () => {
  const { audit, result } = await runStreamUsage([{
    prompt_tokens: 1_200, completion_tokens: 300, total_tokens: 1_500,
    opencode: { tokens: {
      input: 1_200, output: 300, reasoning: 120, cache_read: 8_000, cache_write_5m: 0, cache_write_1h: 0,
    } },
  }], 'https://opencode.ai/zen/go/v1');

  expect(audit).toEqual([{
    model: 'fixture-model', input_tokens: 1_200, output_tokens: 300,
    cache_creation_input_tokens: 0, cache_creation_5m_input_tokens: 0,
    cache_creation_1h_input_tokens: 0, cache_read_input_tokens: 8_000,
  }]);
  expect(result.usage).toMatchObject({
    input_tokens: 1_200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 8_000,
  });
});

it('includes OpenCode Go cached reads and writes in the public SDK total input count', async () => {
  const fetchImpl = vi.fn(async () => completion(openCodeSampleUsage()));
  const model = await createOpenCodeModel(fetchImpl as typeof fetch);

  const result = await generateText({ model, prompt: 'fixture prompt' });

  expect(result.usage.inputTokens).toBe(9_200);
  expect(result.usage.inputTokenDetails).toMatchObject({
    noCacheTokens: 1_200, cacheReadTokens: 8_000, cacheWriteTokens: 0,
  });
});

it('includes OpenCode Go cached reads and writes in the streamed SDK total input count', async () => {
  const fetchImpl = vi.fn(async () => streamedCompletion([openCodeSampleUsage()]));
  const model = await createOpenCodeModel(fetchImpl as typeof fetch);

  const result = streamText({ model, prompt: 'fixture prompt' });
  const usage = await result.totalUsage;

  expect(usage.inputTokens).toBe(9_200);
  expect(usage.inputTokenDetails).toMatchObject({
    noCacheTokens: 1_200, cacheReadTokens: 8_000, cacheWriteTokens: 0,
  });
});

it('merges partial OpenCode Go usage frames before measuring the complete cache write', async () => {
  const { audit } = await runStreamUsage([
    { opencode: { tokens: { input: 80, cache_read: 20, cache_write_5m: 4 } } },
    { opencode: { tokens: { output: 5, reasoning: 3, cache_write_1h: 6 } } },
  ], 'https://opencode.ai/zen/go/v1');

  expect(audit).toEqual([{
    model: 'fixture-model', input_tokens: 80, output_tokens: 5,
    cache_creation_5m_input_tokens: 4, cache_creation_1h_input_tokens: 6,
    cache_creation_input_tokens: 10, cache_read_input_tokens: 20,
  }]);
});

it('retains the known OpenCode Go write TTL when the other write duration is absent', async () => {
  const { audit } = await runJsonUsage({
    opencode: { tokens: { input: 80, output: 5, cache_read: 20, cache_write_1h: 6 } },
  }, 'https://opencode.ai/zen/go/v1');

  expect(audit).toEqual([{
    model: 'fixture-model', input_tokens: 80, output_tokens: 5,
    cache_creation_1h_input_tokens: 6, cache_read_input_tokens: 20,
  }]);
});

it('ignores malformed and negative OpenCode Go cache counters instead of reporting measurements', async () => {
  const { audit } = await runJsonUsage({
    opencode: { tokens: { input: -2, output: '5', cache_read: 20.5, cache_write_5m: 4 } },
  }, 'https://opencode.ai/zen/go/v1');

  expect(audit).toEqual([{
    model: 'fixture-model', output_tokens: 5, cache_creation_5m_input_tokens: 4,
  }]);
});

it('does not derive uncached input when valid cache counts exceed the reported total', async () => {
  const { audit } = await runJsonUsage({
    prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 9, cache_write_tokens: 5 },
  }, 'https://api.moonshot.ai/v1');

  expect(audit).toEqual([{
    model: 'fixture-model', output_tokens: 5,
    cache_creation_input_tokens: 5, cache_read_input_tokens: 9,
  }]);
});

it.each([
  ['Kimi Code', 'https://api.kimi.com/coding/v1'],
  ['Z.AI Coding Plan', 'https://api.z.ai/api/coding/paas/v4'],
])('does not apply OpenCode Go usage extensions to the %s endpoint', async (_backend, baseURL) => {
  const { audit } = await runJsonUsage({
    opencode: { tokens: {
      input: 80, output: 5, reasoning: 3, cache_read: 20, cache_write_5m: 4, cache_write_1h: 6,
    } },
  }, baseURL);

  expect(audit).toEqual([{ model: 'fixture-model', output_tokens: 5 }]);
});

it('keeps authorization and caller route headers intact through cache accounting', async () => {
  const fetchImpl = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => completion({}));
  const model = await createLanguageModel({
    npm: '@ai-sdk/openai-compatible', modelId: 'fixture-model', apiKey: 'sentinel-secret',
    providerId: 'fixture', baseURL: 'https://fixture.invalid/v1', authType: 'api',
    headers: { 'x-fixture-route': 'trusted-route' }, fetch: fetchImpl as typeof fetch,
  });

  await generateAnthropicResponse(model, requestParams('fixture prompt'), 'fixture-model');

  const request = fetchImpl.mock.calls[0]![1];
  const headers = new Headers(request?.headers);
  expect(headers.get('authorization')).toBe('Bearer sentinel-secret');
  expect(headers.get('x-fixture-route')).toBe('trusted-route');
});

it('isolates cache counters between concurrent calls through one compatible model', async () => {
  const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const cacheRead = request.messages.some(message => message.content === 'read-path') ? 11 : 42;
    return completion({
      opencode: { tokens: { input: 80, output: 5, cache_read: cacheRead, cache_write_5m: 0, cache_write_1h: 0 } },
    });
  });
  const model = await createOpenCodeModel(fetchImpl as typeof fetch);

  const [readPath, otherPath] = await Promise.all([
    generateText({ model, prompt: 'read-path' }),
    generateText({ model, prompt: 'other-path' }),
  ]);

  expect(readPath.usage.inputTokenDetails.cacheReadTokens).toBe(11);
  expect(otherPath.usage.inputTokenDetails.cacheReadTokens).toBe(42);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it('aborts a streaming compatible request without starting another upstream attempt', async () => {
  const fetchImpl = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('fixture aborted', 'AbortError')), { once: true });
  }));
  const model = await createLanguageModel({
    npm: '@ai-sdk/openai-compatible', modelId: 'fixture-model', apiKey: 'fixture-sentinel',
    providerId: 'fixture', baseURL: 'https://fixture.invalid/v1', authType: 'api', fetch: fetchImpl as typeof fetch,
  });
  const controller = new AbortController();
  const pending = generateAnthropicResponse(model, requestParams('fixture prompt'), 'fixture-model', {
    forceStream: true, abortSignal: controller.signal, idleTimeoutMs: 2_000,
  }).then(value => value, error => error);

  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
  controller.abort();
  const outcome = await pending;

  expect(outcome).toBeInstanceOf(Error);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
