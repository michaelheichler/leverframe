import type { ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { anthropicUpstreamHeaders, relayAnthropicMessages } from '../src/upstream-forward.js';
import { NEUTRAL_ASSISTANT_PROMPT } from '../src/neutral-client-request.js';

afterEach(() => vi.restoreAllMocks());

function responseSink(): ServerResponse {
  const response = new PassThrough() as PassThrough & ServerResponse;
  response.writeHead = (() => response) as typeof response.writeHead;
  response.resume();
  return response;
}

function systemFixture() {
  return [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.207; cc_entrypoint=cli;' },
    {
      type: 'text',
      text: "You are Claude Code, Anthropic's official CLI for Claude.\nPreserve user changes.",
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ];
}

it.each(['api', undefined] as const)('removes client headers and beta flags for %s authentication', authType => {
  const headers = anthropicUpstreamHeaders('fixture-key', true,
    'oauth-2025-04-20,claude-code-20250219,fine-grained-tool-streaming-2025-05-14', authType,
    'fixture-session', {
      'uSeR-aGeNt': 'claude-cli/2.1.207', 'X-App': 'cli',
      'x-CLAUDE-code-session-id': 'fixture-session', 'X-Trace-Id': 'keep-trace',
    });

  expect(Object.fromEntries(new Headers(headers))).toEqual({
    accept: 'text/event-stream', 'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
    'anthropic-version': '2023-06-01', authorization: 'Bearer fixture-key',
    'content-type': 'application/json', 'x-api-key': 'fixture-key', 'x-trace-id': 'keep-trace',
  });
});

it('filters client beta flags supplied only in custom headers', () => {
  const headers = anthropicUpstreamHeaders('fixture-key', false, undefined, 'api', undefined, {
    'Anthropic-Beta': 'oauth-2025-04-20,claude-code-20250219,fine-grained-tool-streaming-2025-05-14',
  });

  expect(new Headers(headers).get('anthropic-beta')).toBe('fine-grained-tool-streaming-2025-05-14');
});

it.each(['api', undefined] as const)('normalizes system blocks on the wire for %s authentication', async authType => {
  const body = {
    model: 'claude-test', system: systemFixture(),
    messages: [{ role: 'user', content: 'Explain Claude Code configuration.' }],
    tools: [{ name: 'Read', description: 'Read files', input_schema: { type: 'object' } }],
  };
  const original = structuredClone(body);
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ content: [] }));

  await relayAnthropicMessages(responseSink(), 'https://api.anthropic.test/v1/messages', body,
    'fixture-key', false, { authType });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.test/v1/messages', {
    method: 'POST', signal: undefined, headers: expect.objectContaining({ 'x-api-key': 'fixture-key' }),
    body: JSON.stringify({ ...body, system: [{
      type: 'text', text: `${NEUTRAL_ASSISTANT_PROMPT}\nPreserve user changes.`,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    }] }),
  });
  expect(body).toEqual(original);
});

it('normalizes string system instructions without changing user content', async () => {
  const system = systemFixture().map(block => block.text).join('\n');
  const body = { model: 'claude-test', system, messages: [{ role: 'user', content: system }] };
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ content: [] }));

  await relayAnthropicMessages(responseSink(), 'https://api.anthropic.test/v1/messages', body,
    'fixture-key', false, { authType: 'api' });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.test/v1/messages', {
    method: 'POST', signal: undefined, headers: expect.objectContaining({ 'x-api-key': 'fixture-key' }),
    body: JSON.stringify({ ...body, system: `${NEUTRAL_ASSISTANT_PROMPT}\nPreserve user changes.` }),
  });
  expect(body.system).toBe(system);
});

it('preserves OAuth identity and beta flags on the wire', async () => {
  const body = { model: 'claude-test', system: systemFixture(), messages: [{ role: 'user', content: 'Hello' }] };
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ content: [] }));

  await relayAnthropicMessages(responseSink(), 'https://api.anthropic.test/v1/messages', body,
    'fixture-token', false, { authType: 'oauth', inboundBeta: 'oauth-2025-04-20,claude-code-20250219' });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.test/v1/messages', {
    method: 'POST', signal: undefined, headers: expect.objectContaining({
      Authorization: 'Bearer fixture-token', 'x-app': 'cli',
      'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
    }), body: JSON.stringify(body),
  });
});

it.each([
  [JSON.stringify({ device_id: 'fixture-device', account_uuid: 'fixture-account', session_id: 'fixture-session' }), { trace: 'keep' }],
  ['user_' + 'a'.repeat(64) + '_account_12345678-1234-4234-8234-123456789abc_session_12345678-1234-4234-8234-123456789def', { trace: 'keep' }],
  ['customer-42', { user_id: 'customer-42', trace: 'keep' }],
])('removes only recognized client user metadata %s', async (userId, metadata) => {
  const body = { model: 'claude-test', metadata: { user_id: userId, trace: 'keep' }, messages: [] };
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ content: [] }));

  await relayAnthropicMessages(responseSink(), 'https://api.anthropic.test/v1/messages', body,
    'fixture-key', false, { authType: 'api' });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.test/v1/messages', {
    method: 'POST', signal: undefined, headers: expect.objectContaining({ 'x-api-key': 'fixture-key' }),
    body: JSON.stringify({ ...body, metadata }),
  });
});
