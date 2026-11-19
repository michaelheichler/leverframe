import { randomUUID } from 'node:crypto';
import { generateText, streamText } from 'ai';
import { expect, it } from 'vitest';
import type { ProviderModelSpec } from '../src/language-model-factory.js';
import { upstreamResponsesStream } from './fixtures/chatgpt-plan-responses.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-late-global-fetch');

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
  complete: typeof generateText | typeof streamText;
}>([
  {
    provider: 'ChatGPT plan',
    spec: { npm: '@ai-sdk/openai', modelId: 'gpt-fixture', authType: 'oauth', providerId: 'openai-chatgpt-plan' },
    reply: upstreamResponsesStream,
    complete: streamText,
  },
  {
    provider: 'Anthropic',
    spec: { npm: '@ai-sdk/anthropic', modelId: 'claude-fixture', authType: 'api' },
    reply: anthropicReply,
    complete: generateText,
  },
])('$provider uses the global fetch installed after model creation', async ({ spec, reply, complete }) => {
  const originalFetch = globalThis.fetch;
  const currentReply = 'reply from the transport installed for this request';
  try {
    globalThis.fetch = async () => reply('reply from the obsolete transport');
    const { createLanguageModel } = await import('../src/language-model-factory.js');
    const model = await createLanguageModel({ ...spec, apiKey: randomUUID() });
    globalThis.fetch = async () => reply(currentReply);

    const result = await complete({ model, prompt: 'Hello', maxRetries: 0 });

    expect(await result.text).toBe(currentReply);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
