import { describe, expect, it } from 'vitest';
import {
  effortProviderOptions,
  resolveReasoningCapabilities,
} from '../src/reasoning-capabilities.js';

describe('resolveReasoningCapabilities', () => {
  it('uses OpenRouter supported_parameters as the source for controllable reasoning', () => {
    const caps = resolveReasoningCapabilities({
      providerId: 'openrouter',
      npm: '@openrouter/ai-sdk-provider',
      modelId: 'z-ai/glm-5.2',
      supportedParameters: ['tools', 'reasoning', 'include_reasoning'],
      reasoning: true,
      supportedReasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      defaultReasoningEffort: 'medium',
    });

    expect(caps.mode).toBe('controllable');
    expect(caps.source).toBe('provider-metadata');
    expect(caps.confidence).toBe('documented');
    expect(caps.levels).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(caps.defaultLevel).toBe('medium');
    expect(caps.supportsSummaries).toBe(false);
    expect(caps.wireFormat).toEqual({ kind: 'openrouter-reasoning' });
  });

  it('does not expose controls for OpenRouter models without the reasoning parameter', () => {
    const caps = resolveReasoningCapabilities({
      providerId: 'openrouter',
      npm: '@openrouter/ai-sdk-provider',
      modelId: 'openrouter/fusion',
      supportedParameters: ['tools'],
    });

    expect(caps.mode).toBe('none');
    expect(caps.levels).toEqual([]);
    expect(caps.defaultLevel).toBe('');
  });

  it('exposes GLM-5.2 high/xhigh controls for OpenCode Go style routes', () => {
    const caps = resolveReasoningCapabilities({
      providerId: 'go',
      npm: '@ai-sdk/openai-compatible',
      modelId: 'glm-5.2',
      reasoning: true,
      supportedParameters: ['reasoning_effort'],
      supportedReasoningEfforts: ['high', 'xhigh'],
      defaultReasoningEffort: 'high',
      interleavedReasoningField: 'reasoning_content',
    });

    expect(caps.mode).toBe('controllable');
    expect(caps.source).toBe('model-metadata');
    expect(caps.confidence).toBe('documented');
    expect(caps.levels).toEqual(['high', 'xhigh']);
    expect(caps.defaultLevel).toBe('high');
  });

  it('does not infer Anthropic controls from a model id on a custom SDK route', () => {
    const caps = resolveReasoningCapabilities({
      providerId: 'custom',
      npm: '@ai-sdk/openai-compatible',
      modelId: 'claude-fable',
    });

    expect(caps.mode).toBe('none');
    expect(caps.levels).toEqual([]);
    expect(caps.defaultLevel).toBe('');
  });

  it('does not expose effort controls for an SDK without a known serializer', () => {
    const caps = resolveReasoningCapabilities({
      providerId: 'custom',
      npm: '@vendor/custom-sdk',
      modelId: 'custom-reasoning-model',
      reasoning: true,
      supportedReasoningEfforts: ['ultra'],
      defaultReasoningEffort: 'ultra',
    });

    expect(caps.mode).toBe('internal-only');
    expect(caps.levels).toEqual([]);
    expect(caps.defaultLevel).toBe('');
    expect(caps.wireFormat).toBeUndefined();
    expect(effortProviderOptions('@vendor/custom-sdk', 'ultra', 'custom-reasoning-model', {
      providerId: 'custom',
      reasoning: true,
      supportedReasoningEfforts: ['ultra'],
    })).toBeUndefined();
  });
});

describe('effortProviderOptions', () => {
  it('maps OpenRouter effort to providerOptions.openrouter.reasoning', () => {
    expect(
      effortProviderOptions('@openrouter/ai-sdk-provider', 'high', 'z-ai/glm-5.2', {
        providerId: 'openrouter',
        supportedParameters: ['reasoning'],
        supportedReasoningEfforts: ['high'],
      }),
    ).toEqual({
      openrouter: {
        reasoning: {
          effort: 'high',
          exclude: false,
        },
      },
    });
  });

  it('preserves the reported GLM effort on the provider key', () => {
    const options = effortProviderOptions('@ai-sdk/openai-compatible', 'xhigh', 'glm-5.2', {
      providerId: 'opencode-go',
      reasoning: true,
      supportedParameters: ['reasoning_effort'],
      supportedReasoningEfforts: ['xhigh'],
    });
    expect(options?.opencodeGo?.reasoningEffort).toBe('xhigh');
    expect(options).toEqual({
      opencodeGo: {
        reasoningEffort: 'xhigh',
      },
    });
  });

  it.each(['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed'])(
    'maps Kimi Coding Plan effort for %s to openai-compatible provider options',
    modelId => {
      expect(
        effortProviderOptions('@ai-sdk/openai-compatible', 'high', modelId, {
          providerId: 'kimi',
          reasoning: true,
          supportedParameters: ['reasoning_effort'],
          supportedReasoningEfforts: ['high'],
        }),
      ).toEqual({
        kimi: {
          reasoningEffort: 'high',
        },
      });
    },
  );

  it('keeps Moonshot pay-as-you-go Kimi effort mapping', () => {
    expect(
      effortProviderOptions('@ai-sdk/openai-compatible', 'high', 'kimi-k2.7-code', {
        providerId: 'moonshot',
        reasoning: true,
        supportedParameters: ['reasoning_effort'],
        supportedReasoningEfforts: ['high'],
      }),
    ).toEqual({
      moonshot: {
        reasoningEffort: 'high',
      },
    });
  });

  it('omits effort options when a custom route has no reported levels', () => {
    expect(effortProviderOptions('@ai-sdk/openai-compatible', 'high', 'claude-fable', {
      providerId: 'custom',
    })).toBeUndefined();
  });
});
