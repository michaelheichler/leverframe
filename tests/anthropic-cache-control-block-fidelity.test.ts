import { expect, it } from 'vitest';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createCopilotHttpLanguageModel } from '../src/copilot/provider.js';
import { generateAnthropicResponse, translateRequest, type AnthropicRequest } from '../src/sdk-adapter.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-anthropic-cache-block-fidelity');

const modelId = 'claude-cache-block-fixture';
const githubToken = 'copilot-cache-block-fixture-sentinel';

interface CapturedRequest {
  headers: Headers;
  body: Record<string, unknown>;
}

function successResponse(): Response {
  return Response.json({
    id: 'msg-cache-block-fixture', type: 'message', role: 'assistant', model: modelId,
    content: [{ type: 'text', text: 'fixture response' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

function streamResponse(): Response {
  const events = [
    ['message_start', { type: 'message_start', message: {
      id: 'msg-cache-block-fixture', type: 'message', role: 'assistant', model: modelId,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
    } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture response' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function captureFetch(host: string, reply: () => Response | Promise<Response>, requests: CapturedRequest[]): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    expect(new URL(request.url).hostname).toBe(host);
    requests.push({ headers: new Headers(request.headers), body: await request.clone().json() as Record<string, unknown> });
    return reply();
  };
}

async function createManagedModel(fetchImpl: typeof fetch) {
  return createCopilotHttpLanguageModel({
    npm: '@ai-sdk/anthropic', modelId, githubToken,
    fetchImpl,
  });
}

async function sendManaged(body: AnthropicRequest, stream = false): Promise<CapturedRequest[]> {
  const requests: CapturedRequest[] = [];
  const model = await createManagedModel(captureFetch(
    'api.githubcopilot.com', stream ? streamResponse : successResponse, requests,
  ));
  await generateAnthropicResponse(model, translateRequest(body, '@ai-sdk/anthropic'), modelId,
    stream ? { forceStream: true } : undefined);
  return requests;
}

function toolResultRequest(content: unknown[]): AnthropicRequest {
  return {
    model: modelId, max_tokens: 8,
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_special', name: 'lookup', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_special', content }] },
    ],
  } as unknown as AnthropicRequest;
}

const specialBlocks = [
  {
    name: 'document',
    input: { type: 'document', title: 'Fixture document', source: { type: 'text', media_type: 'text/plain', data: 'document body' }, cache_control: { type: 'ephemeral', ttl: '1h', scope: 'request' } },
    expected: { type: 'document', title: 'Fixture document', source: { type: 'text', media_type: 'text/plain', data: 'document body' }, cache_control: { type: 'ephemeral', ttl: '1h' } },
  },
  {
    name: 'search_result',
    input: { type: 'search_result', title: 'Fixture search result', source: 'https://fixture.invalid/result', content: 'search body', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'request' } },
    expected: { type: 'search_result', title: 'Fixture search result', source: 'https://fixture.invalid/result', content: 'search body', cache_control: { type: 'ephemeral', ttl: '1h' } },
  },
  {
    name: 'tool_reference',
    input: { type: 'tool_reference', tool_name: 'mcp__fixture__lookup', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'request' } },
    expected: { type: 'tool_reference', tool_name: 'mcp__fixture__lookup', cache_control: { type: 'ephemeral', ttl: '1h' } },
  },
] as const;

function toolResultContent(request: CapturedRequest): unknown {
  const messages = request.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  return messages.find(message => message.role === 'user')?.content
    .find(block => block.type === 'tool_result' && block.tool_use_id === 'toolu_special')?.content;
}

it.each(specialBlocks)('preserves a nested $name marker in a non-streaming SDK request', async ({ input, expected }) => {
  const requests = await sendManaged(toolResultRequest([input]));

  expect(requests).toHaveLength(1);
  expect(requests[0]!.headers.get('authorization')).toBe(`Bearer ${githubToken}`);
  expect(toolResultContent(requests[0]!)).toEqual([expected]);
  expect(JSON.stringify(requests[0]!.body)).not.toContain('scope');
  expect(JSON.stringify(requests[0]!.body)).not.toContain('nativeToolResultContent');
  expect(JSON.stringify(requests[0]!.body)).not.toContain('"leverframe"');
});

it.each(specialBlocks)('preserves a nested $name marker in a streaming SDK request', async ({ input, expected }) => {
  const requests = await sendManaged(toolResultRequest([input]), true);

  expect(requests).toHaveLength(1);
  expect(toolResultContent(requests[0]!)).toEqual([expected]);
  expect(JSON.stringify(requests[0]!.body)).not.toContain('scope');
});

const plainDocument = {
  type: 'document', title: 'Fixture document',
  source: { type: 'text', media_type: 'text/plain', data: 'document body' },
};
const plainSearchResult = {
  type: 'search_result', title: 'Fixture result',
  source: 'https://fixture.invalid/result', content: 'search body',
};
const topLevelUserCases = [
  {
    label: 'without cache controls', body: {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Use retrieved context.' }, plainDocument, plainSearchResult] }],
    },
    expectedContent: [{ type: 'text', text: 'Use retrieved context.' }, plainDocument, plainSearchResult],
  },
  {
    label: 'with automatic cache control', body: {
      cache_control: { type: 'ephemeral' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Use retrieved context.' }, plainDocument, plainSearchResult] }],
    },
    expectedContent: [{ type: 'text', text: 'Use retrieved context.' }, plainDocument, plainSearchResult],
  },
  {
    label: 'with explicit block cache controls', body: {
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Use retrieved context.' },
        { ...plainDocument, cache_control: { type: 'ephemeral', ttl: '5m', scope: 'request' } },
        { ...plainSearchResult, cache_control: { type: 'ephemeral', ttl: '1h', scope: 'request' } },
      ] }],
    },
    expectedContent: [
      { type: 'text', text: 'Use retrieved context.' },
      { ...plainDocument, cache_control: { type: 'ephemeral', ttl: '5m' } },
      { ...plainSearchResult, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
  },
] as const;

it.each(topLevelUserCases)('preserves top-level user documents and search results $label', async ({ body, expectedContent }) => {
  const request = { model: modelId, max_tokens: 8, ...body } as unknown as AnthropicRequest;
  const requests = await sendManaged(request);
  const messages = requests[0]?.body.messages as Array<{ role: string; content: unknown[] }> | undefined;

  expect(requests).toHaveLength(1);
  expect(messages?.find(message => message.role === 'user')?.content).toEqual(expectedContent);
  expect(JSON.stringify(requests[0]?.body)).not.toContain('scope');
  expect(JSON.stringify(requests[0]?.body)).not.toContain('nativeToolResultContent');
});

it.each(topLevelUserCases)('preserves top-level user documents and search results while streaming $label', async ({ body, expectedContent }) => {
  const requests = await sendManaged({ model: modelId, max_tokens: 8, ...body } as unknown as AnthropicRequest, true);
  const messages = requests[0]?.body.messages as Array<{ role: string; content: unknown[] }> | undefined;

  expect(messages?.find(message => message.role === 'user')?.content).toEqual(expectedContent);
  expect(JSON.stringify(requests[0]?.body)).not.toContain('nativeToolResultContent');
});

function topLevelDocumentRequest(text: string, ttl: '5m' | '1h'): AnthropicRequest {
  return {
    model: modelId, max_tokens: 8,
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'Use this fixture document.' },
      { type: 'document', title: `${text} document`, source: { type: 'text', media_type: 'text/plain', data: text },
        cache_control: { type: 'ephemeral', ttl } },
    ] }],
  } as unknown as AnthropicRequest;
}

