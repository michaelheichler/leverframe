/** Because marked tool-result content must survive SDK translation at HTTP. */
import { expect, it, vi } from 'vitest';
import { createCopilotHttpLanguageModel } from '../src/copilot/provider.js';
import { generateAnthropicResponse, translateRequest, type AnthropicRequest } from '../src/sdk-adapter.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-anthropic-nested-cache-wire');

const token = 'copilot-oauth-nested-cache-fixture-sentinel';

interface CapturedRequest {
  headers: Headers;
  body: Record<string, unknown>;
}

function successResponse(): Response {
  return Response.json({
    id: 'msg-nested-cache-fixture', type: 'message', role: 'assistant', model: 'claude-nested-cache-fixture',
    content: [{ type: 'text', text: 'fixture response' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

function streamResponse(): Response {
  const events = [
    ['message_start', { type: 'message_start', message: {
      id: 'msg-nested-cache-fixture', type: 'message', role: 'assistant', model: 'claude-nested-cache-fixture',
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
    } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture response' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ] as const;
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function modelWithFetch(fetchImpl: typeof fetch) {
  return createCopilotHttpLanguageModel({
    npm: '@ai-sdk/anthropic', modelId: 'claude-nested-cache-fixture', githubToken: token, fetchImpl,
  });
}

function captureFetch(onRequest: (request: CapturedRequest, body: Record<string, unknown>) => Promise<Response> | Response): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    const body = await request.clone().json() as Record<string, unknown>;
    return onRequest({ headers: new Headers(request.headers), body }, body);
  };
}

async function sendAnthropicRequest(body: AnthropicRequest): Promise<CapturedRequest> {
  let captured: CapturedRequest | undefined;
  const fetchImpl = captureFetch(request => {
    captured = request;
    return successResponse();
  });
  const model = await modelWithFetch(fetchImpl);
  await generateAnthropicResponse(model, translateRequest(body, '@ai-sdk/anthropic'), body.model);

  if (!captured) throw new Error('fake upstream received no request');
  return captured;
}

function nestedToolResult(body: Record<string, unknown>, toolUseId: string) {
  const messages = body['messages'] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  const user = messages.find(message => message.role === 'user');
  return user?.content.find(block => block.type === 'tool_result' && block.tool_use_id === toolUseId);
}

const nestedBody = (): AnthropicRequest => {
  const imageData = 'iVBORw0KGgo=';
  return {
    model: 'claude-nested-cache-fixture', max_tokens: 8,
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_nested', name: 'lookup', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_nested', content: [
        { type: 'text', text: 'nested text first', cache_control: { type: 'ephemeral', ttl: '5m', scope: 'session' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData }, cache_control: { type: 'ephemeral', ttl: '1h', scope: 'session' } },
        { type: 'text', text: 'nested text last' },
      ] }] },
    ],
  } as unknown as AnthropicRequest;
};

function expectedNestedContent() {
  return [
    { type: 'text', text: 'nested text first', cache_control: { type: 'ephemeral', ttl: '5m' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' }, cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: 'nested text last' },
  ];
}

it.each([
  { mode: 'non-streaming', forceStream: false, response: successResponse },
  { mode: 'streaming', forceStream: true, response: streamResponse },
])('preserves ordered nested text and image cache markers for $mode calls', async ({ forceStream, response }) => {
  let captured: CapturedRequest | undefined;
  const fetchImpl = captureFetch(request => {
    captured = request;
    return response();
  });
  const model = await modelWithFetch(fetchImpl);
  const body = nestedBody();
  await generateAnthropicResponse(model, translateRequest(body, '@ai-sdk/anthropic'), body.model, { forceStream });
  const request = captured!;
  const result = nestedToolResult(request.body, 'toolu_nested');

  expect(request.headers.get('authorization')).toBe(`Bearer ${token}`);
  expect(result?.content).toEqual(expectedNestedContent());
  expect(JSON.stringify(request.body)).not.toContain('scope');
  expect(JSON.stringify(request.body)).not.toContain('nativeToolResultContent');
  expect([...request.headers.keys()].some(name => name.includes('nativeToolResultContent'))).toBe(false);
});

it('leaves unmarked nested tool-result content in its existing encoded form', async () => {
  const nestedContent = [{ type: 'text', text: 'unmarked tool output' }];
  const captured = await sendAnthropicRequest({
    model: 'claude-nested-cache-fixture', max_tokens: 8,
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_unmarked', name: 'lookup', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_unmarked', content: nestedContent }] },
    ],
  });

  expect(nestedToolResult(captured.body, 'toolu_unmarked')?.content).toBe(JSON.stringify(nestedContent));
  expect(JSON.stringify(captured.body)).not.toContain('nativeToolResultContent');
});

it('isolates nested cache markers across concurrent calls on one model instance', async () => {
  const captured: CapturedRequest[] = [];
  const fetchImpl = captureFetch(async request => {
    captured.push(request);
    await new Promise(resolve => setTimeout(resolve, 10));
    return successResponse();
  });
  const model = await modelWithFetch(fetchImpl);
  const firstBody: AnthropicRequest = {
    model: 'claude-nested-cache-fixture', max_tokens: 8,
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_first', name: 'lookup', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_first', content: [
        { type: 'text', text: 'first private result', cache_control: { type: 'ephemeral', ttl: '5m' } },
      ] }] },
    ],
  };
  const secondBody: AnthropicRequest = {
    model: 'claude-nested-cache-fixture', max_tokens: 8,
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_second', name: 'lookup', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_second', content: [
        { type: 'text', text: 'second private result', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ] }] },
    ],
  };

  await Promise.all([
    generateAnthropicResponse(model, translateRequest(firstBody, '@ai-sdk/anthropic'), firstBody.model),
    generateAnthropicResponse(model, translateRequest(secondBody, '@ai-sdk/anthropic'), secondBody.model),
  ]);

  expect(captured).toHaveLength(2);
  const first = captured.find(request => nestedToolResult(request.body, 'toolu_first'))!;
  const second = captured.find(request => nestedToolResult(request.body, 'toolu_second'))!;
  expect(nestedToolResult(first.body, 'toolu_first')?.content).toEqual([
    { type: 'text', text: 'first private result', cache_control: { type: 'ephemeral', ttl: '5m' } },
  ]);
  expect(nestedToolResult(second.body, 'toolu_second')?.content).toEqual([
    { type: 'text', text: 'second private result', cache_control: { type: 'ephemeral', ttl: '1h' } },
  ]);
});

