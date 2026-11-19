import { jsonSchema, streamText, tool } from 'ai';
import { expect, it, vi } from 'vitest';
import { createBuiltinOpenAiModel } from '../src/language-model-builtins.js';

import { upstreamResponsesStream } from './fixtures/chatgpt-plan-responses.js';

it('streams ChatGPT plan inference through the public endpoint with its bearer token', async () => {
  const fetchUpstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => upstreamResponsesStream());
  const model = await createBuiltinOpenAiModel({
    npm: '@ai-sdk/openai', modelId: 'gpt-6.2-sol', apiKey: 'plan-token', authType: 'oauth',
    providerId: 'openai-chatgpt-plan', baseURL: 'https://override.invalid',
    oauthAccountId: 'legacy-account',
    headers: { Authorization: 'Bearer override', originator: 'legacy', version: '0.159.2' },
    fetch: fetchUpstream,
  }, false);

  const parameters = {
    type: 'object',
    properties: { paths: { type: 'array', items: { type: 'string' }, uniqueItems: true } },
  } as const;
  const result = streamText({
    model,
    system: 'Keep responses brief.',
    prompt: 'Hello',
    tools: { Read: tool({ inputSchema: jsonSchema(parameters) }) },
    maxOutputTokens: 20,
    temperature: 0.5,
    providerOptions: { openai: {
      store: true, previousResponseId: 'remote-history', metadata: { source: 'test' },
      instructions: 'Follow the workspace rules.', promptCacheKey: 'session-cache-key',
    } },
    maxRetries: 0,
  });

  await expect(result.text).resolves.toBe('fixture response');
  expect(fetchUpstream).toHaveBeenCalledTimes(1);
  const [input, init] = fetchUpstream.mock.calls[0]!;
  const request = new Request(input, init);
  expect(request.url).toBe('https://api.openai.com/v1/responses');
  expect(request.method).toBe('POST');
  expect(request.redirect).toBe('error');
  expect(request.headers.get('authorization')).toBe('Bearer plan-token');
  expect(request.headers.get('chatgpt-account-id')).toBeNull();
  expect(request.headers.get('originator')).toBeNull();
  expect(request.headers.get('version')).toBeNull();
  expect(request.headers.get('x-openai-internal-codex-responses-lite')).toBeNull();
  const body = await request.json();
  expect(body).toMatchObject({
    model: 'gpt-6.2-sol', stream: true, store: false, prompt_cache_key: 'session-cache-key',
    input: expect.arrayContaining([
      expect.objectContaining({ role: 'developer', content: 'Keep responses brief.' }),
      { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
    ]),
    tools: [{
      type: 'namespace', name: 'claude_code',
      tools: [{ type: 'function', name: 'Read', parameters, strict: false }],
    }],
  });
  expect(body.input[0]).toEqual({
    type: 'message', role: 'developer',
    content: [{ type: 'input_text', text: 'Follow the workspace rules.' }],
  });
  expect(body).not.toHaveProperty('instructions');
  expect(body).not.toHaveProperty('max_output_tokens');
  expect(body).not.toHaveProperty('temperature');
  expect(body).not.toHaveProperty('previous_response_id');
  expect(body).not.toHaveProperty('metadata');
});

it('keeps top-level instructions for earlier ChatGPT plan models', async () => {
  const fetchUpstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => upstreamResponsesStream());
  const model = await createBuiltinOpenAiModel({
    npm: '@ai-sdk/openai', modelId: 'gpt-6.1-terra', apiKey: 'plan-token',
    authType: 'oauth', providerId: 'openai-chatgpt-plan', fetch: fetchUpstream,
  }, true);

  const result = streamText({
    model, prompt: 'Hello', maxRetries: 0,
    providerOptions: { openai: { instructions: 'Follow the workspace rules.' } },
  });

  await expect(result.text).resolves.toBe('fixture response');
  expect(fetchUpstream.mock.calls).toEqual([[
    'https://api.openai.com/v1/responses', expect.objectContaining({ method: 'POST' }),
  ]]);
  const [input, init] = fetchUpstream.mock.calls[0]!;
  await expect(new Request(input, init).json()).resolves.toMatchObject({
    instructions: 'Follow the workspace rules.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
  });
});

