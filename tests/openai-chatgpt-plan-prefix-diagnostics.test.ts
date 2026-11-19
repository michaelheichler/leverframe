import { jsonSchema, streamText, tool, type ModelMessage } from 'ai';
import { afterEach, expect, it, vi } from 'vitest';
import { createBuiltinOpenAiModel } from '../src/language-model-builtins.js';
import { upstreamResponsesStream } from './fixtures/chatgpt-plan-responses.js';

const sessionKey = `relay-session-${'a'.repeat(32)}`;
const privateInstructions = 'PRIVATE INSTRUCTIONS FIXTURE';
const privateQuestion = 'PRIVATE QUESTION FIXTURE';
const prefixLog = '[leverframe openai prefix] ';
const cacheLog = '[leverframe openai cache] ';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function openDiagnosticSession(options?: { mode?: '0' | '1'; modelId?: string }) {
  vi.stubEnv('LEVERFRAME_OPENAI_CACHE_DIAGNOSTICS', options ? options.mode : '1');
  vi.stubEnv('LEVERFRAME_OPENAI_APPEND_ONLY_TOOLS', '0');
  const consoleLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetchUpstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => cacheResponse(0));
  const model = await createBuiltinOpenAiModel({
    npm: '@ai-sdk/openai', modelId: options?.modelId ?? 'gpt-6.2-astra', apiKey: 'fixture-token',
    authType: 'oauth', providerId: 'openai-chatgpt-plan', fetch: fetchUpstream,
  }, true);
  return {
    turn: (messages: ModelMessage[], key = sessionKey, tools = false, instructions = privateInstructions) => streamText({
      model, messages, maxRetries: 0,
      tools: {
        Read: tool({ inputSchema: jsonSchema({ type: 'object' }) }),
        ...(tools ? { Write: tool({ inputSchema: jsonSchema({ type: 'object' }) }) } : {}),
      },
      providerOptions: { openai: { promptCacheKey: key, instructions } },
    }).text,
    rejectNextTurn: () => fetchUpstream.mockImplementationOnce(async () => Response.json({
      error: { message: 'Fixture refusal' },
    }, { status: 400 })),
    nextCacheResponse: (cachedTokens: number | undefined, diagnostics?: { type: string }) =>
      fetchUpstream.mockImplementationOnce(() => cacheResponse(cachedTokens, diagnostics)),
    delayNextResponse: () => {
      const { promise, resolve } = deferred<Response>();
      const { promise: started, resolve: signalStarted } = deferred<void>();
      fetchUpstream.mockImplementationOnce(() => {
        signalStarted();
        return promise;
      });
      return { started, release: async () => resolve(await cacheResponse(0)) };
    },
    requests: () => fetchUpstream.mock.calls.map(([url, init]) => {
      const request = new Request(url, init);
      return [request.url, request.method];
    }),
    requestCacheOptions: () => fetchUpstream.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)).prompt_cache_options?.comparison_response_id),
    log: () => consoleLog.mock.calls.map(([line]) => line).filter((line): line is string => typeof line === 'string'),
  };
}

async function cacheResponse(cachedTokens?: number, diagnostics?: { type: string }) {
  const body = (await upstreamResponsesStream().text()).replaceAll('response-id', 'resp_fixture');
  const usage = {
    input_tokens: 1200, output_tokens: 1,
    input_tokens_details: { cached_tokens: cachedTokens },
  };
  const fields = JSON.stringify({ prompt_cache_diagnostics: diagnostics, usage }).slice(1, -1);
  return new Response(body.replace(/"usage":\{.*\}(?=\}\}\n)/, fields), {
    headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'req_fixture_record' },
  });
}

function readPrefixDiagnostics(lines: string[]) {
  return lines.filter(line => line.startsWith(prefixLog)).map(line => JSON.parse(line.slice(prefixLog.length)));
}

function readCacheDiagnostics(lines: string[]) {
  return lines.filter(line => line.startsWith(cacheLog)).map(line => JSON.parse(line.slice(cacheLog.length)));
}

const responsesPost = ['https://api.openai.com/v1/responses', 'POST'];

