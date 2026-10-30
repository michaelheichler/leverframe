import { afterEach, expect, it, vi } from 'vitest';
import { generateText } from 'ai';
import { createLanguageModel } from '../src/language-model-factory.js';
import { extractClaudeSessionId, translateRequest } from '../src/sdk-request-translation.js';
import { neutralClientInstructions } from '../src/neutral-client-request.js';
import { openCodeGoHeaders } from '../src/opencode-go-headers.js';
import { generateAnthropicResponse } from '../src/sdk-non-streaming-response.js';

afterEach(() => vi.restoreAllMocks());

it('sends low effort and a stable fallback session on the Go Chat Completions wire', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
    id: 'chatcmpl_test', created: 1, model: 'deepseek-v4.1-flash', object: 'chat.completion',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
  const model = await createLanguageModel({
    npm: '@ai-sdk/openai-compatible', modelId: 'deepseek-v4.1-flash', apiKey: 'go-key',
    providerId: 'opencode-go', baseURL: 'https://opencode.ai/zen/go/v1',
  });
  const params = translateRequest({ model: 'deepseek-v4.1-flash', system: 'You are Claude Code.',
    messages: [{ role: 'user', content: 'Reply OK' }] }, '@ai-sdk/openai-compatible', {
    defaultEffort: 'low', reasoningMetadata: { providerId: 'opencode-go',
      reasoning: true, supportedReasoningEfforts: ['low', 'high', 'max'] },
  });
  await generateAnthropicResponse(model, params, 'deepseek-v4.1-flash');
  await generateAnthropicResponse(model, params, 'deepseek-v4.1-flash');
  const [url, request] = fetchMock.mock.calls[0];
  expect(String(url)).toBe('https://opencode.ai/zen/go/v1/chat/completions');
  const payload = JSON.parse(String(request?.body));
  expect(payload.reasoning_effort).toBe('low');
  expect(payload.messages[0].content).not.toContain('Claude Code');
  const headers = new Headers(request?.headers);
  expect(headers.get('user-agent')).toContain('leverframe/');
  expect(headers.get('x-opencode-session')).toBeTruthy();
  expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('x-opencode-session'))
    .toBe(headers.get('x-opencode-session'));
});

it('keeps the configured Responses destination and authentication headers', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
    id: 'resp_test', created_at: 1, model: 'gpt-test', status: 'completed',
    output: [{ id: 'msg_test', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'OK', annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  const model = await createLanguageModel({
    npm: '@ai-sdk/openai', modelId: 'gpt-test', apiKey: 'go-test-key',
    providerId: 'opencode-go', baseURL: 'https://opencode.ai/zen/go/v1',
    headers: { 'x-test-route': 'go', 'X-App': 'cli' },
  });

  await generateText({ model, prompt: 'Reply OK', maxRetries: 0 });

  const [url, request] = fetchMock.mock.calls[0];
  expect(String(url)).toBe('https://opencode.ai/zen/go/v1/responses');
  const headers = new Headers(request?.headers);
  expect(headers.get('authorization')).toBe('Bearer go-test-key');
  expect(headers.get('x-test-route')).toBe('go');
  expect(headers.get('x-app')).toBeNull();
  expect(headers.get('x-opencode-session')).toBeTruthy();
  expect(headers.get('user-agent')).toContain('leverframe/');
});

it('recovers legacy session metadata and sends low effort to Go', () => {
  const session = '11111111-1111-4111-8111-111111111111';
  const body = { model: 'deepseek-v4.1-flash', messages: [],
    metadata: { user_id: `user_abc_account_example_session_${session}` } };
  expect(extractClaudeSessionId(body)).toBe(session);
  const translated = translateRequest(body, '@ai-sdk/openai-compatible', {
    defaultEffort: 'low', reasoningMetadata: { providerId: 'opencode-go',
      reasoning: true, supportedReasoningEfforts: ['low', 'high', 'max'] },
  });
  expect(translated.headers?.['x-opencode-session']).toBe(session);
  expect(translated.providerOptions?.opencodeGo).toEqual({ reasoningEffort: 'low' });
});

it.each(['@ai-sdk/openai-compatible', '@ai-sdk/openai', '@ai-sdk/google'])(
  'neutralizes %s instructions without changing user data', npm => {
    const identity = 'You are Claude Code.\nUse Claude Code tools to help the user.';
    const body = { model: 'test', system: identity,
      messages: [{ role: 'user' as const, content: identity }] };
    const translated = translateRequest(body, npm);
    expect(translated.instructions).not.toContain('Claude Code');
    expect(translated.instructions).toContain('verify');
    expect(translated.messages[0].content).toEqual([{ type: 'text', text: identity }]);
    expect(body.system).toBe(identity);
    expect(neutralClientInstructions(neutralClientInstructions(body))).toEqual(neutralClientInstructions(body));
  },
);

it.each(['chat/completions', 'responses', 'messages'])('supplies Go identity for %s', endpoint => {
  const url = `https://opencode.ai/zen/go/v1/${endpoint}`;
  const initial = openCodeGoHeaders(url, { 'X-OpenCode-Session': 'conversation-1' });
  expect(initial?.['x-opencode-session']).toBe('conversation-1');
  expect(initial?.['user-agent']).toContain('leverframe/');
  expect(openCodeGoHeaders(url, initial, 'conversation-2')?.['x-opencode-session']).toBe('conversation-2');
  expect(openCodeGoHeaders('https://example.com/v1', { 'x-test': 'keep' })).toEqual({ 'x-test': 'keep' });
});

it.each(['null', '[]', '{', 'user_abc_account_test_session_invalid'])(
  'uses the validated header when session metadata is %s', userId => {
    const session = '11111111-1111-4111-8111-111111111111';
    expect(extractClaudeSessionId({ metadata: { user_id: userId } }, session)).toBe(session);
    expect(extractClaudeSessionId({ metadata: { user_id: userId } }, 'unsafe\r\nheader')).toBeUndefined();
  },
);