it.each([
  ['Write then Read', ['Write', 'Read']],
  ['Read then Write', ['Read', 'Write']],
])('sends the same Astra tool prefix for %s', async (_label, names) => {
  const fetchUpstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => upstreamResponsesStream());
  const model = await createBuiltinOpenAiModel({
    npm: '@ai-sdk/openai', modelId: 'gpt-6.2-astra', apiKey: 'plan-token',
    authType: 'oauth', providerId: 'openai-chatgpt-plan', fetch: fetchUpstream,
  }, true);
  const parameters = {
    type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, uniqueItems: true } },
  } as const;
  const tools = Object.fromEntries(names.map(name => [name, tool({ inputSchema: jsonSchema(parameters) })]));

  await streamText({ model, tools, prompt: 'Hello', maxRetries: 0 }).text;

  expect(fetchUpstream.mock.calls).toEqual([[
    'https://api.openai.com/v1/responses', expect.objectContaining({ method: 'POST' }),
  ]]);
  const [input, init] = fetchUpstream.mock.calls[0]!;
  await expect(new Request(input, init).json()).resolves.toMatchObject({
    tools: [{
      type: 'namespace', name: 'claude_code',
      tools: [
        { type: 'function', name: 'Read', parameters, strict: false },
        { type: 'function', name: 'Write', parameters, strict: false },
      ],
    }],
  });
});

it('rejects partial ChatGPT plan output when the upstream stream ends before a terminal event', async () => {
  const fetchUpstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => upstreamResponsesStream('fixture response', false));
  const model = await createBuiltinOpenAiModel({
    npm: '@ai-sdk/openai', modelId: 'gpt-6.2-sol', apiKey: 'plan-token',
    authType: 'oauth', providerId: 'openai-chatgpt-plan', fetch: fetchUpstream,
  }, true);

  const result = streamText({ model, prompt: 'Hello', maxRetries: 0, onError: () => {} });

  await expect(result.text).rejects.toThrow(/terminal event/i);
  expect(fetchUpstream.mock.calls).toEqual([[
    'https://api.openai.com/v1/responses', expect.objectContaining({ method: 'POST' }),
  ]]);
});

it.each([
  { modelId: 'gpt-6.2-astra', label: 'omitted', tokenDetails: {}, expectedCacheRead: undefined },
  { modelId: 'gpt-6.2-astra', label: 'reported as zero', tokenDetails: { cached_tokens: 0 }, expectedCacheRead: 0 },
  { modelId: 'gpt-6-luna', label: 'omitted', tokenDetails: {}, expectedCacheRead: undefined },
  { modelId: 'gpt-6-luna', label: 'reported as zero', tokenDetails: { cached_tokens: 0 }, expectedCacheRead: 0 },
])('keeps the $modelId cache count $label', async ({ modelId, tokenDetails, expectedCacheRead }) => {
  const fetchUpstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const fixture = upstreamResponsesStream();
    const events = (await fixture.text()).replace('{"cached_tokens":0}', JSON.stringify(tokenDetails));
    return new Response(events, { headers: fixture.headers });
  });
  const model = await createBuiltinOpenAiModel({
    npm: '@ai-sdk/openai', modelId, apiKey: 'plan-token',
    authType: 'oauth', providerId: 'openai-chatgpt-plan', fetch: fetchUpstream,
  }, true);

  const usage = await streamText({ model, prompt: 'Hello', maxRetries: 0 }).totalUsage;

  expect(usage.inputTokens).toBe(1);
  expect(usage.inputTokenDetails.cacheReadTokens).toBe(expectedCacheRead);
  expect(fetchUpstream.mock.calls).toEqual([[
    'https://api.openai.com/v1/responses', expect.objectContaining({ method: 'POST' }),
  ]]);
});

