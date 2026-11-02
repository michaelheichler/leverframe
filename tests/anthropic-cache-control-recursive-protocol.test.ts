import { afterEach, expect, it, vi } from 'vitest';
import { createCopilotHttpLanguageModel } from '../src/copilot/provider.js';
import { generateAnthropicResponse, translateRequest, type AnthropicRequest } from '../src/sdk-adapter.js';
import { createGatewayModelCatalog, type ServerModelInfo } from '../src/server/models.js';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

const fetchSlot = vi.hoisted(() => ({ current: undefined as typeof fetch | undefined }));

vi.mock('../src/provider-factory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/provider-factory.js')>();
  return {
    ...actual,
    createLanguageModel: vi.fn(async (spec: { apiKey: string; modelId: string }) => {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({
        apiKey: spec.apiKey,
        baseURL: 'https://api.anthropic.fixture/v1',
        fetch: (...args) => fetchSlot.current!(...args),
      })(spec.modelId);
    }),
  };
});

useIsolatedTestHome('leverframe-anthropic-recursive-cache-controls');

const modelId = 'claude-recursive-cache-fixture';
const clientToken = 'recursive-cache-client-sentinel';
const accountToken = 'recursive-cache-provider-sentinel';
let server: ServerHandle | undefined;

afterEach(async () => {
  fetchSlot.current = undefined;
  await server?.close();
  server = undefined;
  vi.clearAllMocks();
});

function copilotModel(): ServerModelInfo {
  return {
    id: modelId, name: 'fixture Copilot Claude', isFree: false, brand: 'Other',
    sourceBackend: 'github-copilot', modelFormat: 'anthropic', providerId: 'github-copilot',
    authType: 'oauth', npm: '@ai-sdk/anthropic', apiKey: accountToken,
  };
}

async function startRoute(): Promise<ServerHandle> {
  server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: clientToken, serverPassword: null,
    catalog: createGatewayModelCatalog([copilotModel()]),
  });
  return server;
}