it.each(['gpt-6.2-astra', 'gpt-6-luna'])('records local cache diagnostics for %s without sending a comparison by default', async modelId => {
  const session = await openDiagnosticSession({ modelId });
  const initial: ModelMessage[] = [{ role: 'user', content: privateQuestion }];
  await session.turn(initial);
  session.nextCacheResponse(0);

  await session.turn([...initial, { role: 'user', content: 'Next question' }]);

  expect(session.requests()).toEqual([responsesPost, responsesPost]);
  expect(session.requestCacheOptions()).toEqual([undefined, undefined]);
  const [first, second] = readCacheDiagnostics(session.log());
  expect(first).toMatchObject({
    model: modelId, sessionTag: expect.stringMatching(/^[a-f0-9]{16}$/), requestSequence: 1,
    comparisonMode: 'local-only', baselineState: 'cold',
  });
  expect(second).toMatchObject({
    model: modelId, sessionTag: first.sessionTag, requestSequence: 2, comparisonMode: 'local-only',
    baselineState: 'recent', prefix: { firstChangedSection: 'none' }, baselineAgeMs: expect.any(Number),
    newerRequestWasSent: false, localFinding: 'stable-prefix-zero-read', inputTokens: 1200, cachedTokens: 0,
  });
  expect(second).not.toHaveProperty('outcome');
  expect(session.log().join('\n')).not.toMatch(/PRIVATE|relay-session|fixture-token|resp_fixture|req_fixture_record/);
});

it('keeps local diagnostics off when explicitly disabled', async () => {
  const session = await openDiagnosticSession({ mode: '0' });
  const initial: ModelMessage[] = [{ role: 'user', content: privateQuestion }];
  await session.turn(initial);

  await session.turn([...initial, { role: 'user', content: 'Next question' }]);

  expect(session.requests()).toEqual([responsesPost, responsesPost]);
  expect(session.requestCacheOptions()).toEqual([undefined, undefined]);
  expect(readCacheDiagnostics(session.log())).toEqual([]);
});

it('reports known cache usage without retaining a baseline for a non-session key', async () => {
  const session = await openDiagnosticSession({ mode: '1' });
  const personalKey = 'PRIVATE CUSTOM CACHE KEY';
  const initial: ModelMessage[] = [{ role: 'user', content: privateQuestion }];
  await session.turn(initial, personalKey);

  await session.turn(initial, personalKey);

  expect(session.requests()).toEqual([responsesPost, responsesPost]);
  expect(session.requestCacheOptions()).toEqual([undefined, undefined]);
  const entries = readCacheDiagnostics(session.log());
  expect(entries).toMatchObject([
    { baselineState: 'no-session-key', cachedTokens: 0, localFinding: 'unknown' },
    { baselineState: 'no-session-key', cachedTokens: 0, localFinding: 'unknown' },
  ]);
  expect(session.log().join('\n')).not.toMatch(/PRIVATE|sessionTag/);
});

it('identifies an intervening request sent after the comparison baseline', async () => {
  const session = await openDiagnosticSession({});
  const initial: ModelMessage[] = [{ role: 'user', content: privateQuestion }];
  await session.turn(initial);
  const delayed = session.delayNextResponse();
  const pending = session.turn([...initial, { role: 'user', content: 'Delayed response' }]);
  await delayed.started;

  try {
    await session.turn([...initial, { role: 'user', content: 'Concurrent response' }]);
  } finally {
    await delayed.release();
    await pending;
  }

  expect(session.requests()).toEqual([responsesPost, responsesPost, responsesPost]);
  expect(readCacheDiagnostics(session.log())).toMatchObject([
    { requestSequence: 1, baselineState: 'cold' },
    { requestSequence: 3, baselineState: 'recent', newerRequestWasSent: true },
    { requestSequence: 2, baselineState: 'recent', newerRequestWasSent: false },
  ]);
});

