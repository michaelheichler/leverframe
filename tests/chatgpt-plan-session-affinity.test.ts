import { expect, it } from 'vitest';
import { claudeSessionPromptCacheKey, translateRequest } from '../src/sdk-adapter.js';

const readTool = { name: 'Read', description: 'Read source files.', input_schema: { type: 'object' } };

function request(sessionId?: string) {
  return {
    model: 'gpt-5.6-sol', system: 'You are a coding assistant.',
    messages: [{ role: 'user' as const, content: 'Inspect the request path.' }], tools: [readTool],
    ...(sessionId ? { metadata: { user_id: JSON.stringify({ session_id: sessionId }) } } : {}),
  };
}

function oauthParams(body: Parameters<typeof translateRequest>[0], claudeSessionId?: string) {
  return translateRequest(body, '@ai-sdk/openai', { openAiOAuth: true, claudeSessionId });
}

it('keeps the ChatGPT plan cache key stable across history changes', () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const first = oauthParams(request(sessionId));
  const next = oauthParams({ ...request(sessionId), messages: [
    { role: 'user' as const, content: 'Inspect the request path again.' },
  ] });

  expect(first.providerOptions?.openai?.promptCacheKey).toBe(claudeSessionPromptCacheKey(sessionId));
  expect(next.providerOptions?.openai?.promptCacheKey).toBe(first.providerOptions?.openai?.promptCacheKey);
  expect(first.headers?.['session-id']).toBeUndefined();
  expect(next.headers?.['session-id']).toBeUndefined();
});

it('separates valid session UUIDs on the same model', () => {
  const first = oauthParams(request('11111111-1111-4111-8111-111111111111'));
  const second = oauthParams(request('22222222-2222-4222-8222-222222222222'));

  expect(first.providerOptions?.openai?.promptCacheKey).not.toBe(second.providerOptions?.openai?.promptCacheKey);
  expect(first.headers?.['session-id']).toBeUndefined();
  expect(second.headers?.['session-id']).toBeUndefined();
});

it('uses the valid body session before the caller header session', () => {
  const bodySession = '11111111-1111-4111-8111-111111111111';
  const headerSession = '22222222-2222-4222-8222-222222222222';
  const params = oauthParams(request(bodySession), headerSession);

  expect(params.providerOptions?.openai?.promptCacheKey).toBe(claudeSessionPromptCacheKey(bodySession));
  expect(params.headers?.['session-id']).toBeUndefined();
});

it('uses the prefix cache key when session metadata is malformed', () => {
  const body = { ...request(), system: 'Use the current instructions.' };
  const fallback = oauthParams(body).providerOptions?.openai?.promptCacheKey;
  const params = oauthParams({ ...body, metadata: { user_id: '{invalid session metadata' } });

  expect(fallback).toEqual(expect.any(String));
  expect(params.providerOptions?.openai?.promptCacheKey).toBe(fallback);
  expect(params.headers?.['session-id']).toBeUndefined();
});
