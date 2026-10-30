import { expect, it } from 'vitest';
import { translateRequest } from '../src/sdk-adapter.js';
import { translateOpenAiRequest } from '../src/openai-adapter.js';
import { NEUTRAL_ASSISTANT_PROMPT } from '../src/neutral-client-request.js';

function identityText() {
  return 'x-anthropic-billing-header: cc_version=2.1.207; cc_entrypoint=cli;\n'
    + "You are Claude Code, Anthropic's official CLI for Claude.\nPreserve user changes.";
}

it('neutralizes ChatGPT instructions from Anthropic blocks while retaining user content', () => {
  const identity = identityText();
  const body = {
    model: 'gpt-test', system: [{ text: identity }],
    messages: [{ role: 'user' as const, content: identity }, { role: 'system' as const, content: identity }],
    tools: [{ name: 'Read', description: 'Claude Code file reader', input_schema: { type: 'object' } }],
  };
  const original = structuredClone(body);

  const result = translateRequest(body, '@ai-sdk/openai', { openAiOAuth: true });

  expect(result.providerOptions?.openai?.instructions).toBe(`${NEUTRAL_ASSISTANT_PROMPT}\nPreserve user changes.`);
  expect(result.messages).toEqual([
    { role: 'user', content: [{ type: 'text', text: identity }] },
    { role: 'system', content: `${NEUTRAL_ASSISTANT_PROMPT}\nPreserve user changes.` },
  ]);
  expect(result.tools?.Read.description).toBe('Claude Code file reader');
  expect(body).toEqual(original);
});

it.each(['system', 'developer'] as const)('neutralizes ChatGPT %s instructions at either conversation position', role => {
  const identity = identityText();
  const body = { model: 'gpt-test', messages: [
    { role, content: [{ type: 'text', text: identity }] },
    { role: 'user' as const, content: identity },
    { role, content: identity },
    { role: 'assistant' as const, content: identity },
  ] };
  const original = structuredClone(body);

  const result = translateOpenAiRequest(body, { openAiOAuth: true });

  expect(result.providerOptions?.openai?.instructions).toBe(`${NEUTRAL_ASSISTANT_PROMPT}\nPreserve user changes.`);
  expect(result.messages).toEqual([
    { role: 'user', content: identity },
    { role: 'system', content: `${NEUTRAL_ASSISTANT_PROMPT}\nPreserve user changes.` },
    { role: 'assistant', content: [{ type: 'text', text: identity }] },
  ]);
  expect(body).toEqual(original);
});

it('neutralizes public OpenAI API instructions', () => {
  const identity = identityText();

  const result = translateOpenAiRequest({ model: 'gpt-test', messages: [{ role: 'system', content: identity }] });

  expect(result.instructions).toBe(`${NEUTRAL_ASSISTANT_PROMPT}\nPreserve user changes.`);
});

it('preserves user text and tool exchanges on the ChatGPT route', () => {
  const result = translateOpenAiRequest({ model: 'gpt-test', messages: [
    { role: 'system', content: 'You are Claude Code.' },
    { role: 'user', content: 'Read Claude Code settings.' },
    { role: 'assistant', content: null, tool_calls: [{
      id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"settings.json"}' },
    }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'Claude Code settings' },
  ] }, { openAiOAuth: true });

  expect(result.providerOptions?.openai?.instructions).toBe(NEUTRAL_ASSISTANT_PROMPT);
  expect(result.messages).toEqual([
    { role: 'user', content: 'Read Claude Code settings.' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'Read', input: { path: 'settings.json' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'Read', output: { type: 'text', value: 'Claude Code settings' } }] },
  ]);
});