it('reports the comparison baseline as expired after inactivity', async () => {
  const session = await openDiagnosticSession({ mode: '1' });
  const initial: ModelMessage[] = [{ role: 'user', content: privateQuestion }];
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  await session.turn(initial);
  clock.mockReturnValue(1_800_000_960_000);

  await session.turn(initial);

  expect(session.requests()).toEqual([responsesPost, responsesPost]);
  expect(session.requestCacheOptions()).toEqual([undefined, undefined]);
  expect(readCacheDiagnostics(session.log())[1]).toMatchObject({
    baselineState: 'expired', localFinding: 'unknown', cachedTokens: 0,
  });
  expect(readPrefixDiagnostics(session.log())).toEqual([]);
});

it.each([
  { modelId: 'gpt-6.2-astra', cachedTokens: 900, finding: 'cache-read', mode: 'openai', comparison: 'resp_fixture' },
  { modelId: 'gpt-6.2-astra', cachedTokens: 0, finding: 'stable-prefix-zero-read', mode: 'openai', comparison: 'resp_fixture' },
  { modelId: 'gpt-6.2-astra', cachedTokens: undefined, finding: 'unknown', mode: 'openai', comparison: 'resp_fixture' },
  { modelId: 'gpt-6-luna', cachedTokens: 0, finding: 'stable-prefix-zero-read', mode: 'local-only', comparison: undefined },
] as const)('separates $finding from the upstream outcome for $modelId', async ({
  modelId, cachedTokens, finding, mode, comparison,
}) => {
  const session = await openDiagnosticSession({ modelId, mode: '1' });
  const initial: ModelMessage[] = [{ role: 'user', content: privateQuestion }];
  await session.turn(initial);
  session.nextCacheResponse(cachedTokens, { type: 'unavailable' });

  await session.turn([...initial, { role: 'user', content: 'Next question' }]);

  expect(session.requests()).toEqual([responsesPost, responsesPost]);
  expect(session.requestCacheOptions()).toEqual([undefined, comparison]);
  const second = readCacheDiagnostics(session.log())[1];
  expect(second).toMatchObject({
    outcome: 'unavailable', localFinding: finding, comparisonMode: mode, baselineState: 'recent',
  });
  expect(second.cachedTokens).toBe(cachedTokens);
});

it.each([
  { scenario: 'an appended user item', extra: true, tools: false, instructions: privateInstructions, expected: 'none', shared: 2 },
  { scenario: 'a tool addition', extra: false, tools: true, instructions: privateInstructions, expected: 'tools', shared: 2 },
  { scenario: 'a developer instruction edit', extra: false, tools: false, instructions: 'CHANGED INSTRUCTIONS', expected: 'instructions', shared: 0 },
])('reports the changed prefix section for $scenario without logging input', async ({ extra, tools, instructions, expected, shared }) => {
  const session = await openDiagnosticSession();
  const initial: ModelMessage[] = [{ role: 'user', content: privateQuestion }];
  const second: ModelMessage[] = extra ? [...initial, { role: 'user', content: 'PRIVATE NEW QUESTION' }] : initial;
  await session.turn(initial);
  await session.turn(second, sessionKey, tools, instructions);

  expect(session.requests()).toEqual([responsesPost, responsesPost]);
  expect(readPrefixDiagnostics(session.log())).toEqual([{
    firstChangedSection: expected, sharedInputItems: shared, previousInputItems: 2, inputItems: extra ? 3 : 2,
  }]);
  expect(session.log().join('\n')).not.toMatch(/PRIVATE|CHANGED INSTRUCTIONS|relay-session|fixture-token|response-id/);
});

it('retains the last completed baseline after a failed request', async () => {
  const session = await openDiagnosticSession();
  const initial: ModelMessage[] = [{ role: 'user', content: privateQuestion }];
  await session.turn(initial);
  session.rejectNextTurn();
  await expect(Promise.resolve(session.turn([{ role: 'user', content: 'Failed edited question' }]))).rejects.toThrow();
  await session.turn([...initial, { role: 'user', content: 'Next question' }]);

  expect(session.requests()).toEqual([responsesPost, responsesPost, responsesPost]);
  expect(readPrefixDiagnostics(session.log())).toEqual([{
    firstChangedSection: 'none', sharedInputItems: 2, previousInputItems: 2, inputItems: 3,
  }]);
});
