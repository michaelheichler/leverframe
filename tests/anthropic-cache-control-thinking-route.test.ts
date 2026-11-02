import { afterEach, expect, it, vi } from 'vitest';
import { createModelCatalog, type ServerModelInfo } from '../src/server/models.js';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-thinking-cache-validation');

let server: ServerHandle | undefined;
const gatewayToken = 'fixture-thinking-gateway-sentinel';

afterEach(async () => {
  vi.unstubAllGlobals();
  await server?.close();
  server = undefined;
});

function copilotModel(): ServerModelInfo {
  return {
    id: 'copilot-thinking-fixture', name: 'Copilot thinking fixture', isFree: false, brand: 'Other',
    sourceBackend: 'github-copilot', modelFormat: 'anthropic', providerId: 'github-copilot',
    authType: 'oauth', npm: '@ai-sdk/anthropic', apiKey: 'copilot-token-fixture-sentinel',
  };
}

function thinkingBlock(type: 'thinking' | 'redacted_thinking') {
  return type === 'thinking'
    ? { type, thinking: 'fixture reasoning', signature: 'fixture-signature', cache_control: { type: 'ephemeral' } }
    : { type, data: 'fixture-redacted-reasoning', cache_control: { type: 'ephemeral' } };
}

async function startCopilotServer(): Promise<ServerHandle> {
  server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: gatewayToken, serverPassword: null,
    catalog: createModelCatalog([copilotModel()]),
  });
  return server;
}

it.each(['thinking', 'redacted_thinking'] as const)('rejects a cache marker on %s before translated upstream fetch', async type => {
  const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    id: 'unexpected', type: 'message', role: 'assistant', model: 'copilot-thinking-fixture',
    content: [{ type: 'text', text: 'must not reach upstream' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
  }));
  const clientFetch = globalThis.fetch;
  vi.stubGlobal('fetch', upstream);
  const route = await startCopilotServer();

  const response = await clientFetch(`${route.url}/anthropic/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'copilot-thinking-fixture', max_tokens: 8,
      messages: [
        { role: 'assistant', content: [thinkingBlock(type)] },
        { role: 'user', content: 'offline thinking marker fixture' },
      ],
    }),
  });
  const payload = await response.json() as { error?: { type?: string } };

  expect(response.status).toBe(400);
  expect(payload.error?.type).toBe('invalid_request_error');
  expect(upstream).not.toHaveBeenCalled();
});

it('accepts a null thinking cache control as an absent marker', async () => {
  const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    id: 'fixture-message', type: 'message', role: 'assistant', model: 'copilot-thinking-fixture',
    content: [{ type: 'text', text: 'fixture answer' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
  }));
  const clientFetch = globalThis.fetch;
  vi.stubGlobal('fetch', upstream);
  const route = await startCopilotServer();
  const response = await clientFetch(`${route.url}/anthropic/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'copilot-thinking-fixture', max_tokens: 8,
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'fixture reasoning', signature: 'fixture-signature', cache_control: null }] },
        { role: 'user', content: 'offline null-marker fixture' },
      ],
    }),
  });

  expect(response.status).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(1);
});

it('leaves unsupported thinking markers to native Anthropic passthrough validation', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(new URL(request.url).hostname).toBe('127.0.0.1');
    captured.push(await request.clone().json() as Record<string, unknown>);
    return Response.json({
      id: 'fixture-native-message', type: 'message', role: 'assistant', model: 'anthropic-native-fixture',
      content: [{ type: 'text', text: 'native fixture response' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
  const clientFetch = globalThis.fetch;
  vi.stubGlobal('fetch', upstream);
  server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: gatewayToken, serverPassword: null,
    catalog: createModelCatalog([{
      id: 'anthropic-native-fixture', name: 'Native Anthropic fixture', isFree: false, brand: 'Anthropic',
      sourceBackend: 'anthropic-api', modelFormat: 'anthropic', providerId: 'anthropic-api', authType: 'api',
      apiKey: 'anthropic-api-fixture-sentinel', baseUrl: 'http://127.0.0.1:43123',
    }]),
  });

  const response = await clientFetch(`${server.url}/anthropic/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'anthropic-native-fixture', max_tokens: 8,
      messages: [
        { role: 'assistant', content: [thinkingBlock('thinking')] },
        { role: 'user', content: 'native fixture continuation' },
      ],
    }),
  });

  expect(response.status).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(captured[0]?.messages).toEqual([
    { role: 'assistant', content: [thinkingBlock('thinking')] },
    { role: 'user', content: 'native fixture continuation' },
  ]);
});