it('does not replay an aborted nested-cache stream', async () => {
  const dispatched: CapturedRequest[] = [];
  let signal: AbortSignal | undefined;
  let resolveDispatched: (() => void) | undefined;
  const firstDispatch = new Promise<void>(resolve => { resolveDispatched = resolve; });
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    signal = request.signal;
    dispatched.push({ headers: new Headers(request.headers), body: await request.clone().json() as Record<string, unknown> });
    resolveDispatched?.();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"id":"fixture","type":"message","role":"assistant","model":"claude-nested-cache-fixture","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'));
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const model = await modelWithFetch(fetchImpl);
  const body = nestedBody();
  const abort = new AbortController();
  const pending = generateAnthropicResponse(
    model, translateRequest(body, '@ai-sdk/anthropic'), body.model,
    { forceStream: true, abortSignal: abort.signal, idleTimeoutMs: 5_000 },
  );

  await firstDispatch;
  abort.abort();

  await expect(pending).rejects.toThrow();
  expect(signal?.aborted).toBe(true);
  expect(dispatched).toHaveLength(1);
  expect(nestedToolResult(dispatched[0]!.body, 'toolu_nested')?.content).toEqual(expectedNestedContent());
});

it('fails closed on duplicate tool-result IDs before secure fetch', async () => {
  const upstream = vi.fn<typeof fetch>().mockResolvedValue(successResponse());
  const model = await modelWithFetch(upstream);
  const body: AnthropicRequest = {
    model: 'claude-nested-cache-fixture', max_tokens: 8,
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_duplicate', name: 'lookup', input: {} },
        { type: 'tool_use', id: 'toolu_duplicate', name: 'lookup', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_duplicate', content: [{ type: 'text', text: 'first', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
        { type: 'tool_result', tool_use_id: 'toolu_duplicate', content: [{ type: 'text', text: 'second', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      ] },
    ],
  };

  await expect(generateAnthropicResponse(
    model, translateRequest(body, '@ai-sdk/anthropic'), body.model,
  )).rejects.toThrow(TypeError);
  expect(upstream).not.toHaveBeenCalled();
});
