import { jsonSchema, streamText, tool } from 'ai';
import { expect, it, vi } from 'vitest';
import { createBuiltinOpenAiModel } from '../src/language-model-builtins.js';

import { upstreamResponsesStream } from './fixtures/chatgpt-plan-responses.js';

it('streams ChatGPT plan inference through the public endpoint with its bearer token', async () => {
  const fetchUpstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => upstreamResponsesStream());
  const model = await createBuiltinOpenAiModel({
    npm: '@ai-sdk/openai', modelId: 'gpt-6.2-sol', apiKey: 'plan-token', authType: 'oauth',
    providerId: 'openai-chatgpt-plan', baseURL: 'https://override.invalid',
    oauthAccountId: 'legacy-account',
    headers: { Authorization: 'Bearer override', originator: 'legacy', version: '0.159.2' },
    fetch: fetchUpstream,
  }, false);

  const parameters = {
    type: 'object',
    properties: { paths: { type: 'array', items: { type: 'string' }, uniqueItems: true } },
  } as const;
  const result = streamText({
    model,
    system: 'Keep responses brief.',
    prompt: 'Hello',
    tools: { Read: tool({ inputSchema: jsonSchema(parameters) }) },
    maxOutputTokens: 20,
    temperature: 0.5,
    providerOptions: { openai: {
      store: true, previousResponseId: 'remote-history', metadata: { source: 'test' },
      instructions: 'Follow the workspace rules.', promptCacheKey: 'session-cache-key',
    } },
    maxRetries: 0,
  });

  await expect(result.text).resolves.toBe('fixture response');
  expect(fetchUpstream).toHaveBeenCalledTimes(1);
  const [input, init] = fetchUpstream.mock.calls[0]!;
  const request = new Request(input, init);
  expect(request.url).toBe('https://api.openai.com/v1/responses');
  expect(request.method).toBe('POST');
  expect(request.redirect).toBe('error');
  expect(request.headers.get('authorization')).toBe('Bearer plan-token');
  expect(request.headers.get('chatgpt-account-id')).toBeNull();
  expect(request.headers.get('originator')).toBeNull();
  expect(request.headers.get('version')).toBeNull();
  expect(request.headers.get('x-openai-internal-codex-responses-lite')).toBeNull();
  const body = await request.json();
  expect(body).toMatchObject({
    model: 'gpt-6.2-sol', stream: true, store: false, prompt_cache_key: 'session-cache-key',
    input: expect.arrayContaining([
      expect.objectContaining({ role: 'developer', content: 'Keep responses brief.' }),
      { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
    ]),
    tools: [{
      type: 'namespace', name: 'claude_code',
      tools: [{ type: 'function', name: 'Read', parameters, strict: false }],
    }],
  });
  expect(body.input[0]).toEqual({
    type: 'message', role: 'developer',
    content: [{ type: 'input_text', text: 'Follow the workspace rules.' }],
  });
  expect(body).not.toHaveProperty('instructions');
  expect(body).not.toHaveProperty('max_output_tokens');
  expect(body).not.toHaveProperty('temperature');
  expect(body).not.toHaveProperty('previous_response_id');
  expect(body).not.toHaveProperty('metadata');
});

it('keeps top-level instructions for earlier ChatGPT plan models', async () => {
  const fetchUpstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => upstreamResponsesStream());
  const model = await createBuiltinOpenAiModel({
    npm: '@ai-sdk/openai', modelId: 'gpt-6.1-terra', apiKey: 'plan-token',
    authType: 'oauth', providerId: 'openai-chatgpt-plan', fetch: fetchUpstream,
  }, true);

  const result = streamText({
    model, prompt: 'Hello', maxRetries: 0,
    providerOptions: { openai: { instructions: 'Follow the workspace rules.' } },
  });

  await expect(result.text).resolves.toBe('fixture response');
  expect(fetchUpstream.mock.calls).toEqual([[
    'https://api.openai.com/v1/responses', expect.objectContaining({ method: 'POST' }),
  ]]);
  const [input, init] = fetchUpstream.mock.calls[0]!;
  await expect(new Request(input, init).json()).resolves.toMatchObject({
    instructions: 'Follow the workspace rules.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
  });
});

it('rejects partial ChatGPT plan output when the upstream stream ends before a terminal event', async () => {
  const fetchUpstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => upstreamResponsesStream('fixture response', false));
  const model = await createBuiltinOpenAiModel({
    npm: '@ai-sdk/openai', modelId: 'gpt-6.2-sol', apiKey: 'plan-token',
    authType: 'oauth', providerId: 'openai-chatgpt-plan', fetch: fetchUpstream,
  }, true);

  const result = streamText({ model, prompt: 'Hello', maxRetries: 0, onError: () => {} });

  await expect(result.text).rejects.toThrow(/terminal event/i);
  expect(fetchUpstream.mock.calls).toEqual([[
    'https://api.openai.com/v1/responses', expect.objectContaining({ method: 'POST' }),
  ]]);
});
