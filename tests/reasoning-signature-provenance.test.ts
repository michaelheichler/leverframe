import { expect, it } from 'vitest';
import { translateMessages } from '../src/sdk-adapter.js';
import { grabRoundTripSignature } from '../src/proxy-shared.js';
import { encodeOpenAiReasoningSignature } from '../src/reasoning-signature.js';

it('does not replay an Anthropic thinking signature as OpenAI encrypted content', () => {
  const result = translateMessages([{ role: 'assistant', content: [
    { type: 'thinking', thinking: 'Keep visible reasoning.', signature: 'CAQSfixtureGAE=' },
    { type: 'text', text: 'Answer' },
  ] }], '@ai-sdk/openai');

  expect(result).toEqual([{ role: 'assistant', content: [
    { type: 'reasoning', text: 'Keep visible reasoning.' }, { type: 'text', text: 'Answer' },
  ] }]);
});

it('drops empty reasoning with a foreign signature while retaining tool exchanges', () => {
  const result = translateMessages([
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '', signature: 'CAQSfixtureGAE=' },
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_1', content: 'file body', _name: 'Read' },
      { type: 'text', text: 'Continue' },
    ] },
  ], '@ai-sdk/openai');

  expect(result).toEqual([
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'Read', input: { path: 'a' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'Read', output: { type: 'text', value: 'file body' } }] },
    { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
  ]);
});

it('marks outgoing OpenAI signatures so their provenance survives the Anthropic wire format', () => {
  const signature = grabRoundTripSignature({
    type: 'reasoning-end', providerMetadata: { openai: { reasoningEncryptedContent: 'encrypted-fixture' } },
  });

  expect(signature).toBe(encodeOpenAiReasoningSignature('encrypted-fixture'));
});

it('keeps OpenAI encrypted content out of Google thought signatures', () => {
  const result = translateMessages([{ role: 'assistant', content: [{
    type: 'thinking', thinking: 'Visible reasoning', signature: encodeOpenAiReasoningSignature('encrypted-fixture'),
  }] }], '@ai-sdk/google');

  expect(result).toEqual([{ role: 'assistant', content: [{ type: 'reasoning', text: 'Visible reasoning' }] }]);
});
