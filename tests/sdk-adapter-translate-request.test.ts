import { describe, it, expect } from 'vitest';
import { OPENAI_OAUTH_ASTRA_MODEL } from './fixtures/openai-oauth-astra-metadata.js';
import {
  anthropicEffortFromRequest,
  translateRequest,
} from '../src/sdk-adapter.js';

describe('translateRequest', () => {
  it('assembles SDK params and adds Google thinking options', () => {
    const params = translateRequest({
      model: 'gemini-3-flash-preview',
      system: 'be brief',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 256,
      temperature: 0.5,
    }, '@ai-sdk/google', { reasoningMetadata: { reasoning: true } });
    expect(params.instructions).toBe('be brief');
    expect(params.maxOutputTokens).toBe(256);
    expect(params.temperature).toBe(0.5);
    expect(params.maxRetries).toBe(1);
    expect((params.providerOptions?.google?.thinkingConfig as Record<string, unknown> | undefined)?.includeThoughts).toBe(true);
    expect(params.inputTokensIncludeCache).toBe(false);
  });

  it('requests OpenAI encrypted reasoning for Responses API round-trip', () => {
    const params = translateRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/openai');
    expect(params.providerOptions?.openai).toMatchObject({
      store: false, include: ['reasoning.encrypted_content'],
    });
    expect(params.inputTokensIncludeCache).toBe(true);
    expect(translateRequest({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/anthropic').inputTokensIncludeCache).toBe(true);
    expect(translateRequest({
      model: 'compatible-test',
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/openai-compatible').inputTokensIncludeCache).toBe(true);
    expect(translateRequest({
      model: 'vertex-claude-test',
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/google-vertex/anthropic').inputTokensIncludeCache).toBe(true);
  });

  it('sends instructions via providerOptions and omits system/max_tokens for OpenAI OAuth', () => {
    const params = translateRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32000,
    }, '@ai-sdk/openai', { openAiOAuth: true });

    expect(params.instructions).toBeUndefined();
    expect(params.providerOptions?.openai?.instructions).toBe('You are a coding assistant.');
    expect(params.maxOutputTokens).toBeUndefined();
    expect(params.maxRetries).toBe(0);
  });

  it('strips Claude Code Anthropic billing attribution from OpenAI OAuth instructions only', () => {
    const body = {
      model: 'gpt-5.6-terra',
      system: [
        {
          text: 'x-anthropic-billing-header: cc_version=2.1.207.9bb; cc_entrypoint=cli; cch=24e85;',
        },
        { text: 'You are Claude Code.\nFollow the user instructions.' },
      ],
      messages: [{ role: 'user' as const, content: 'hello' }],
    };

    const oauth = translateRequest(body, '@ai-sdk/openai', { openAiOAuth: true });
    expect(oauth.providerOptions?.openai?.instructions)
      .toBe('You are Claude Code.\nFollow the user instructions.');

    const changedAttribution = translateRequest({
      ...body,
      system: [
        { text: 'x-anthropic-billing-header: cc_version=2.1.207.9bb; cc_entrypoint=cli; cch=cb57d;' },
        body.system[1]!,
      ],
    }, '@ai-sdk/openai', { openAiOAuth: true });
    expect(changedAttribution.providerOptions?.openai?.instructions)
      .toBe(oauth.providerOptions?.openai?.instructions);
    expect(changedAttribution.providerOptions?.openai?.promptCacheKey)
      .toBe(oauth.providerOptions?.openai?.promptCacheKey);

    const publicApi = translateRequest({ ...body, model: 'gpt-5.5' }, '@ai-sdk/openai');
    expect(publicApi.instructions).toContain('x-anthropic-billing-header:');
  });

  it('maps output_config.effort to the reported Google level without guessing a budget', () => {
    const params = translateRequest({
      model: 'gemini-2.5-pro',
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/google', {
      reasoningMetadata: {
        reasoning: true,
        supportedReasoningEfforts: ['high'],
      },
    });
    expect(params.providerOptions?.google?.thinkingConfig).toMatchObject({
      includeThoughts: true,
      thinkingLevel: 'high',
    });
    expect((params.providerOptions?.google?.thinkingConfig as Record<string, unknown> | undefined)?.thinkingBudget).toBeUndefined();
  });

  it('maps output_config.effort to OpenAI reasoningEffort without dropping store/include', () => {
    const params = translateRequest({
      model: OPENAI_OAUTH_ASTRA_MODEL.slug,
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/openai', {
      reasoningMetadata: {
        reasoning: true,
        supportedReasoningEfforts: OPENAI_OAUTH_ASTRA_MODEL.supported_reasoning_levels.map(level => level.effort),
        supportsReasoningSummaries: OPENAI_OAUTH_ASTRA_MODEL.supports_reasoning_summaries,
      },
    });
    expect(params.providerOptions?.openai).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoningEffort: 'high',
    });
  });

  it('maps output_config.effort to OpenRouter reasoning when provider metadata allows it', () => {
    const params = translateRequest({
      model: 'z-ai/glm-5.2',
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'hi' }],
    }, '@openrouter/ai-sdk-provider', {
      reasoningMetadata: {
        providerId: 'openrouter',
        supportedParameters: ['reasoning'],
        supportedReasoningEfforts: ['high'],
      },
    });
    expect(params.providerOptions?.openrouter).toEqual({
      reasoning: {
        effort: 'high',
        exclude: false,
      },
    });
  });

  it('uses defaultEffort when the client omits output_config.effort', () => {
    const params = translateRequest({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/google', {
      defaultEffort: 'medium',
      reasoningMetadata: {
        reasoning: true,
        supportedReasoningEfforts: ['medium'],
      },
    });
    expect(params.providerOptions?.google?.thinkingConfig).toMatchObject({
      thinkingLevel: 'medium',
    });
  });

  it('applies reasoning effort using reasoningMetadata.upstreamModelId, not the gateway-aliased body.model', () => {
    const params = translateRequest({
      model: 'anthropic-xai__grok-4.3',
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/xai', {
      reasoningMetadata: {
        upstreamModelId: 'grok-4.3',
        reasoning: true,
        supportedReasoningEfforts: ['high'],
      },
    });
    expect(params.providerOptions?.xai).toMatchObject({ reasoningEffort: 'high' });
  });

  it('does not apply reasoning effort when only the gateway-aliased model id is available (regression guard)', () => {
    const params = translateRequest({
      model: 'anthropic-xai__grok-4.3',
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/xai');
    expect(params.providerOptions?.xai).toBeUndefined();
  });

  it('reads effort from output_config via anthropicEffortFromRequest', () => {
    expect(anthropicEffortFromRequest({ model: 'm', messages: [], output_config: { effort: 'high' } })).toBe('high');
    expect(anthropicEffortFromRequest({ model: 'm', messages: [] })).toBeUndefined();
  });

  it('maps output_config.effort to DeepSeek reasoning_effort via openai-compatible', () => {
    const params = translateRequest({
      model: 'deepseek-v4-flash',
      output_config: { effort: 'max' },
      messages: [{ role: 'user', content: 'hi' }],
    }, '@ai-sdk/openai-compatible', {
      reasoningMetadata: {
        reasoning: true,
        supportedReasoningEfforts: ['high', 'max'],
        supportsReasoningToggle: true,
      },
    });
    expect(params.providerOptions?.openaiCompatible).toMatchObject({ reasoningEffort: 'max' });
    expect(params.providerOptions?.deepseek).toMatchObject({ thinking: { type: 'enabled' } });
  });
  it('flattens array system prompts', () => {
    const params = translateRequest({
      model: 'grok-4.3', system: [{ text: 'a' }, { text: 'b' }], messages: [],
    }, '@ai-sdk/xai');
    expect(params.instructions).toBe('a\nb');
  });

  it('preserves inline role:system messages in their original position', () => {
    const params = translateRequest({
      model: 'grok-4.3',
      system: 'base prompt',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: '<system-reminder>available skills: nlm-skill</system-reminder>' } as any,
        { role: 'user', content: 'continue' },
      ],
    }, '@ai-sdk/xai');
    expect(params.instructions).toBe('base prompt');
    expect(params.allowSystemInMessages).toBe(true);
    expect((params.messages as any[]).map(message => message.role)).toEqual(['user', 'system', 'user']);
    expect((params.messages[1] as any).content).toContain('nlm-skill');
  });

  it('keeps an inline-only system message in the message sequence', () => {
    const params = translateRequest({
      model: 'grok-4.3',
      messages: [{ role: 'system', content: 'only inline context' } as any],
    }, '@ai-sdk/xai');
    expect(params.instructions).toBeUndefined();
    expect(params.allowSystemInMessages).toBe(true);
    expect(params.messages).toEqual([{ role: 'system', content: 'only inline context' }]);
  });

  it('maps Claude cache_control blocks to GPT-5.6 explicit cache breakpoints', () => {
    const params = translateRequest({
      model: 'gpt-5.6',
      system: [{ text: 'stable base', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: 'before' },
        {
          role: 'system',
          content: [{
            type: 'text',
            text: 'stable injected context',
            cache_control: { type: 'ephemeral' },
          }],
        } as any,
        {
          role: 'user',
          content: [{
            type: 'text',
            text: 'stable history',
            cache_control: { type: 'ephemeral' },
          }],
        },
      ],
    }, '@ai-sdk/openai', {
      reasoningMetadata: { supportsPromptCacheBreakpoints: true },
    });

    expect(params.instructions).toBeUndefined();
    expect((params.messages as any[]).map(message => message.role)).toEqual(['system', 'user', 'system', 'user']);
    expect((params.messages[0] as any).providerOptions).toEqual({
      openai: { promptCacheBreakpoint: { mode: 'explicit' } },
    });
    expect((params.messages[2] as any).providerOptions).toEqual({
      openai: { promptCacheBreakpoint: { mode: 'explicit' } },
    });
    expect((params.messages[3] as any).content[0].providerOptions).toEqual({
      openai: { promptCacheBreakpoint: { mode: 'explicit' } },
    });
    expect(params.providerOptions?.openai?.promptCacheOptions).toEqual({ mode: 'implicit', ttl: '30m' });
  });

  it('does not emit unsupported explicit cache options before GPT-5.6', () => {
    const params = translateRequest({
      model: 'gpt-5.5',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } }],
      }],
    }, '@ai-sdk/openai');

    expect(params.providerOptions?.openai?.promptCacheOptions).toBeUndefined();
    expect((params.messages[0] as any).content[0].providerOptions).toBeUndefined();
  });

  it('omits defer_loading tools until referenced in messages', () => {
    const params = translateRequest({
      model: 'grok-4.3',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { name: 'Read', input_schema: { type: 'object' } },
        {
          name: 'McpTool',
          input_schema: { type: 'object' },
          defer_loading: true,
        } as NonNullable<Parameters<typeof translateRequest>[0]['tools']>[number] & {
          defer_loading: true;
        },
      ],
    }, '@ai-sdk/xai');
    expect(params.tools && Object.keys(params.tools)).toEqual(['Read']);
  });

  it('disables tools for Claude Code compact requests without changing ordinary structured output', () => {
    const compactInstruction = [
      'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.',
      'Your task is to create a detailed summary of the conversation so far.',
      'REMINDER: Do NOT call any tools. Respond with plain text only.',
    ].join('\n');
    const tools = [
      { name: 'Read', input_schema: { type: 'object' } },
      { name: 'StructuredOutput', input_schema: { type: 'object' } },
    ];
    const compactBody = {
      model: 'gpt-5.6-sol',
      messages: [{
        role: 'user' as const,
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'file body' },
          { type: 'text', text: compactInstruction },
        ],
      }],
      tools,
      tool_choice: { type: 'any' as const },
    };

    const compact = translateRequest(compactBody, '@ai-sdk/openai', { openAiOAuth: true });
    expect(compact.tools && Object.keys(compact.tools)).toEqual(['Read', 'StructuredOutput']);
    expect(compact.toolChoice).toBe('none');
    expect(compact.messages.map(message => message.role)).toEqual(['tool', 'user']);
    expect(compact.messages[1]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: compactInstruction }],
    });
    expect(compact.providerOptions?.openai?.instructions).toContain('under 16,000 output tokens');
    expect(tools).toEqual([
      { name: 'Read', input_schema: { type: 'object' } },
      { name: 'StructuredOutput', input_schema: { type: 'object' } },
    ]);

    const partialMarker = translateRequest({
      ...compactBody,
      messages: [{
        role: 'user',
        content: compactInstruction.replace(/\nREMINDER:.*$/, ''),
      }],
    }, '@ai-sdk/openai', { openAiOAuth: true });
    expect(partialMarker.tools && Object.keys(partialMarker.tools)).toEqual(['Read', 'StructuredOutput']);
    expect(partialMarker.toolChoice).toBe('required');

    const ordinary = translateRequest({
      ...compactBody,
      diagnostics: { previous_message_id: null },
    }, '@ai-sdk/openai', { openAiOAuth: true });
    expect(ordinary.tools && Object.keys(ordinary.tools)).toEqual(['Read', 'StructuredOutput']);
    expect(ordinary.toolChoice).toBe('required');
    expect(ordinary.providerOptions?.openai?.instructions).not.toContain('under 16,000 output tokens');
    expect(compact.providerOptions?.openai?.promptCacheKey)
      .toBe(ordinary.providerOptions?.openai?.promptCacheKey);
  });
});
