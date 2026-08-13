import { describe, expect, it } from 'vitest';
import { translateRequest } from '../src/sdk-adapter.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

describe('translateRequest Copilot provider options', () => {
  it('passes the validated Claude session ID', () => {
    const params = translateRequest({
      model: 'claude-sonnet-4-6',
      system: 'You are a coding assistant.',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        name: 'Read',
        description: 'read a file',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      }],
    }, '@github/copilot-sdk', { claudeSessionId: SESSION_ID });

    expect(params.providerOptions?.copilot).toMatchObject({ claudeSessionId: SESSION_ID });
  });

  it('passes the request reasoning effort', () => {
    const params = translateRequest({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      output_config: { effort: 'high' },
    }, '@github/copilot-sdk', { claudeSessionId: SESSION_ID });

    expect(params.providerOptions?.copilot).toMatchObject({ reasoningEffort: 'high' });
  });

  it('does not add Copilot options to another provider', () => {
    const params = translateRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
    }, '@ai-sdk/openai', { claudeSessionId: SESSION_ID });

    expect(params.providerOptions?.copilot).toBeUndefined();
  });
});
