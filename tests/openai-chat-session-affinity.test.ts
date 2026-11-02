/** Because OAuth cache affinity must follow the validated coding session. */
import { expect, it } from 'vitest';
import { translateOpenAiRequest, type OpenAiRequest } from '../src/openai-adapter.js';

function request(text: string): OpenAiRequest {
  return { model: 'fixture-chat-model', messages: [{ role: 'user', content: text }] };
}

it('keeps one session affinity key across turns and separates distinct sessions', () => {
  const firstSession = '7f4c572b-f0e3-4df1-b359-6d6d9824c901';
  const secondSession = '445f9aa7-b822-4b3e-b808-05ee1b89908b';
  const firstTurn = translateOpenAiRequest(request('first turn'), {
    openAiOAuth: true, claudeSessionId: firstSession,
  });
  const laterTurn = translateOpenAiRequest(request('different history'), {
    openAiOAuth: true, claudeSessionId: firstSession,
  });
  const otherSession = translateOpenAiRequest(request('first turn'), {
    openAiOAuth: true, claudeSessionId: secondSession,
  });
  const firstKey = firstTurn.providerOptions?.openai?.promptCacheKey;

  expect(typeof firstKey).toBe('string');
  expect(laterTurn.providerOptions?.openai?.promptCacheKey).toBe(firstKey);
  expect(firstTurn.headers?.['session-id']).toBe(firstKey);
  expect(laterTurn.headers?.['session-id']).toBe(firstKey);
  expect(otherSession.providerOptions?.openai?.promptCacheKey).not.toBe(firstKey);
  expect(otherSession.headers?.['session-id']).not.toBe(firstKey);
  expect(JSON.stringify(firstTurn)).not.toContain(firstSession);
});

it('uses a deterministic prefix key when session metadata is malformed', () => {
  const requestBody: OpenAiRequest = {
    model: 'fixture-chat-model',
    messages: [{ role: 'system', content: 'stable instructions' }, { role: 'user', content: 'changing history' }],
  };
  const translated = translateOpenAiRequest(requestBody, {
    openAiOAuth: true, claudeSessionId: 'not-a-session-uuid',
  });

  expect(typeof translated.providerOptions?.openai?.promptCacheKey).toBe('string');
  expect(translated.headers?.['session-id']).toBe(translated.providerOptions?.openai?.promptCacheKey);
  expect(JSON.stringify(translated)).not.toContain('not-a-session-uuid');
});

it('prefers validated metadata identity over a header fallback', () => {
  const metadataSession = '7f4c572b-f0e3-4df1-b359-6d6d9824c901';
  const first = translateOpenAiRequest({
    model: 'fixture-chat-model', metadata: { user_id: JSON.stringify({ session_id: metadataSession }) },
    messages: [{ role: 'user', content: 'request' }],
  } as unknown as OpenAiRequest, { openAiOAuth: true, claudeSessionId: '445f9aa7-b822-4b3e-b808-05ee1b89908b' });
  const second = translateOpenAiRequest({
    model: 'fixture-chat-model', metadata: { user_id: JSON.stringify({ session_id: metadataSession }) },
    messages: [{ role: 'user', content: 'request' }],
  } as unknown as OpenAiRequest, { openAiOAuth: true, claudeSessionId: '2d6fe10e-2a59-4b56-9505-4ca539e04cd9' });

  expect(first.providerOptions?.openai?.promptCacheKey).toBe(second.providerOptions?.openai?.promptCacheKey);
  expect(first.headers?.['session-id']).toBe(second.headers?.['session-id']);
});

it('does not treat the generic OpenAI user field as session identity', () => {
  const first = translateOpenAiRequest({
    model: 'fixture-chat-model', user: '7f4c572b-f0e3-4df1-b359-6d6d9824c901',
    messages: [{ role: 'system', content: 'stable instructions' }],
  } as unknown as OpenAiRequest, { openAiOAuth: true });
  const second = translateOpenAiRequest({
    model: 'fixture-chat-model', user: '445f9aa7-b822-4b3e-b808-05ee1b89908b',
    messages: [{ role: 'system', content: 'stable instructions' }],
  } as unknown as OpenAiRequest, { openAiOAuth: true });

  expect(first.providerOptions?.openai?.promptCacheKey).toBe(second.providerOptions?.openai?.promptCacheKey);
  expect(JSON.stringify(first)).not.toContain('7f4c572b-f0e3-4df1-b359-6d6d9824c901');
  expect(JSON.stringify(second)).not.toContain('445f9aa7-b822-4b3e-b808-05ee1b89908b');
});

it('preserves only an OpenAI caller cache key for API-key provider calls', () => {
  const translated = translateOpenAiRequest({
    model: 'fixture-chat-model', prompt_cache_key: 'client-cache-fixture',
    messages: [{ role: 'user', content: 'request' }],
  } as unknown as OpenAiRequest, { openAiProvider: true });

  expect(translated.providerOptions?.openai?.promptCacheKey).toBe('client-cache-fixture');
  expect(translated.headers?.['session-id']).toBeUndefined();
});

it('does not inject Anthropic or OpenAI cache controls into compatible providers', () => {
  const translated = translateOpenAiRequest({
    model: 'fixture-compatible-model', prompt_cache_key: 'client-cache-fixture',
    messages: [{ role: 'user', content: 'request' }],
  } as unknown as OpenAiRequest);

  expect(translated.providerOptions ?? {}).not.toHaveProperty('openai');
  expect(translated.headers).toBeUndefined();
  expect(JSON.stringify(translated)).not.toContain('client-cache-fixture');
});
