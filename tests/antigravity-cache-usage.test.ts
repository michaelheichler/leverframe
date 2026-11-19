import { afterEach, expect, it, vi } from 'vitest';
import { generateText, streamText } from 'ai';
import { createAntigravityLanguageModel } from '../src/antigravity/provider.js';
import { generateAnthropicResponse } from '../src/sdk-non-streaming-response.js';
import { translateRequest } from '../src/sdk-request-translation.js';
import type { AnthropicUsageTrace } from '../src/sdk-usage.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

const { resolveAntigravityAuth } = vi.hoisted(() => ({ resolveAntigravityAuth: vi.fn() }));
vi.mock('../src/antigravity/auth.js', () => ({ resolveAntigravityAuth }));

useIsolatedTestHome('leverframe-antigravity-cache-usage');
afterEach(() => vi.resetAllMocks());

function upstreamPayload(usageMetadata: Record<string, number | null>) {
  return {
    response: {
      candidates: [{ content: { role: 'model', parts: [{ text: 'Fixture answer.' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 52, candidatesTokenCount: 3, totalTokenCount: 55, ...usageMetadata },
    },
  };
}

function modelForResponse(response: Response) {
  resolveAntigravityAuth.mockResolvedValue({
    accessToken: 'fixture-token', accountId: 'fixture-account', projectId: 'fixture-project',
  });
  const fetchUpstream = vi.fn<typeof fetch>().mockResolvedValue(response);
  const model = createAntigravityLanguageModel({
    modelId: 'gemini-3.1-pro-high', expectedAccountId: 'fixture-account', fetchImpl: fetchUpstream,
  });
  return { fetchUpstream, model };
}

const cacheCases: Array<{
  label: string;
  fields: Record<string, number | null>;
  cacheReadTokens?: number;
  noCacheTokens?: number;
}> = [
  { label: 'omitted', fields: {}, cacheReadTokens: undefined, noCacheTokens: undefined },
  { label: 'null', fields: { cachedContentTokenCount: null }, cacheReadTokens: undefined, noCacheTokens: undefined },
  { label: 'explicitly zero', fields: { cachedContentTokenCount: 0 }, cacheReadTokens: 0, noCacheTokens: 52 },
  { label: 'positive', fields: { cachedContentTokenCount: 40 }, cacheReadTokens: 40, noCacheTokens: 12 },
];

it.each(cacheCases)('keeps $label Antigravity cache reads distinct in a generated response', async ({
  fields, cacheReadTokens, noCacheTokens,
}) => {
  const { fetchUpstream, model } = modelForResponse(Response.json(upstreamPayload(fields)));
  const result = await generateText({ model, prompt: 'Fixture prompt.', maxRetries: 0 });

  expect(result.usage).toMatchObject({ inputTokens: 52, outputTokens: 3, inputTokenDetails: {
    cacheReadTokens, noCacheTokens,
  } });
  expect(result.providerMetadata).toMatchObject({ leverframeCacheUsage: { totalInputTokens: 52 } });
  expect(fetchUpstream.mock.calls).toEqual([[
    'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent', expect.objectContaining({ method: 'POST' }),
  ]]);
});

it.each(cacheCases)('keeps $label Antigravity cache reads distinct in a streamed response', async ({
  fields, cacheReadTokens, noCacheTokens,
}) => {
  const { fetchUpstream, model } = modelForResponse(new Response(
    `data: ${JSON.stringify(upstreamPayload(fields))}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  ));
  const result = streamText({ model, prompt: 'Fixture prompt.', maxRetries: 0 });

  expect(await result.totalUsage).toMatchObject({ inputTokens: 52, outputTokens: 3, inputTokenDetails: {
    cacheReadTokens, noCacheTokens,
  } });
  expect(await result.providerMetadata).toMatchObject({ leverframeCacheUsage: { totalInputTokens: 52 } });
  expect(fetchUpstream.mock.calls).toEqual([[
    'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    expect.objectContaining({ method: 'POST' }),
  ]]);
});

it('leaves unknown cache partitions out of the Antigravity usage audit', async () => {
  const { fetchUpstream, model } = modelForResponse(Response.json(upstreamPayload({})));
  const modelId = 'gemini-3.1-pro-high';
  const request = translateRequest({
    model: modelId, messages: [{ role: 'user', content: 'Fixture prompt.' }],
  }, '@ai-sdk/google', { reasoningMetadata: { providerId: 'antigravity' } });
  const audit: AnthropicUsageTrace[] = [];
  await generateAnthropicResponse(model, request, modelId, { onUsage: usage => audit.push(usage) });

  expect(audit).toEqual([{ model: modelId, output_tokens: 3, totalInputTokens: 52 }]);
  expect(fetchUpstream.mock.calls).toEqual([[
    'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent', expect.objectContaining({ method: 'POST' }),
  ]]);
});
