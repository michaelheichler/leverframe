import { describe, it, expect, vi } from 'vitest';
import {
  deepMergeProviderOptions,
  effortProviderOptions,
  getReasoningCapabilities,
  isSdkMigratedNpm,
  maxToolsForNpm,
  shouldUseOpenAiResponsesEndpoint,
  thinkingProviderOptions,
} from '../src/provider-factory.js';
import { VERTEX_ANTHROPIC_NPM } from '../src/constants.js';

vi.mock('../src/registry/url-security.js', () => ({
  isHardcodedTrustedHost: (url: string) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === 'api.openai.com' || host === 'api.anthropic.com' || host === 'chatgpt.com';
    } catch {
      return false;
    }
  },
  revalidateCustomEndpointUrl: vi.fn(async (url: string) => ({ ok: true, normalizedUrl: url })),
}));

describe('isSdkMigratedNpm', () => {
  it('returns true for any OpenCode-assigned npm except anthropic', () => {
    expect(isSdkMigratedNpm('@ai-sdk/openai')).toBe(true);
    expect(isSdkMigratedNpm('@ai-sdk/cerebras')).toBe(true);
    expect(isSdkMigratedNpm('@ai-sdk/perplexity')).toBe(true);
    expect(isSdkMigratedNpm('@openrouter/ai-sdk-provider')).toBe(true);
    expect(isSdkMigratedNpm('gitlab-ai-provider')).toBe(true);
    expect(isSdkMigratedNpm(VERTEX_ANTHROPIC_NPM)).toBe(true);
  });

  it('returns false for anthropic passthrough and missing npm', () => {
    expect(isSdkMigratedNpm('@ai-sdk/anthropic')).toBe(false);
    expect(isSdkMigratedNpm(undefined)).toBe(false);
    expect(isSdkMigratedNpm('')).toBe(false);
  });
});

describe('shouldUseOpenAiResponsesEndpoint', () => {
  it('defaults every OpenAI model to the Responses endpoint', () => {
    expect(shouldUseOpenAiResponsesEndpoint('gpt-4o')).toBe(true);
    expect(shouldUseOpenAiResponsesEndpoint('gpt-3.5-turbo')).toBe(true);
    expect(shouldUseOpenAiResponsesEndpoint('gpt-5.6-sol')).toBe(true);
    expect(shouldUseOpenAiResponsesEndpoint('gpt-7-does-not-exist-yet')).toBe(true);
  });

  it('honors an explicit Chat Completions capability', () => {
    expect(shouldUseOpenAiResponsesEndpoint('legacy-model', 'chat')).toBe(false);
  });
});

describe('maxToolsForNpm', () => {
  it('caps Groq tool lists at 128', () => {
    expect(maxToolsForNpm('@ai-sdk/groq')).toBe(128);
  });

  it('does not cap non-Groq providers', () => {
    expect(maxToolsForNpm('@ai-sdk/openai')).toBeUndefined();
    expect(maxToolsForNpm(undefined)).toBeUndefined();
  });
});

