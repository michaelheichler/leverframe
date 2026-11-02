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
    usage: { prompt_tokens: 1_200, completion_tokens: 300, total_tokens: 1_500, ...usage },
  });
}

function streamedCompletion(usageChunks: Record<string, unknown>[]) {
  const frames = [
    { id: 'chatcmpl_fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { id: 'chatcmpl_fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'fixture reply' }, finish_reason: null }] },
    { id: 'chatcmpl_fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ...usageChunks.map(usage => ({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', choices: [],
      usage: { prompt_tokens: 1_200, completion_tokens: 300, total_tokens: 1_500, ...usage } })),
  ];
  return new Response(`${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function requestParams() {
  return translateRequest({
    model: 'fixture-model', messages: [{ role: 'user', content: 'fixture prompt' }],
  }, '@ai-sdk/openai-compatible');
}

async function createGoModel(fetchImpl: typeof fetch, baseURL = 'https://opencode.ai/zen/go/v1') {
  return createLanguageModel({
    npm: '@ai-sdk/openai-compatible', modelId: 'fixture-model', apiKey: 'fixture-sentinel',
    providerId: 'fixture', baseURL, authType: 'api', fetch: fetchImpl,
  });
}

async function runRawJsonUsage(usage: Record<string, unknown>, baseURL = 'https://opencode.ai/zen/go/v1') {
  const fetchImpl = vi.fn(async () => completion(usage));
  const model = await createGoModel(fetchImpl as typeof fetch, baseURL);
  const result = await generateText({ model, prompt: 'fixture prompt' });
  return result.usage;
}

async function runRawStreamUsage(usageChunks: Record<string, unknown>[], baseURL = 'https://opencode.ai/zen/go/v1') {
  const fetchImpl = vi.fn(async () => streamedCompletion(usageChunks));
  const model = await createGoModel(fetchImpl as typeof fetch, baseURL);
  const result = streamText({ model, prompt: 'fixture prompt' });
  return result.totalUsage;
}

async function runJsonAudit(usage: Record<string, unknown>) {
  const fetchImpl = vi.fn(async () => completion(usage));
  const model = await createGoModel(fetchImpl as typeof fetch);
  const audit: AnthropicUsageTrace[] = [];
  await generateAnthropicResponse(model, requestParams(), 'fixture-model', { onUsage: value => audit.push(value) });
  return audit;
}

async function runStreamAudit(usageChunks: Record<string, unknown>[]) {
  const fetchImpl = vi.fn(async () => streamedCompletion(usageChunks));
  const model = await createGoModel(fetchImpl as typeof fetch);
  const audit: AnthropicUsageTrace[] = [];
  await generateAnthropicResponse(model, requestParams(), 'fixture-model', {
    forceStream: true, onUsage: value => audit.push(value),
  });
  return audit;
}

function goUsageWithoutInput(cacheRead: number) {
  return {
    opencode: { tokens: { output: 300, reasoning: 120, cache_read: cacheRead, cache_write_5m: 0, cache_write_1h: 0 } },
  };
}

it.each([8_000, 800])('leaves JSON Go total and uncached input unknown when input is absent (%s read tokens)', async cacheRead => {
  const usage = await runRawJsonUsage(goUsageWithoutInput(cacheRead));

  expect(usage.inputTokens).toBeUndefined();
  expect(usage.inputTokenDetails).toMatchObject({
    noCacheTokens: undefined, cacheReadTokens: cacheRead, cacheWriteTokens: 0,
  });
});

it.each([8_000, 800])('leaves streamed Go total and uncached input unknown when input is absent (%s read tokens)', async cacheRead => {
  const usage = await runRawStreamUsage([goUsageWithoutInput(cacheRead)]);

  expect((await usage).inputTokens).toBeUndefined();
  expect((await usage).inputTokenDetails).toMatchObject({
    noCacheTokens: undefined, cacheReadTokens: cacheRead, cacheWriteTokens: 0,
  });
});

it.each([8_000, 800])('omits unknown Go uncached input from JSON usage audit (%s read tokens)', async cacheRead => {
  const audit = await runJsonAudit(goUsageWithoutInput(cacheRead));

  expect(audit).toEqual([{
    model: 'fixture-model', output_tokens: 300,
    cache_creation_input_tokens: 0, cache_creation_5m_input_tokens: 0,
    cache_creation_1h_input_tokens: 0, cache_read_input_tokens: cacheRead,
  }]);
});

it.each([8_000, 800])('omits unknown Go uncached input from streamed usage audit (%s read tokens)', async cacheRead => {
  const audit = await runStreamAudit([goUsageWithoutInput(cacheRead)]);

  expect(audit).toEqual([{
    model: 'fixture-model', output_tokens: 300,
    cache_creation_input_tokens: 0, cache_creation_5m_input_tokens: 0,
    cache_creation_1h_input_tokens: 0, cache_read_input_tokens: cacheRead,
  }]);
});

it('recovers the Go input total when a later stream frame supplies uncached input', async () => {
  const usage = await runRawStreamUsage([
    { opencode: { tokens: { output: 300, reasoning: 120, cache_read: 8_000, cache_write_5m: 0, cache_write_1h: 0 } } },
    { opencode: { tokens: { input: 1_200, output: 300, reasoning: 120 } } },
  ]);

  expect((await usage).inputTokens).toBe(9_200);
  expect((await usage).inputTokenDetails).toMatchObject({
    noCacheTokens: 1_200, cacheReadTokens: 8_000, cacheWriteTokens: 0,
  });
});

it('treats zero uncached Go input as known usage', async () => {
  const usage = await runRawJsonUsage({
    opencode: { tokens: { input: 0, output: 300, reasoning: 120, cache_read: 8_000, cache_write_5m: 0, cache_write_1h: 0 } },
  });

  expect(usage.inputTokens).toBe(8_000);
  expect(usage.inputTokenDetails).toMatchObject({
    noCacheTokens: 0, cacheReadTokens: 8_000, cacheWriteTokens: 0,
  });
});

it.each([null, 'malformed', []])('does not infer uncached usage from malformed Go token partitions (%s)', async tokens => {
  const usage = await runRawJsonUsage({
    prompt_tokens: 1_200, completion_tokens: 300, total_tokens: 1_500,
    opencode: { tokens },
  });

  expect(usage.inputTokens).toBeUndefined();
  expect(usage.inputTokenDetails.noCacheTokens).toBeUndefined();
});

it('retains a standard cached read without using it to complete a Go partition', async () => {
  const usage = await runRawJsonUsage({
    prompt_tokens_details: { cached_tokens: 37 },
    opencode: { tokens: { input: 1_200, output: 300, reasoning: 120, cache_write_5m: 0, cache_write_1h: 0 } },
  });

  expect(usage.inputTokens).toBeUndefined();
  expect(usage.inputTokenDetails).toMatchObject({
    noCacheTokens: 1_200, cacheReadTokens: 37, cacheWriteTokens: 0,
  });
});

it('retains a standard cached read without completing a Go partition in a stream', async () => {
  const usage = await runRawStreamUsage([{
    prompt_tokens_details: { cached_tokens: 37 },
    opencode: { tokens: { input: 1_200, output: 300, reasoning: 120, cache_write_5m: 0, cache_write_1h: 0 } },
  }]);

  expect((await usage).inputTokens).toBeUndefined();
  expect((await usage).inputTokenDetails).toMatchObject({
    noCacheTokens: 1_200, cacheReadTokens: 37, cacheWriteTokens: 0,
  });
});

it.each([
  ['Go without extended counters', 'https://opencode.ai/zen/go/v1', {
    prompt_tokens: 1_200, completion_tokens: 300, total_tokens: 1_500,
    prompt_tokens_details: { cached_tokens: 37 },
  }],
  ['a different endpoint with Go-shaped counters', 'https://fixture.invalid/v1', {
    prompt_tokens: 1_200, completion_tokens: 300, total_tokens: 1_500,
    opencode: { tokens: { input: 80, output: 300, cache_read: 8_000, cache_write_5m: 0, cache_write_1h: 0 } },
  }],
])('keeps the standard SDK total for %s', async (_case, baseURL, usageData) => {
  const usage = await runRawJsonUsage(usageData, baseURL);

  expect(usage.inputTokens).toBe(1_200);
});
