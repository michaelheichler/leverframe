import { describe, expect, it } from 'vitest';
import { translateRequest } from '../src/sdk-request-translation.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function request() {
  return {
    model: 'hy3',
    messages: [{ role: 'user' as const, content: 'hello' }],
  };
}

describe('OpenCode Go request session header', () => {
  it('adds the validated Claude session id as a per-call OpenCode header', () => {
    const params = translateRequest(request(), '@ai-sdk/openai-compatible', {
      claudeSessionId: SESSION_ID,
      reasoningMetadata: { providerId: 'opencode-go' },
    });

    expect(params.headers).toEqual({ 'x-opencode-session': SESSION_ID });
  });

  it('does not emit a provider-specific header for other routes or invalid ids', () => {
    expect(translateRequest(request(), '@ai-sdk/openai-compatible', {
      claudeSessionId: 'not-a-uuid',
      reasoningMetadata: { providerId: 'opencode-go' },
    }).headers).toBeUndefined();
    expect(translateRequest(request(), '@ai-sdk/openai-compatible', {
      claudeSessionId: SESSION_ID,
      reasoningMetadata: { providerId: 'zai' },
    }).headers).toBeUndefined();
  });
});