describe('getReasoningCapabilities', () => {
  it('returns anthropic levels for claude-sonnet-4-6', () => {
    const caps = getReasoningCapabilities('@ai-sdk/anthropic', 'claude-sonnet-4-6');
    expect(caps.levels).toEqual(['low', 'medium', 'high']);
    expect(caps.defaultLevel).toBe('high');
    expect(caps.supportsSummaries).toBe(true);
  });

  it('returns anthropic levels for Vertex Claude models', () => {
    const caps = getReasoningCapabilities(VERTEX_ANTHROPIC_NPM, 'claude-sonnet-4-6');
    expect(caps.levels).toEqual(['low', 'medium', 'high']);
    expect(caps.defaultLevel).toBe('high');
    expect(caps.wireFormat).toEqual({ kind: 'anthropic-thinking' });
  });

  it('returns empty levels for non-reasoning anthropic model', () => {
    const caps = getReasoningCapabilities('@ai-sdk/anthropic', 'claude-haiku-4-5-20251001');
    expect(caps.levels).toEqual([]);
    expect(caps.defaultLevel).toBe('');
    expect(caps.supportsSummaries).toBe(false);
  });

  it('uses the reported levels for a Mistral model', () => {
    const caps = getReasoningCapabilities('@ai-sdk/mistral', 'mistral-large', {
      reasoning: true,
      supportedReasoningEfforts: ['high', 'off'],
      defaultReasoningEffort: 'high',
    });
    expect(caps.levels).toEqual(['high', 'off']);
    expect(caps.defaultLevel).toBe('high');
  });

  it('does not turn a Google budget-token report into guessed effort levels', () => {
    const caps = getReasoningCapabilities('@ai-sdk/google', 'gemini-2.5-pro', { reasoning: true });
    expect(caps.levels).toEqual([]);
    expect(caps.defaultLevel).toBe('');
    expect(caps.mode).toBe('internal-only');
  });

  it('returns empty levels for unknown openai-compatible models', () => {
    const caps = getReasoningCapabilities('@ai-sdk/openai-compatible', 'unknown');
    expect(caps.levels).toEqual([]);
    expect(caps.defaultLevel).toBe('');
  });

  it('uses reported reasoning levels for a future OpenAI model', () => {
    const caps = getReasoningCapabilities('@ai-sdk/openai', 'gpt-6-astra', {
      reasoning: true,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: 'high',
    });

    expect(caps.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(caps.defaultLevel).toBe('high');
    expect(caps.source).toBe('model-metadata');
  });

  it('forces the SDK reasoning path from reported capabilities', () => {
    const metadata = {
      reasoning: true,
      supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    };

    expect(effortProviderOptions('@ai-sdk/openai', 'max', 'gpt-6-astra', metadata)).toEqual({
      openai: {
        reasoningEffort: 'max',
        forceReasoning: true,
        systemMessageMode: 'developer',
      },
    });
    expect(thinkingProviderOptions('@ai-sdk/openai', metadata)?.openai).toMatchObject({
      forceReasoning: true,
      systemMessageMode: 'developer',
    });
  });

});

describe('reported provider efforts', () => {
  it('rejects an effort absent from the reported levels', () => {
    expect(effortProviderOptions('@ai-sdk/openai', 'max', 'gpt-6-astra', {
      reasoning: true,
      supportedReasoningEfforts: ['low', 'medium', 'high'],
    })).toBeUndefined();
  });

  it('returns empty levels for grok-build-0.1 (internal reasoning only)', () => {
    const caps = getReasoningCapabilities('@ai-sdk/xai', 'grok-build-0.1');
    expect(caps.levels).toEqual([]);
  });

  it('uses the reported effort levels for xAI models', () => {
    const caps = getReasoningCapabilities('@ai-sdk/xai', 'grok-4.3', {
      reasoning: true,
      supportedReasoningEfforts: ['none', 'low', 'medium', 'high'],
      defaultReasoningEffort: 'low',
    });
    expect(caps.levels).toEqual(['none', 'low', 'medium', 'high']);
    expect(caps.defaultLevel).toBe('low');
  });

  it('preserves the reported xAI default exactly', () => {
    const caps = getReasoningCapabilities('@ai-sdk/xai', 'grok-4.5', {
      reasoning: true,
      supportedReasoningEfforts: ['none', 'low', 'medium', 'high'],
      defaultReasoningEffort: 'high',
    });
    expect(caps.levels).toEqual(['none', 'low', 'medium', 'high']);
    expect(caps.defaultLevel).toBe('high');
  });

  it('uses DeepSeek effort and toggle metadata without adding an off level', () => {
    const caps = getReasoningCapabilities('@ai-sdk/openai-compatible', 'deepseek-v4-flash', {
      reasoning: true,
      supportedReasoningEfforts: ['high', 'max'],
      defaultReasoningEffort: 'high',
      supportsReasoningToggle: true,
    });
    expect(caps.levels).toEqual(['high', 'max']);
    expect(caps.defaultLevel).toBe('high');
    expect(caps.wireFormat).toEqual({ kind: 'deepseek-thinking' });
  });

  it('uses reported GLM reasoning levels for OpenAI-compatible routes', () => {
    const caps = getReasoningCapabilities('@ai-sdk/openai-compatible', 'glm-5.2', {
      reasoning: true,
      supportedParameters: ['reasoning_effort'],
      supportedReasoningEfforts: ['high', 'xhigh'],
      defaultReasoningEffort: 'high',
    });
    expect(caps.levels).toEqual(['high', 'xhigh']);
    expect(caps.defaultLevel).toBe('high');
    expect(caps.wireFormat).toEqual({ kind: 'openai-reasoning-effort' });
  });

  it.each(['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed'])(
    'returns compatible reasoning levels for Kimi Coding Plan model %s',
    modelId => {
      const caps = getReasoningCapabilities('@ai-sdk/openai-compatible', modelId, {
        reasoning: true,
        supportedParameters: ['reasoning_effort'],
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'high',
      });
      expect(caps.levels).toEqual(['low', 'medium', 'high', 'xhigh']);
      expect(caps.defaultLevel).toBe('high');
      expect(caps.wireFormat).toEqual({ kind: 'openai-reasoning-effort' });
    },
  );

});

describe('compatible provider options', () => {
  it('maps DeepSeek effort to openaiCompatible reasoningEffort + thinking enabled', () => {
    const merged = deepMergeProviderOptions(
      effortProviderOptions('@ai-sdk/openai-compatible', 'max', 'deepseek-v4-flash', {
        reasoning: true,
        supportedReasoningEfforts: ['high', 'max'],
        supportsReasoningToggle: true,
      }),
    );
    expect(merged?.openaiCompatible).toMatchObject({ reasoningEffort: 'max' });
    expect(merged?.deepseek).toMatchObject({ thinking: { type: 'enabled' } });
  });

  it('omits an effort absent from DeepSeek metadata', () => {
    const opts = effortProviderOptions('@ai-sdk/openai-compatible', 'low', 'deepseek-v4-pro', {
      reasoning: true,
      supportedReasoningEfforts: ['high', 'max'],
      supportsReasoningToggle: true,
    });
    expect(opts).toBeUndefined();
  });

  it('preserves the reported GLM effort on OpenAI-compatible routes', () => {
    expect(effortProviderOptions('@ai-sdk/openai-compatible', 'xhigh', 'glm-5.2', {
      providerId: 'zai',
      reasoning: true,
      supportedParameters: ['reasoning_effort'],
      supportedReasoningEfforts: ['high', 'xhigh'],
    })).toEqual({
      zai: { reasoningEffort: 'xhigh' },
    });
    expect(effortProviderOptions('@ai-sdk/openai-compatible', 'low', 'glm-5.2', {
      reasoning: true,
      supportedParameters: ['reasoning_effort'],
      supportedReasoningEfforts: ['high', 'xhigh'],
    })).toBeUndefined();
  });
});

describe('effortProviderOptions + deepMergeProviderOptions', () => {
  it('merges OpenAI thinking + effort without dropping store/include', () => {
    const merged = deepMergeProviderOptions(
      thinkingProviderOptions('@ai-sdk/openai'),
      effortProviderOptions('@ai-sdk/openai', 'high', 'gpt-5.4', {
        reasoning: true,
        supportedReasoningEfforts: ['low', 'medium', 'high'],
      }),
    );
    expect(merged?.openai).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoningEffort: 'high',
    });
  });

  it('merges Google thinking + reported effort', () => {
    const merged = deepMergeProviderOptions(
      thinkingProviderOptions('@ai-sdk/google', {
        reasoning: true,
        supportedReasoningEfforts: ['high'],
      }),
      effortProviderOptions('@ai-sdk/google', 'high', 'gemini-2.5-pro', {
        reasoning: true,
        supportedReasoningEfforts: ['high'],
      }),
    );
    expect(merged?.google?.thinkingConfig).toMatchObject({
      includeThoughts: true,
      thinkingLevel: 'high',
    });
  });

  it('maps Vertex Claude effort to Anthropic thinking options', () => {
    expect(effortProviderOptions(VERTEX_ANTHROPIC_NPM, 'medium', 'claude-sonnet-4-6')).toEqual({
      anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' },
    });
  });
});
