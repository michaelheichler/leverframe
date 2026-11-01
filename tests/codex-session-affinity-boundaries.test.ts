import { expect, it } from 'vitest';
import { translateRequest } from '../src/sdk-adapter.js';

const request = {
  model: 'gpt-5.6-sol', system: 'You are a coding assistant.',
  messages: [{ role: 'user' as const, content: 'Inspect the request path.' }],
  metadata: { user_id: JSON.stringify({ session_id: '11111111-1111-4111-8111-111111111111' }) },
};

it('does not add OAuth session affinity headers to API key requests', () => {
  const params = translateRequest(request, '@ai-sdk/openai');

  expect(params.headers?.['session-id']).toBeUndefined();
});

it('preserves the OpenCode session header without adding OAuth session affinity', () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const params = translateRequest({ ...request, metadata: undefined }, '@ai-sdk/openai', {
    claudeSessionId: sessionId, reasoningMetadata: { providerId: 'opencode-go' },
  });

  expect(params.headers).toEqual({ 'x-opencode-session': sessionId });
  expect(params.headers?.['session-id']).toBeUndefined();
});
