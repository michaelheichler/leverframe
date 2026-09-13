/** Because HTTP translation must not create SDK sessions. */
import { expect, it } from 'vitest';
import { translateRequest } from '../src/sdk-adapter.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

it('keeps caller tools without adding Copilot runtime options', () => {
  const params = translateRequest({
    model: 'gpt-4o-mini', system: 'You are a coding assistant.',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
  }, '@ai-sdk/openai-compatible', { claudeSessionId: SESSION_ID });
  expect(params.providerOptions?.copilot).toBeUndefined();
  expect(Object.keys(params.tools ?? {})).toEqual(['Read']);
});

it('passes advertised effort through the standard HTTP options', () => {
  const params = translateRequest({
    model: 'copilot-reasoning-model', messages: [{ role: 'user', content: 'hello' }],
    output_config: { effort: 'high' },
  }, '@ai-sdk/openai', {
    claudeSessionId: SESSION_ID,
    reasoningMetadata: { providerId: 'github-copilot', reasoning: true, supportedReasoningEfforts: ['high'] },
  });
  expect(params.providerOptions?.copilot).toBeUndefined();
  expect(params.providerOptions?.openai).toMatchObject({ reasoningEffort: 'high' });
});

it('does not add Copilot options to another provider', () => {
  const params = translateRequest({
    model: 'gpt-5.5', messages: [{ role: 'user', content: 'hello' }],
  }, '@ai-sdk/openai', { claudeSessionId: SESSION_ID });
  expect(params.providerOptions?.copilot).toBeUndefined();
});
