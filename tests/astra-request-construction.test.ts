import { describe, expect, it } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { translateRequest } from '../src/sdk-adapter.js';
import { OPENAI_OAUTH_ASTRA_MODEL } from './fixtures/openai-oauth-astra-metadata.js';

describe('reported OpenAI reasoning capabilities', () => {
  it('uses reported Astra options and removes unsupported temperature', () => {
    const supportedReasoningEfforts = OPENAI_OAUTH_ASTRA_MODEL.supported_reasoning_levels.map(level => level.effort);
    const params = translateRequest({
      model: 'gpt-6-astra',
      output_config: { effort: 'max' },
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.4,
    }, '@ai-sdk/openai', {
      reasoningMetadata: {
        upstreamModelId: 'gpt-6-astra',
        reasoning: true,
        supportedReasoningEfforts,
        defaultReasoningEffort: OPENAI_OAUTH_ASTRA_MODEL.default_reasoning_level,
        supportsTemperature: OPENAI_OAUTH_ASTRA_MODEL.temperature,
        supportsReasoningSummaries: OPENAI_OAUTH_ASTRA_MODEL.supports_reasoning_summaries,
        supportsReasoningSummaryParameter: OPENAI_OAUTH_ASTRA_MODEL.supports_reasoning_summary_parameter,
        supportsParallelToolCalls: OPENAI_OAUTH_ASTRA_MODEL.supports_parallel_tool_calls,
        useResponsesLite: OPENAI_OAUTH_ASTRA_MODEL.use_responses_lite,
      },
    });

    expect(params.providerOptions?.openai).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoningEffort: 'max',
      forceReasoning: true,
      systemMessageMode: 'developer',
      reasoningContext: 'all_turns',
      parallelToolCalls: false,
    });
    expect(params.temperature).toBeUndefined();
  });

  it.each(['max', 'ultra'] as const)('passes reported %s through the OpenAI Responses SDK', async effort => {
    const requests: string[] = [];
    const model = createOpenAI({
      apiKey: 'fixture-token',
      baseURL: 'https://models.example.test/v1',
      fetch: async (_input, init) => {
        requests.push(String(init?.body ?? ''));
        return new Response(JSON.stringify({ error: { message: 'fixture rejection' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      },
    }).responses('gpt-6-astra');
    const supportedReasoningEfforts = OPENAI_OAUTH_ASTRA_MODEL.supported_reasoning_levels.map(level => level.effort);
    const params = translateRequest({
      model: 'gpt-6-astra',
      output_config: { effort },
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/openai', {
      reasoningMetadata: {
        reasoning: true,
        supportedReasoningEfforts,
        useResponsesLite: OPENAI_OAUTH_ASTRA_MODEL.use_responses_lite,
      },
    });

    await expect(model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: params.providerOptions as never,
    })).rejects.toBeDefined();

    expect(JSON.parse(requests[0] ?? '{}')).toMatchObject({
      reasoning: { effort },
      parallel_tool_calls: false,
    });
  });
});
