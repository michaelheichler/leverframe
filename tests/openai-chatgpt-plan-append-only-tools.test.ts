import { jsonSchema, streamText, tool, type ModelMessage } from 'ai';
import { afterEach, expect, it, vi } from 'vitest';
import { createBuiltinOpenAiModel } from '../src/language-model-builtins.js';
import { upstreamResponsesStream } from './fixtures/chatgpt-plan-responses.js';

const sessionKey = `relay-session-${'a'.repeat(32)}`;
const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } as const;

afterEach(() => vi.unstubAllEnvs());

async function openPlanSession() {
  const fetchUpstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => upstreamResponsesStream());
  const model = await createBuiltinOpenAiModel({
    npm: '@ai-sdk/openai', modelId: 'gpt-6.2-astra', apiKey: 'fixture-token',
    authType: 'oauth', providerId: 'openai-chatgpt-plan', fetch: fetchUpstream,
  }, true);
  return {
    turn: (messages: ModelMessage[], toolNames: string[], key = sessionKey, inputSchema: Parameters<typeof jsonSchema>[0] = schema) => streamText({
      model, messages, maxRetries: 0,
      tools: Object.fromEntries(toolNames.map(name => [name, tool({
        description: `${name} a report`, inputSchema: jsonSchema(inputSchema),
      })])),
      providerOptions: { openai: { promptCacheKey: key, instructions: 'Help edit the report.' } },
    }).text,
    requests: () => Promise.all(fetchUpstream.mock.calls.map(async ([url, init]) => {
      const request = new Request(url, init);
      return { url: request.url, method: request.method, body: await request.json() };
    })),
  };
}

function reportHistory() {
  const initial: ModelMessage[] = [{ role: 'user', content: 'Inspect the report.' }];
  const discovery: ModelMessage[] = [...initial,
    { role: 'assistant', content: 'I inspected the report.' },
    { role: 'user', content: 'Update the report.' },
  ];
  const followup: ModelMessage[] = [...discovery,
    { role: 'assistant', content: 'I updated the report.' },
    { role: 'user', content: 'Verify the result.' },
  ];
  return { initial, discovery, followup };
}

it('appends and replays a newly available local tool at its original input boundary', async () => {
  vi.stubEnv('LEVERFRAME_OPENAI_APPEND_ONLY_TOOLS', '1');
  const session = await openPlanSession();
  const { initial, discovery, followup } = reportHistory();
  await session.turn(initial, ['Read']);
  await session.turn(discovery, ['Read', 'Write']);
  await session.turn(followup, ['Read', 'Write']);
  await session.turn([...followup, { role: 'user', content: 'Only inspect it now.' }], ['Read']);

  const requests = await session.requests();
  expect(requests.map(({ url, method }) => [url, method])).toEqual([
    ['https://api.openai.com/v1/responses', 'POST'],
    ['https://api.openai.com/v1/responses', 'POST'],
    ['https://api.openai.com/v1/responses', 'POST'],
    ['https://api.openai.com/v1/responses', 'POST'],
  ]);
  const [first, second, third, fourth] = requests.map(request => request.body);
  expect(first.tools).toMatchObject([{ name: 'claude_code', tools: [{ name: 'Read', strict: false }] }]);
  expect(second.tools).toEqual(first.tools);
  expect(third.tools).toEqual(first.tools);
  expect(fourth.tools).toEqual(first.tools);
  expect(second.input.slice(0, first.input.length)).toEqual(first.input);
  expect(second.input.at(-1)).toMatchObject({
    type: 'additional_tools', role: 'developer',
    tools: [{ type: 'namespace', name: 'claude_code', tools: [
      { type: 'function', name: 'Write', strict: false, parameters: schema },
    ] }],
  });
  expect(third.input.slice(0, second.input.length)).toEqual(second.input);
  expect(fourth.input.filter((item: { type?: string }) => item.type === 'additional_tools')).toEqual([]);
});