function successResponse(): Response {
  return Response.json({
    id: 'msg-recursive-cache-fixture', type: 'message', role: 'assistant', model: modelId,
    content: [{ type: 'text', text: 'fixture answer' }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

async function postMessages(body: Record<string, unknown>) {
  const upstream = vi.fn<typeof fetch>().mockResolvedValue(successResponse());
  fetchSlot.current = upstream;
  const route = await startRoute();
  const response = await fetch(`${route.url}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${clientToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelId, max_tokens: 8, ...body }),
  });
  return { response, upstream };
}

const invalidSystemBlocks = [
  {
    label: 'marked system document block',
    system: [{
      type: 'document', title: 'Fixture document',
      source: { type: 'text', media_type: 'text/plain', data: 'fixture document text' },
      cache_control: { type: 'ephemeral', ttl: '5m' },
    }],
  },
  { label: 'marked system text without text content', system: [{ type: 'text', cache_control: { type: 'ephemeral' } }] },
  { label: 'marked empty system text', system: [{ type: 'text', text: '', cache_control: { type: 'ephemeral' } }] },
] as const;

it.each(invalidSystemBlocks)('rejects a $label before the SDK upstream', async ({ system }) => {
  const { response, upstream } = await postMessages({
    system,
    messages: [{ role: 'user', content: 'fixture prompt' }],
  });
  const payload = await response.json() as { error?: { type?: string } };

  expect(response.status).toBe(400);
  expect(payload.error?.type).toBe('invalid_request_error');
  expect(upstream).not.toHaveBeenCalled();
});

it('rejects malformed cache controls inside documented nested content before fetch', async () => {
  const { response, upstream } = await postMessages({
    messages: [{ role: 'user', content: [{
      type: 'document', title: 'Fixture document',
      source: { type: 'content', content: [{
        type: 'text', text: 'fixture excerpt', cache_control: { type: 'persistent' },
      }] },
    }] }],
  });
  const payload = await response.json() as { error?: { type?: string } };

  expect(response.status).toBe(400);
  expect(payload.error?.type).toBe('invalid_request_error');
  expect(upstream).not.toHaveBeenCalled();
});

interface CapturedRequest {
  headers: Headers;
  body: Record<string, unknown>;
}

function nestedSearchAndDocumentRequest(): AnthropicRequest {
  return {
    model: modelId,
    max_tokens: 8,
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'assistant', content: [{
        type: 'tool_use', id: 'toolu_recursive', name: 'lookup',
        input: { cache_control: { type: 'ephemeral', ttl: '1h', scope: 'user-data' } },
      }] },
      { role: 'user', content: [{
        type: 'tool_result', tool_use_id: 'toolu_recursive', content: [
          {
            type: 'search_result', title: 'Fixture search result', source: 'https://fixture.invalid/search',
            content: [{ type: 'text', text: 'nested search excerpt', cache_control: { type: 'ephemeral', ttl: '5m', scope: 'session' } }],
          },
          {
            type: 'document', title: 'Fixture content document',
            source: { type: 'content', content: [
              { type: 'text', text: 'document excerpt', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'request' } },
              { type: 'text', text: 'unmarked continuation' },
            ] },
          },
        ],
      }] },
    ],
  } as unknown as AnthropicRequest;
}

function topLevelSearchAndDocumentRequest(): AnthropicRequest {
  return {
    model: modelId,
    max_tokens: 8,
    messages: [{ role: 'user', content: [
      {
        type: 'search_result', title: 'Fixture top-level search', source: 'https://fixture.invalid/top-level-search',
        content: [{ type: 'text', text: 'top-level search excerpt', cache_control: { type: 'ephemeral', ttl: '5m', scope: 'session' } }],
      },
      {
        type: 'document', title: 'Fixture top-level document',
        source: { type: 'content', content: [
          { type: 'text', text: 'top-level document excerpt', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'request' } },
          { type: 'text', text: 'unmarked continuation' },
        ] },
      },
    ] }],
  } as unknown as AnthropicRequest;
}

function nestedToolResult(request: CapturedRequest): Record<string, unknown> | undefined {
  const messages = request.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  return messages.find(message => message.role === 'user')?.content
    .find(block => block.type === 'tool_result' && block.tool_use_id === 'toolu_recursive');
}

it('preserves cache controls only in documented nested protocol content fields', async () => {
  let captured: CapturedRequest | undefined;
  const model = await createCopilotHttpLanguageModel({
    npm: '@ai-sdk/anthropic', modelId, githubToken: accountToken,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      captured = { headers: new Headers(request.headers), body: await request.clone().json() as Record<string, unknown> };
      return successResponse();
    },
  });
  const body = nestedSearchAndDocumentRequest();

  await generateAnthropicResponse(model, translateRequest(body, '@ai-sdk/anthropic'), modelId);

  const result = nestedToolResult(captured!);
  expect(result?.content).toEqual([
    {
      type: 'search_result', title: 'Fixture search result', source: 'https://fixture.invalid/search',
      content: [{ type: 'text', text: 'nested search excerpt', cache_control: { type: 'ephemeral', ttl: '5m' } }],
    },
    {
      type: 'document', title: 'Fixture content document',
      source: { type: 'content', content: [
        { type: 'text', text: 'document excerpt', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'unmarked continuation' },
      ] },
    },
  ]);
  expect((captured!.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content[0]!.input)
    .toEqual({ cache_control: { type: 'ephemeral', ttl: '1h', scope: 'user-data' } });
  expect(JSON.stringify(captured!.body)).not.toContain('nativeToolResultContent');
  expect([...captured!.headers.keys()].some(name => name.includes('nativeToolResultContent'))).toBe(false);
});

it('removes scope only from child markers in top-level user search and document blocks', async () => {
  let captured: CapturedRequest | undefined;
  const model = await createCopilotHttpLanguageModel({
    npm: '@ai-sdk/anthropic', modelId, githubToken: accountToken,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      captured = { headers: new Headers(request.headers), body: await request.clone().json() as Record<string, unknown> };
      return successResponse();
    },
  });
  const body = topLevelSearchAndDocumentRequest();

  await generateAnthropicResponse(model, translateRequest(body, '@ai-sdk/anthropic'), modelId);

  const messages = captured!.body.messages as Array<{ role: string; content: unknown[] }>;
  expect(messages.find(message => message.role === 'user')?.content).toEqual([
    {
      type: 'search_result', title: 'Fixture top-level search', source: 'https://fixture.invalid/top-level-search',
      content: [{ type: 'text', text: 'top-level search excerpt', cache_control: { type: 'ephemeral', ttl: '5m' } }],
    },
    {
      type: 'document', title: 'Fixture top-level document',
      source: { type: 'content', content: [
        { type: 'text', text: 'top-level document excerpt', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'unmarked continuation' },
      ] },
    },
  ]);
  expect(JSON.stringify(captured!.body)).not.toContain('scope');
  expect(JSON.stringify(captured!.body)).not.toContain('nativeToolResultContent');
});
