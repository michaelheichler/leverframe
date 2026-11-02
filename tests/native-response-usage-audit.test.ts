import type { ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { relayAnthropicMessages } from '../src/upstream-forward.js';

afterEach(() => vi.restoreAllMocks());

function responseSink(): ServerResponse {
  const response = new PassThrough() as PassThrough & ServerResponse;
  response.writeHead = (() => response) as typeof response.writeHead;
  response.resume();
  return response;
}

it('emits cumulative raw usage observations for partial native stream events', async () => {
  const stream = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":40,"cache_creation":{"ephemeral_5m_input_tokens":3},"cache_read_input_tokens":5}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":6,"cache_creation":{"ephemeral_1h_input_tokens":4}}}',
    '', '',
  ].join('\n');
  const observe = vi.fn();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, {
    headers: { 'content-type': 'text/event-stream' },
  }));

  await relayAnthropicMessages(responseSink(), 'https://api.anthropic.test/v1/messages', {
    model: 'fixture-model', messages: [], stream: true,
  }, 'fixture-key', true, { authType: 'api', onUsage: observe });

  expect(observe).toHaveBeenCalledTimes(2);
  expect(observe.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(0);
  expect(observe.mock.calls[1]?.[1]).toBeGreaterThanOrEqual(0);
  expect(observe.mock.calls.map(([usage]) => usage)).toMatchObject([
    {
      usageStage: 'message_start', inputTokens: 40, cacheCreation5mInputTokens: 3,
      cacheCreationInputTokens: undefined, cacheReadInputTokens: 5, totalInputTokens: undefined,
    },
    {
      usageStage: 'message_delta', inputTokens: 40, outputTokens: 6,
      cacheCreation5mInputTokens: 3, cacheCreation1hInputTokens: 4,
      cacheCreationInputTokens: 7, cacheReadInputTokens: 5, totalInputTokens: 52,
    },
  ]);
});

it('emits raw cache and total usage for a native nonstream response', async () => {
  const observe = vi.fn();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
    type: 'message', model: 'fixture-model', content: [], stop_reason: 'end_turn',
    usage: {
      input_tokens: 12, output_tokens: 4, cache_creation_input_tokens: 6,
      cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 3 },
      cache_read_input_tokens: 4,
    },
  }));

  await relayAnthropicMessages(responseSink(), 'https://api.anthropic.test/v1/messages', {
    model: 'fixture-model', messages: [],
  }, 'fixture-key', false, { authType: 'api', onUsage: observe });

  expect(observe).toHaveBeenCalledOnce();
  expect(observe.mock.calls[0]?.[0]).toEqual({
    usageStage: 'message_delta', inputTokens: 12, outputTokens: 4,
    cacheCreationInputTokens: 6, cacheCreation5mInputTokens: 3,
    cacheCreation1hInputTokens: 3, cacheReadInputTokens: 4, totalInputTokens: 22,
  });
  expect(observe.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(0);
});

it('does not emit measured usage when a native response omits provider usage', async () => {
  const observe = vi.fn();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
    type: 'message', model: 'fixture-model', content: [], stop_reason: 'end_turn',
  }));

  await relayAnthropicMessages(responseSink(), 'https://api.anthropic.test/v1/messages', {
    model: 'fixture-model', messages: [],
  }, 'fixture-key', false, { authType: 'api', onUsage: observe });

  expect(observe).not.toHaveBeenCalled();
});
