import { expect, it, vi } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { translateRequest } from '../src/sdk-adapter.js';
import { OPENAI_OAUTH_ASTRA_MODEL } from './fixtures/openai-oauth-astra-metadata.js';

it('sends Astra low-effort requests without foreign encrypted reasoning and preserves tool history', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
    error: { message: 'fixture rejection' },
  }), { status: 400, headers: { 'content-type': 'application/json' } }));
  const model = createOpenAI({ apiKey: 'fixture-token', baseURL: 'https://models.example.test/v1', fetch })
    .responses('gpt-6-astra');
  const params = translateRequest({
    model: 'gpt-6-astra', output_config: { effort: 'low' },
    messages: [
      { role: 'user', content: 'Read the file.' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: '', signature: 'CAQSfixtureGAE=' },
        { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.txt' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'file contents' },
        { type: 'text', text: 'Summarize it.' },
      ] },
    ],
  }, '@ai-sdk/openai', {
    openAiOAuth: true,
    reasoningMetadata: {
      upstreamModelId: 'gpt-6-astra', reasoning: true,
      supportedReasoningEfforts: OPENAI_OAUTH_ASTRA_MODEL.supported_reasoning_levels.map(level => level.effort),
      useResponsesLite: OPENAI_OAUTH_ASTRA_MODEL.use_responses_lite,
    },
  });

  await expect(generateText({
    model, ...params, maxRetries: 0,
    providerOptions: params.providerOptions as Parameters<typeof generateText>[0]['providerOptions'],
  })).rejects.toThrow('fixture rejection');

  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith('https://models.example.test/v1/responses', expect.objectContaining({
    method: 'POST', body: expect.any(String),
  }));
  const wire = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
  expect(wire.reasoning).toMatchObject({ effort: 'low' });
  expect(JSON.stringify(wire.input)).not.toContain('CAQSfixtureGAE=');
  expect(wire.input).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"a.txt"}' }),
    expect.objectContaining({ type: 'function_call_output', call_id: 'call_1', output: 'file contents' }),
  ]));
  expect(JSON.stringify(wire.input)).toContain('Summarize it.');
});