it.each([
  { scope: 'the flag is off', flag: '0', firstKey: sessionKey, nextKey: sessionKey },
  {
    scope: 'the next turn belongs to a different session', flag: '1',
    firstKey: sessionKey, nextKey: `relay-session-${'b'.repeat(32)}`,
  },
  {
    scope: 'the requests lack a recognized session identity', flag: '1',
    firstKey: 'relay-shared-key', nextKey: 'relay-shared-key',
  },
])('sends the current tool list when $scope', async ({ flag, firstKey, nextKey }) => {
  vi.stubEnv('LEVERFRAME_OPENAI_APPEND_ONLY_TOOLS', flag);
  const session = await openPlanSession();
  const { initial, discovery } = reportHistory();
  await session.turn(initial, ['Read'], firstKey);
  await session.turn(discovery, ['Read', 'Write'], nextKey);

  const requests = await session.requests();
  expect(requests.map(({ url, method }) => [url, method])).toEqual([
    ['https://api.openai.com/v1/responses', 'POST'], ['https://api.openai.com/v1/responses', 'POST'],
  ]);
  const second = requests[1]?.body;
  expect(second.tools).toMatchObject([{ name: 'claude_code', tools: [{ name: 'Read' }, { name: 'Write' }] }]);
  expect(second.input.filter((item: { type?: string }) => item.type === 'additional_tools')).toEqual([]);
});

it.each([
  {
    change: 'a same-length rewrite of prior input',
    revisedHistory: () => [
      { role: 'user', content: 'Inspect a different report.' },
      { role: 'assistant', content: 'I inspected the report.' },
      { role: 'user', content: 'Update the report.' },
    ] satisfies ModelMessage[],
    currentSchema: schema,
  },
  {
    change: 'a schema edit to an existing tool',
    revisedHistory: () => reportHistory().followup,
    currentSchema: { type: 'object', properties: { path: { type: 'string', pattern: '^reports/' } }, required: ['path'] } as const,
  },
])('resets tool declarations after $change', async ({ revisedHistory, currentSchema }) => {
  vi.stubEnv('LEVERFRAME_OPENAI_APPEND_ONLY_TOOLS', '1');
  const session = await openPlanSession();
  const { initial, discovery } = reportHistory();

  await session.turn(initial, ['Read']);
  await session.turn(discovery, ['Read', 'Write']);
  await session.turn(revisedHistory(), ['Read', 'Write'], sessionKey, currentSchema);

  const requests = await session.requests();
  expect(requests.map(({ url, method }) => [url, method])).toEqual([
    ['https://api.openai.com/v1/responses', 'POST'],
    ['https://api.openai.com/v1/responses', 'POST'],
    ['https://api.openai.com/v1/responses', 'POST'],
  ]);
  expect(requests[1]?.body.input.at(-1)).toMatchObject({ type: 'additional_tools', role: 'developer' });
  expect(requests[2]?.body.tools).toMatchObject([{ name: 'claude_code', tools: [
    { name: 'Read', parameters: currentSchema }, { name: 'Write', parameters: currentSchema },
  ] }]);
  expect(requests[2]?.body.input.filter((item: { type?: string }) => item.type === 'additional_tools')).toEqual([]);
});

it('keeps a tool in the request-level list when the new input already calls it', async () => {
  vi.stubEnv('LEVERFRAME_OPENAI_APPEND_ONLY_TOOLS', '1');
  const session = await openPlanSession();
  const { initial } = reportHistory();
  const discovery: ModelMessage[] = [...initial, {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'call_write', toolName: 'Write', input: { path: 'report.md' } }],
  }, {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'call_write', toolName: 'Write', output: { type: 'text', value: 'Saved' } }],
  }];

  await session.turn(initial, ['Read']);
  await session.turn(discovery, ['Read', 'Write']);

  const requests = await session.requests();
  expect(requests.map(({ url, method }) => [url, method])).toEqual([
    ['https://api.openai.com/v1/responses', 'POST'], ['https://api.openai.com/v1/responses', 'POST'],
  ]);
  const body = requests[1]?.body;
  expect(body.tools).toMatchObject([{ name: 'claude_code', tools: [{ name: 'Read' }, { name: 'Write' }] }]);
  expect(body.input).toContainEqual(expect.objectContaining({ type: 'function_call', name: 'Write', namespace: 'claude_code' }));
  expect(body.input.filter((item: { type?: string }) => item.type === 'additional_tools')).toEqual([]);
});
