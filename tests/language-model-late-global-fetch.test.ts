import { randomUUID } from 'node:crypto';
import { generateText } from 'ai';
import { expect, it } from 'vitest';
import type { ProviderModelSpec } from '../src/language-model-factory.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-late-global-fetch');

function openAiReply(text: string): Response {
  return Response.json({
    id: 'chat-fixture', object: 'chat.completion', created: 1, model: 'gpt-fixture',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function anthropicReply(text: string): Response {
  return Response.json({
    id: 'message-fixture', type: 'message', role: 'assistant', model: 'claude-fixture',
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

it.each<{
  provider: string;
  spec: Omit<ProviderModelSpec, 'apiKey'>;
  reply: (text: string) => Response;
}>([
  {
    provider: 'OpenAI OAuth',
    spec: { npm: '@ai-sdk/openai', modelId: 'gpt-fixture', authType: 'oauth', openAiEndpoint: 'chat' },
    reply: openAiReply,
  },
  {
    provider: 'Anthropic',
    spec: { npm: '@ai-sdk/anthropic', modelId: 'claude-fixture', authType: 'api' },
    reply: anthropicReply,
  },
])('$provider uses the global fetch installed after model creation', async ({ spec, reply }) => {
  const originalFetch = globalThis.fetch;
  const currentReply = 'reply from the transport installed for this request';
  try {
    globalThis.fetch = async () => reply('reply from the obsolete transport');
    const { createLanguageModel } = await import('../src/language-model-factory.js');
    const model = await createLanguageModel({ ...spec, apiKey: randomUUID() });
    globalThis.fetch = async () => reply(currentReply);

    const result = await generateText({ model, prompt: 'Hello', maxRetries: 0 });

    expect(result.text).toBe(currentReply);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
