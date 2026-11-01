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

it('preserves ordered model context, tools, cache directives, effort, and caller headers on the native wire', async () => {
  const body = {
    model: 'fixture-model', max_tokens: 120, output_config: { effort: 'high' },
    system: [
      { type: 'text', text: 'Keep the project instructions.' },
      { type: 'text', text: 'Preserve the user decisions.', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Objective: inspect the behavior.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-call-a', name: 'Read', input: { path: 'src/a.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-call-a', content: 'The route forwards a request.' }] },
    ],
    tools: [
      { name: 'Read', description: 'Read source files.', input_schema: { type: 'object' } },
      { name: 'Search', description: 'Search source files.', input_schema: { type: 'object' } },
    ],
  };
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ content: [] }));

  await relayAnthropicMessages(responseSink(), 'https://api.anthropic.test/v1/messages', body,
    'fixture-key', false, {
      authType: 'api', inboundVersion: '2025-04-20',
      extraHeaders: { 'X-Trace-Id': 'fixture-trace' },
    });

  const request = fetchMock.mock.calls[0]![1]!;
  const sent = JSON.parse(request.body as string) as typeof body;
  const headers = new Headers(request.headers);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(headers.get('anthropic-version')).toBe('2025-04-20');
  expect(headers.get('x-trace-id')).toBe('fixture-trace');
  expect(sent).toMatchObject({ model: body.model, output_config: body.output_config, system: body.system });
  expect(sent.messages).toEqual(body.messages);
  expect(sent.tools).toEqual(body.tools);
});
