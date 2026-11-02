/** Because SDK translation must preserve supported Anthropic cache controls. */
import { expect, it } from 'vitest';
import { createCopilotHttpLanguageModel } from '../src/copilot/provider.js';
import { generateAnthropicResponse, translateRequest } from '../src/sdk-adapter.js';
import type { AnthropicRequest } from '../src/sdk-adapter.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-copilot-cache-wire');

async function captureCopilotRequest(body: AnthropicRequest): Promise<Record<string, unknown>> {
  let sent: Request | undefined;
  const token = 'copilot-oauth-fixture-sentinel';
  const network: typeof fetch = async input => {
    sent = input as Request;
    return Response.json({
      id: 'msg-cache-fixture', type: 'message', role: 'assistant', model: 'claude-cache-fixture',
      content: [{ type: 'text', text: 'fixture answer' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  };
  const model = await createCopilotHttpLanguageModel({
    npm: '@ai-sdk/anthropic', modelId: body.model, githubToken: token, fetchImpl: network,
  });

  await generateAnthropicResponse(model, translateRequest(body, '@ai-sdk/anthropic'), body.model);

  expect(sent?.headers.get('authorization')).toBe(`Bearer ${token}`);
  return await sent!.json() as Record<string, unknown>;
}

it('preserves ordered 5m and 1h system breakpoints with automatic caching', async () => {
  const body = {
    model: 'claude-cache-fixture', max_tokens: 8,
    cache_control: { type: 'ephemeral', ttl: '5m' },
    system: [
      { type: 'text', text: 'first system block', cache_control: { type: 'ephemeral', ttl: '5m', scope: { unexpected: true } } },
      { type: 'text', text: 'second system block', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'session' } },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'follow-up text', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'session' } }] }],
  } as unknown as AnthropicRequest & { cache_control: { type: string; ttl: string } };
  const payload = await captureCopilotRequest(body);

  expect(payload).toMatchObject({
    cache_control: { type: 'ephemeral', ttl: '5m' },
    system: [
      { type: 'text', text: 'first system block', cache_control: { type: 'ephemeral', ttl: '5m' } },
      { type: 'text', text: 'second system block', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
  });
  expect(JSON.stringify(payload)).toContain('follow-up text');
  expect(JSON.stringify(payload)).not.toContain('scope');
});

it('preserves a marked tool result before following user text', async () => {
  const body = {
    model: 'claude-cache-fixture', max_tokens: 8,
    tools: [{
      name: 'lookup', description: 'Read fixture records', input_schema: { type: 'object', properties: {} },
      cache_control: { type: 'ephemeral', ttl: '1h' },
    }],
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fixture', name: 'lookup', input: {
        cache_control: null,
        custom: { cache_control: { type: 'not-an-api-marker', ttl: 'forever', scope: 'user-data' } },
      } }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_fixture', content: 'fixture tool result', cache_control: { type: 'ephemeral', ttl: '5m', scope: 'session' } },
        { type: 'text', text: 'text after tool result', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'session' } },
      ] },
    ],
  } as unknown as AnthropicRequest;
  const payload = await captureCopilotRequest(body);

  expect(payload).toMatchObject({
    tools: [{ name: 'lookup', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  });
  const wire = JSON.stringify(payload);
  expect(wire.indexOf('fixture tool result')).toBeLessThan(wire.indexOf('text after tool result'));
  expect(payload).toMatchObject({
    messages: [
      expect.objectContaining({
        role: 'assistant', content: [expect.objectContaining({ input: {
          cache_control: null,
          custom: { cache_control: { type: 'not-an-api-marker', ttl: 'forever', scope: 'user-data' } },
        } })],
      }),
      expect.objectContaining({
        role: 'user',
        content: [
          expect.objectContaining({
            type: 'tool_result', tool_use_id: 'toolu_fixture', content: 'fixture tool result',
            cache_control: { type: 'ephemeral', ttl: '5m' },
          }),
          expect.objectContaining({
            type: 'text', text: 'text after tool result', cache_control: { type: 'ephemeral', ttl: '1h' },
          }),
        ],
      }),
    ],
  });
  expect(wire).toContain('"scope":"user-data"');
  expect(wire).not.toContain('"scope":"session"');
});

it('preserves assistant text, tool-use, and image cache markers', async () => {
  const body: AnthropicRequest = {
    model: 'claude-cache-fixture', max_tokens: 8,
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'assistant', content: [
        { type: 'text', text: 'assistant note', cache_control: { type: 'ephemeral', ttl: '5m' } },
        { type: 'tool_use', id: 'toolu_image_fixture', name: 'lookup', input: {}, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_image_fixture', content: 'tool completed' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' }, cache_control: { type: 'ephemeral', ttl: '5m' } },
      ] },
    ],
  };
  const payload = await captureCopilotRequest(body);
  const messages = payload['messages'] as Array<Record<string, unknown>>;

  expect(messages).toContainEqual(expect.objectContaining({
    role: 'assistant',
    content: expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'assistant note', cache_control: { type: 'ephemeral', ttl: '5m' } }),
      expect.objectContaining({ type: 'tool_use', name: 'lookup', cache_control: { type: 'ephemeral', ttl: '1h' } }),
    ]),
  }));
  expect(messages).toContainEqual(expect.objectContaining({
    role: 'user',
    content: expect.arrayContaining([
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'toolu_image_fixture', content: 'tool completed' }),
    ]),
  }));
  expect(messages).toContainEqual(expect.objectContaining({
    role: 'user',
    content: expect.arrayContaining([
      expect.objectContaining({ type: 'image', cache_control: { type: 'ephemeral', ttl: '5m' } }),
    ]),
  }));
  expect(JSON.stringify(payload)).not.toContain('scope');
});

it('does not inject Anthropic cache markers into non-Anthropic translations', () => {
  const params = translateRequest({
    model: 'fixture-openai-model',
    system: [{ type: 'text', text: 'instructions', cache_control: { type: 'ephemeral', ttl: '5m' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'question', cache_control: { type: 'ephemeral', ttl: '1h' } }] }],
  } as unknown as AnthropicRequest, '@ai-sdk/openai-compatible');

  expect(params.providerOptions ?? {}).not.toHaveProperty('anthropic');
  expect(JSON.stringify(params)).not.toContain('cacheControl');
  expect(JSON.stringify(params)).not.toContain('cache_control');
});
