import { describe, expect, it } from 'vitest';
import { buildOpenAiOAuthModels } from '../src/data/openai-oauth-models.js';

describe('OpenAI OAuth model metadata', () => {
  it('marks the GPT-5.6 Sol fallback context window as unconfirmed', () => {
    const model = buildOpenAiOAuthModels().find(candidate => candidate.id === 'gpt-5.6-sol');

    expect(model).toMatchObject({
      contextWindow: undefined,
      contextWindowUnconfirmed: true,
    });
  });
});
