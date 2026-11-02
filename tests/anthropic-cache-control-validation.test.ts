/** Because only documented protocol cache slots accept cache control. */
import { expect, it } from 'vitest';
import { translateRequest, type AnthropicRequest } from '../src/sdk-adapter.js';

const invalidRequests = [
  { model: 'fixture', cache_control: { type: 'persistent' }, messages: [] },
  { model: 'fixture', cache_control: { type: 'ephemeral', ttl: '2h' }, messages: [] },
  { model: 'fixture', cache_control: false, messages: [] },
  { model: 'fixture', cache_control: 0, messages: [] },
  { model: 'fixture', system: [{ text: 'instructions', cache_control: { type: 'persistent' } }], messages: [] },
  { model: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'prompt', cache_control: { type: 'ephemeral', ttl: '2h' } }] }] },
  { model: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'prompt', cache_control: false }] }] },
  { model: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'prompt', cache_control: 0 }] }] },
] as const;

it.each(invalidRequests)('rejects malformed cache control in a protocol slot', request => {
  expect(() => translateRequest(request as unknown as AnthropicRequest, '@ai-sdk/anthropic')).toThrow(TypeError);
});

it('preserves arbitrary cache_control values inside tool JSON input', () => {
  const request: AnthropicRequest = {
    model: 'fixture',
    tools: [{
      name: 'lookup', input_schema: {
        type: 'object', properties: { cache_control: { type: 'string' } },
      },
    }],
    messages: [{ role: 'assistant', content: [{
      type: 'tool_use', id: 'toolu-fixture', name: 'lookup',
      input: { cache_control: null, custom: { cache_control: { type: 'not-a-marker', ttl: 'forever' } } },
    }] }],
  };
  const translated = translateRequest(request, '@ai-sdk/anthropic');

  expect(translated.messages[0]).toMatchObject({
    role: 'assistant', content: [{ type: 'tool-call', input: {
      cache_control: null, custom: { cache_control: { type: 'not-a-marker', ttl: 'forever' } },
    } }],
  });
  expect(translated.tools?.lookup).toBeDefined();
});
