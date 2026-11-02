import { createAnthropic } from '@ai-sdk/anthropic';
import { expect, it, vi } from 'vitest';
import {
  generateAnthropicResponse,
  streamAnthropicResponse,
  translateRequest,
  type AnthropicRequest,
} from '../src/sdk-adapter.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-external-cache-transport');

const apiKey = 'external-anthropic-fixture-sentinel';
const unsupportedMessage = /managed transport/i;

function nestedBody(): AnthropicRequest {
  return {
    model: 'claude-external-cache-fixture', max_tokens: 8,
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_external', name: 'lookup', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_external', content: [
        { type: 'text', text: 'private nested result', cache_control: { type: 'ephemeral', ttl: '5m' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' }, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ] }] },
    ],
  };
}

function unwrappedModel(fetch: typeof globalThis.fetch) {
  return createAnthropic({
    apiKey,
    baseURL: 'https://api.anthropic.fixture/v1',
    fetch,
  })('claude-external-cache-fixture');
}

function rejectionMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

it('rejects nested markers for non-streaming calls before an external SDK fetch', async () => {
  const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    id: 'message-fixture', type: 'message', role: 'assistant', model: 'claude-external-cache-fixture',
    content: [{ type: 'text', text: 'fixture reply' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
  }));
  const body = nestedBody();
  const model = unwrappedModel(upstream);
  const failure = await generateAnthropicResponse(model, translateRequest(body, '@ai-sdk/anthropic'), body.model)
    .then(() => undefined, rejectionMessage);

  expect(upstream).not.toHaveBeenCalled();
  expect(failure).toMatch(unsupportedMessage);
  expect(failure).not.toContain('private nested result');
});

it('rejects nested markers for streaming calls before an external SDK fetch', async () => {
  const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
  const body = nestedBody();
  const model = unwrappedModel(upstream);
  const failure = await streamAnthropicResponse(
    model, translateRequest(body, '@ai-sdk/anthropic'), body.model, () => {},
  ).then(() => undefined, rejectionMessage);

  expect(upstream).not.toHaveBeenCalled();
  expect(failure).toMatch(unsupportedMessage);
  expect(failure).not.toContain('private nested result');
});
