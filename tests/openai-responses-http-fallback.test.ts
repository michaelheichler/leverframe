import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamText } from 'ai';
import { createBuiltinOpenAiModel } from '../src/language-model-builtins.js';
import { createResponsesTransportFetch } from '../src/oauth/responses-transport-fetch.js';

const mocks = vi.hoisted(() => ({ websocket: vi.fn() }));
vi.mock('../src/oauth/responses-websocket.js', () => ({ createResponsesWebSocketFetch: () => mocks.websocket }));

const unsupported = {
  type: 'error', error: { type: 'invalid_request_error',
    message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." },
};
function events(records: unknown[]) {
  return new Response(records.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}
function completion() {
  return events([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg', role: 'assistant' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg', delta: 'OK' },
    { type: 'response.completed', response: { id: 'resp', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, output: [] } },
  ]);
}
afterEach(() => { vi.unstubAllGlobals(); mocks.websocket.mockReset(); });

describe('OpenAI OAuth transport rejection', () => {
  it('retains the requested model when HTTP supports a model rejected by WebSockets', async () => {
    mocks.websocket.mockResolvedValue(events([unsupported]));
    const http = vi.fn().mockResolvedValue(completion());
    vi.stubGlobal('fetch', http);
    const model = await createBuiltinOpenAiModel({
      npm: '@ai-sdk/openai', modelId: 'gpt-6.1-sol', apiKey: 'test-token',
      authType: 'oauth', useResponsesLite: true, preferWebSockets: true,
    }, true);
    const result = streamText({ model, prompt: 'Reply OK.', providerOptions: { openai: { store: false } } });

    expect(await result.text).toBe('OK');
    expect(http).toHaveBeenCalledOnce();
    const [url, init] = http.mock.calls[0]!;
    expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(JSON.parse(init.body).model).toBe('gpt-6.1-sol');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-token');
    expect(new Headers(init.headers).has('x-openai-internal-codex-responses-lite')).toBe(false);
  });

  it.each([
    [completion(), 'model output'],
    [events([{ type: 'response.output_text.delta', delta: 'partial' }, unsupported]), 'partial output'],
    [events([{ type: 'error', error: { type: 'invalid_request_error', message: 'Different failure' } }]), 'another error'],
    [events([{ type: 'response.completed' }]), 'completed response'],
    [events([{ type: 'response.created', padding: 'x'.repeat(65_536) }, unsupported]), 'oversized prefix'],
  ])('does not replay %s (%s)', async response => {
    mocks.websocket.mockResolvedValue(response);
    const http = vi.fn();
    vi.stubGlobal('fetch', http);
    const send = createResponsesTransportFetch('wss://chatgpt.com/backend-api/codex/responses');
    const result = await send('https://chatgpt.com/backend-api/codex/responses', {
      body: JSON.stringify({ model: 'gpt-6.1-sol' }),
    });

    expect(result).toBe(response);
    expect(http).not.toHaveBeenCalled();
    await result.body!.cancel();
  });

  it('preserves aborts and headers when a split event rejects the model', async () => {
    const bytes = new TextEncoder().encode('data: ' + JSON.stringify(unsupported) + '\n\n');
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, 19));
      controller.enqueue(bytes.slice(19));
      controller.close();
    } });
    mocks.websocket.mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    const http = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', http);
    const send = createResponsesTransportFetch('wss://chatgpt.com/backend-api/codex/responses');
    const signal = new AbortController().signal;
    const init = { signal, method: 'POST', body: JSON.stringify({ model: 'gpt-6.1-sol' }), headers: { 'ChatGPT-Account-Id': 'account' } };
    const result = await send('https://chatgpt.com/backend-api/codex/responses', init);

    expect(result.status).toBe(503);
    expect(http).toHaveBeenCalledOnce();
    expect(http.mock.calls[0]![1].signal).toBe(signal);
    expect(http.mock.calls[0]![1].body).toBe(init.body);
    expect(new Headers(http.mock.calls[0]![1].headers).get('ChatGPT-Account-Id')).toBe('account');
  });
});