it('isolates concurrent top-level document markers on one managed model', async () => {
  const requests: CapturedRequest[] = [];
  const fetchImpl = captureFetch('api.githubcopilot.com', async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return successResponse();
  }, requests);
  const model = await createManagedModel(fetchImpl);
  const first = topLevelDocumentRequest('first result', '5m');
  const second = topLevelDocumentRequest('second result', '1h');

  await Promise.all([
    generateAnthropicResponse(model, translateRequest(first, '@ai-sdk/anthropic'), modelId),
    generateAnthropicResponse(model, translateRequest(second, '@ai-sdk/anthropic'), modelId),
  ]);

  expect(requests).toHaveLength(2);
  const firstBody = requests.find(request => JSON.stringify(request.body).includes('first result'))!.body;
  const secondBody = requests.find(request => JSON.stringify(request.body).includes('second result'))!.body;
  expect(JSON.stringify(firstBody)).toContain('"ttl":"5m"');
  expect(JSON.stringify(firstBody)).not.toContain('"ttl":"1h"');
  expect(JSON.stringify(secondBody)).toContain('"ttl":"1h"');
  expect(JSON.stringify(secondBody)).not.toContain('"ttl":"5m"');
});

it('rejects nested special-block cache markers before an external SDK model can fetch', async () => {
  const requests: CapturedRequest[] = [];
  const directModel = createAnthropic({
    apiKey: 'direct-anthropic-fixture-sentinel', baseURL: 'https://api.anthropic.fixture/v1',
    fetch: captureFetch('api.anthropic.fixture', successResponse, requests),
  })(modelId);

  await expect(generateAnthropicResponse(
    directModel, translateRequest(toolResultRequest([specialBlocks[0]!.input]), '@ai-sdk/anthropic'), modelId,
  )).rejects.toThrow(/managed transport/);
  expect(requests).toEqual([]);
});

it('rejects top-level user document markers before an external SDK model can fetch', async () => {
  const requests: CapturedRequest[] = [];
  const directModel = createAnthropic({
    apiKey: 'direct-anthropic-fixture-sentinel', baseURL: 'https://api.anthropic.fixture/v1',
    fetch: captureFetch('api.anthropic.fixture', successResponse, requests),
  })(modelId);

  await expect(generateAnthropicResponse(
    directModel,
    translateRequest(topLevelDocumentRequest('external document', '1h'), '@ai-sdk/anthropic'),
    modelId,
  )).rejects.toThrow(/managed transport/);
  expect(requests).toEqual([]);
});