function diagnosticFetchFixture() {
  const responses = [
    { id: 'resp_first' },
    { id: 'resp_second', requestId: 'req_second', diagnostics: {
      type: 'cache_miss', reason: 'tools_changed', comparison_reusable_tokens: 2500, cache_missed_tokens: 2000,
    } },
    { id: 'resp_other', requestId: 'PRIVATE HEADER FIXTURE' },
  ];
  let responseIndex = 0;
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const fixture = upstreamResponsesStream();
    const { id, diagnostics, requestId } = responses[responseIndex++]!;
    const events = (await fixture.text()).replaceAll('response-id', id)
      .replace('"usage":', `"prompt_cache_diagnostics":${JSON.stringify(diagnostics ?? null)},"usage":`);
    const headers = new Headers(fixture.headers);
    if (requestId) headers.set('x-request-id', requestId);
    return new Response(events, { headers });
  });
}

it('compares Astra responses only within the same session when diagnostics are enabled', async () => {
  vi.stubEnv('LEVERFRAME_OPENAI_CACHE_DIAGNOSTICS', '1');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const fetchUpstream = diagnosticFetchFixture();
    const model = await createBuiltinOpenAiModel({
      npm: '@ai-sdk/openai', modelId: 'gpt-6.2-astra', apiKey: 'plan-token',
      authType: 'oauth', providerId: 'openai-chatgpt-plan', fetch: fetchUpstream,
    }, true);
    const send = (promptCacheKey: string) => streamText({
      model, prompt: 'Hello', maxRetries: 0, providerOptions: { openai: { promptCacheKey } },
    }).text;
    const sessionKey = `relay-session-${'a'.repeat(32)}`;
    const otherSessionKey = `relay-session-${'b'.repeat(32)}`;

    await send(sessionKey);
    await send(sessionKey);
    await send(otherSessionKey);

    const requests = fetchUpstream.mock.calls.map(([input, init]) => new Request(input, init));
    expect(requests.map(request => [request.url, request.method])).toEqual([
      ['https://api.openai.com/v1/responses', 'POST'],
      ['https://api.openai.com/v1/responses', 'POST'],
      ['https://api.openai.com/v1/responses', 'POST'],
    ]);
    const bodies = await Promise.all(requests.map(request => request.json()));
    expect(bodies.map(body => [body.prompt_cache_key, body.prompt_cache_options?.comparison_response_id])).toEqual([
      [sessionKey, undefined],
      [sessionKey, 'resp_first'],
      [otherSessionKey, undefined],
    ]);
    expect(bodies.map(body => [body.store, body.stream, body.previous_response_id])).toEqual([
      [false, true, undefined], [false, true, undefined], [false, true, undefined],
    ]);
    const prefix = '[leverframe openai cache] ';
    const entries = log.mock.calls.map(([line]) => String(line))
      .filter(line => line.startsWith(prefix)).map(line => JSON.parse(line.slice(prefix.length)));
    expect(entries).toHaveLength(3);
    const [first, second, other] = entries;
    expect(second).toMatchObject({
      inputTokens: 1, cachedTokens: 0, outcome: 'cache_miss', reason: 'tools_changed',
      reusableTokens: 2500, missedTokens: 2000, baselineState: 'recent', sessionTag: first.sessionTag,
      comparisonSent: true, upstreamRequestId: 'req_second',
    });
    expect(other).toMatchObject({ baselineState: 'cold', sessionTag: expect.stringMatching(/^[a-f0-9]{16}$/) });
    expect(other.sessionTag).not.toBe(first.sessionTag);
    expect(log.mock.calls.flat().join('\n')).not.toMatch(/resp_(?:first|second|other)|relay-session-|PRIVATE HEADER FIXTURE/);
  } finally {
    log.mockRestore();
    vi.unstubAllEnvs();
  }
});
