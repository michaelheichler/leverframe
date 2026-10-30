import { PassThrough } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import {
  neutralClientInstructions,
  neutralInstructionText,
  NEUTRAL_ASSISTANT_PROMPT,
} from '../src/neutral-client-request.js';
import { translateRequest } from '../src/sdk-request-translation.js';
import { translateOpenAiRequest } from '../src/openai-request-translation.js';
import { relayAnthropicMessages } from '../src/upstream-forward.js';

const agentIdentities = [
  "You are an agent for Claude Code, Anthropic's official CLI for Claude.",
  'You are an agent for Claude Code.',
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
];
const taskInstructions = 'Find the parser. Do not edit files. Report file paths.';

afterEach(() => vi.restoreAllMocks());

it.each(agentIdentities)('replaces agent identity and preserves task instructions for %s', identity => {
  expect(neutralInstructionText(`${identity}\n${taskInstructions}`))
    .toBe(`${NEUTRAL_ASSISTANT_PROMPT}\n${taskInstructions}`);
});

it('normalizes system instructions without changing user, assistant, or tool data', () => {
  const body = {
    system: `${agentIdentities[0]}\n${taskInstructions}`,
    messages: [
      { role: 'user', content: taskInstructions },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'src/parser.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'parser source' }] },
    ],
  };
  const originalMessages = structuredClone(body.messages);
  const normalized = neutralClientInstructions(body);

  expect(normalized.system).toBe(`${NEUTRAL_ASSISTANT_PROMPT}\n${taskInstructions}`);
  expect(normalized.messages).toEqual(originalMessages);
  expect(neutralClientInstructions(normalized)).toEqual(normalized);
});

it.each(['@ai-sdk/anthropic', '@ai-sdk/openai', '@ai-sdk/openai-compatible', '@ai-sdk/google'])(
  'passes neutral subagent instructions through %s requests', npm => {
    const translated = translateRequest({ model: 'fixture-haiku',
      system: `${agentIdentities[0]}\n${taskInstructions}`,
      messages: [{ role: 'user', content: taskInstructions }] }, npm, { defaultEffort: 'low' });

    expect(translated.instructions).toBe(`${NEUTRAL_ASSISTANT_PROMPT}\n${taskInstructions}`);
  },
);

it.each(['system', 'developer'] as const)('normalizes OpenAI ChatGPT %s subagent instructions', role => {
  const translated = translateOpenAiRequest({ model: 'fixture-haiku', messages: [
    { role, content: `${agentIdentities[3]}\n${taskInstructions}` },
    { role: 'user', content: taskInstructions },
  ] }, { openAiOAuth: true });

  expect(translated.providerOptions?.openai?.instructions)
    .toBe(`${NEUTRAL_ASSISTANT_PROMPT}\n${taskInstructions}`);
});

it('sends neutral subagent instructions on the Anthropic API route', async () => {
  const body = { model: 'fixture-haiku', system: [{ type: 'text',
    text: `${agentIdentities[2]}\n${taskInstructions}`, cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: taskInstructions }] };
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ content: [] }));
  const response = new PassThrough() as PassThrough & ServerResponse;
  response.writeHead = (() => response) as typeof response.writeHead;
  response.resume();

  await relayAnthropicMessages(response, 'https://provider.invalid/v1/messages', body,
    'fixture-key', false, { authType: 'api' });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(payload.system).toEqual([{ ...body.system[0],
    text: `${NEUTRAL_ASSISTANT_PROMPT}\n${taskInstructions}` }]);
  expect(payload.messages).toEqual(body.messages);
});

it('preserves subagent instructions for Anthropic subscription OAuth', async () => {
  const body = { model: 'fixture-haiku', system: agentIdentities[3],
    messages: [{ role: 'user', content: taskInstructions }] };
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ content: [] }));
  const response = new PassThrough() as PassThrough & ServerResponse;
  response.writeHead = (() => response) as typeof response.writeHead;
  response.resume();

  await relayAnthropicMessages(response, 'https://provider.invalid/v1/messages', body,
    'fixture-token', false, { authType: 'oauth' });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(payload.system).toBe(body.system);
  expect(payload.messages).toEqual(body.messages);
});
