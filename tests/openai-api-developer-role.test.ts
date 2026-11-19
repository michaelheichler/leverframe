import { streamText } from 'ai';
import { expect, it, vi } from 'vitest';
import { createBuiltinOpenAiModel } from '../src/language-model-builtins.js';
import { translateOpenAiRequest } from '../src/openai-request-translation.js';
import { translateRequest } from '../src/sdk-request-translation.js';

const modelId = 'gpt-6.2-astra';
const instructions = 'Keep responses brief.';
const question = 'Summarize the report.';

async function sendFixtureRequest(
  params: ReturnType<typeof translateRequest>,
  spec?: { baseURL?: string; responses?: boolean },
) {
  const fetchUpstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
    error: { message: 'Fixture rejection' },
  }, { status: 400 }));
  const model = await createBuiltinOpenAiModel({
    npm: '@ai-sdk/openai', authType: 'api', providerId: 'openai',
    modelId, apiKey: 'fixture-key', fetch: fetchUpstream, baseURL: spec?.baseURL,
  }, spec?.responses ?? true);
  const result = streamText({
    model, system: params.instructions, messages: params.messages,
    providerOptions: params.providerOptions as never, maxRetries: 0, onError: () => {},
  });

  await result.consumeStream();
  const requests = fetchUpstream.mock.calls.map(([url, init]) => new Request(url, init));
  return Promise.all(requests.map(async request => ({
    url: request.url, method: request.method, body: await request.json(),
  })));
}

function claudeMessages() {
  return translateRequest({
    model: modelId, system: instructions, messages: [{ role: 'user', content: question }],
  }, '@ai-sdk/openai');
}

function chatCompletions() {
  return translateOpenAiRequest({
    model: modelId, messages: [{ role: 'system', content: instructions }, { role: 'user', content: question }],
  }, { openAiProvider: true });
}

it.each([
  { protocol: 'Claude Messages', request: claudeMessages },
  { protocol: 'Chat Completions', request: chatCompletions },
])('sends $protocol instructions as leading developer input to OpenAI Responses', async ({ request }) => {
  const requests = await sendFixtureRequest(request());

  expect(requests).toEqual([{
    url: 'https://api.openai.com/v1/responses',
    method: 'POST',
    body: expect.objectContaining({
      input: [
        { role: 'developer', content: instructions },
        { role: 'user', content: [{ type: 'input_text', text: question }] },
      ],
    }),
  }]);
  expect(requests[0]?.body).not.toHaveProperty('instructions');
});

it.each([
  {
    endpoint: 'a compatible Responses server',
    spec: { baseURL: 'https://models.example.test/v1' },
    url: 'https://models.example.test/v1/responses',
    payload: { input: [{ role: 'system', content: instructions }, { role: 'user', content: [{ type: 'input_text', text: question }] }] },
  },
  {
    endpoint: 'the OpenAI Chat Completions endpoint',
    spec: { responses: false },
    url: 'https://api.openai.com/v1/chat/completions',
    payload: { messages: [{ role: 'system', content: instructions }, { role: 'user', content: question }] },
  },
])('preserves the existing instruction role for $endpoint', async ({ spec, url, payload }) => {
  const requests = await sendFixtureRequest(chatCompletions(), spec);

  expect(requests).toEqual([{ url, method: 'POST', body: expect.objectContaining(payload) }]);
});
