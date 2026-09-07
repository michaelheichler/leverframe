import { describe, it, expect } from 'vitest';
import { buildPatchModelConfig } from '../src/patcher.js';

describe('buildPatchModelConfig', () => {
  const favorites = [
    { providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    { providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
    { providerId: 'openai', modelId: 'mystery-model' },
  ];
  const aliases = [
    { name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
  ];
  const meta = new Map([
    ['openai-oauth:gpt-5.6-sol', { contextWindow: 272_000, displayName: 'GPT-5.6 Sol (OpenAI (ChatGPT))' }],
    ['openai-oauth:gpt-5.6-luna', { contextWindow: 272_000, displayName: 'GPT-5.6 Luna (OpenAI (ChatGPT))' }],
  ]);

  it('builds leverframe-prefixed entries with aliases, context windows, and display labels', () => {
    const { config, unknownWindows } = buildPatchModelConfig(
      favorites,
      aliases,
      (providerId, modelId) => meta.get(providerId + ':' + modelId),
    );

    expect(config['leverframe:openai-oauth:gpt-5.6-sol']).toEqual({
      alias: 'sol',
      context: 272_000,
      display: 'GPT-5.6 Sol (OpenAI (ChatGPT))',
    });
    expect(config['leverframe:openai-oauth:gpt-5.6-luna']).toEqual({
      context: 272_000,
      display: 'GPT-5.6 Luna (OpenAI (ChatGPT))',
    });
    expect(config['leverframe:openai:mystery-model']).toEqual({});
    expect(unknownWindows).toEqual(['leverframe:openai:mystery-model']);
  });

  it('retains a confirmed 200k context window', () => {
    const { config, unknownWindows } = buildPatchModelConfig(
      [{ providerId: 'openai', modelId: 'davinci-002' }],
      [],
      () => ({ contextWindow: 200_000 }),
    );
    expect(config['leverframe:openai:davinci-002']).toEqual({ context: 200_000 });
    expect(unknownWindows).toEqual([]);
  });

  it('omits a blank display label rather than baking an empty string', () => {
    const { config } = buildPatchModelConfig(
      [{ providerId: 'openai', modelId: 'davinci-002' }],
      [],
      () => ({ contextWindow: 272_000, displayName: '   ' }),
    );
    expect(config['leverframe:openai:davinci-002']).toEqual({ context: 272_000 });
  });

  it('bakes the Kimi Coding Plan alias and k3 context under the same model identity', () => {
    const { config, unknownWindows } = buildPatchModelConfig(
      [{ providerId: 'kimi', modelId: 'k3' }],
      [{ name: 'kimi3', providerId: 'kimi', modelId: 'k3' }],
      () => ({ contextWindow: 1_048_576, displayName: 'Kimi 3 (Kimi (Coding Plan))' }),
    );

    expect(config['leverframe:kimi:k3']).toEqual({
      alias: 'kimi3',
      context: 1_048_576,
      display: 'Kimi 3 (Kimi (Coding Plan))',
    });
    expect(unknownWindows).toEqual([]);
  });

  it('projects a GPT-5.6-shaped effort ladder onto the native picker with a high default', () => {
    const { config } = buildPatchModelConfig(
      [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
      [{ name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
      () => ({
        contextWindow: 272_000,
        displayName: 'GPT-5.6 Sol (OpenAI (ChatGPT))',
        effort: { levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'medium' },
      }),
    );
    expect(config['leverframe:openai-oauth:gpt-5.6-sol']?.effort).toEqual({
      levels: ['low', 'medium', 'high', 'xhigh'],
      defaultLevel: 'high',
    });
  });

  it.each([
    { name: 'an incomplete base (no low/medium)', levels: ['high', 'xhigh'], defaultLevel: 'high' },
    { name: 'a default outside the native ladder', levels: ['none', 'low', 'medium', 'high'], defaultLevel: 'none' },
  ])('silently omits client effort metadata for $name rather than throwing', ({ levels, defaultLevel }) => {
    const { config } = buildPatchModelConfig(
      [{ providerId: 'openai', modelId: 'reasoning-model' }],
      [],
      () => ({ contextWindow: 200_000, effort: { levels, defaultLevel } }),
    );
    expect(config['leverframe:openai:reasoning-model']).toEqual({ context: 200_000 });
  });
});

describe('buildPatchModelConfig context provenance', () => {
  it('marks a confirmed context window with provenance "confirmed" and bakes it', () => {
    const { config, unknownWindows, provenance } = buildPatchModelConfig(
      [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
      [],
      () => ({ contextWindow: 272_000 }),
    );
    expect(config['leverframe:openai-oauth:gpt-5.6-sol']).toEqual({ context: 272_000 });
    expect(unknownWindows).toEqual([]);
    expect(provenance['leverframe:openai-oauth:gpt-5.6-sol']).toBe('confirmed');
  });

  it('marks an unconfirmed context window with provenance "unconfirmed", omits context, and skips unknownWindows', () => {
    const { config, unknownWindows, provenance } = buildPatchModelConfig(
      [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
      [],
      () => ({ contextWindow: undefined, contextWindowUnconfirmed: true }),
    );
    expect(config['leverframe:openai-oauth:gpt-5.6-sol']).toEqual({});
    expect(unknownWindows).toEqual([]);
    expect(provenance['leverframe:openai-oauth:gpt-5.6-sol']).toBe('unconfirmed');
  });

  it('marks a genuinely missing context window with provenance "missing" and pushes it to unknownWindows', () => {
    const { config, unknownWindows, provenance } = buildPatchModelConfig(
      [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
      [],
      () => ({ contextWindow: undefined }),
    );
    expect(config['leverframe:openai-oauth:gpt-5.6-sol']).toEqual({});
    expect(unknownWindows).toEqual(['leverframe:openai-oauth:gpt-5.6-sol']);
    expect(provenance['leverframe:openai-oauth:gpt-5.6-sol']).toBe('missing');
  });

  it('omits context modes when the launch has no context selection endpoint', () => {
    const { config } = buildPatchModelConfig(
      [{ providerId: 'openai', modelId: 'endpointless' }],
      [],
      () => ({ contextWindow: 272_000, maxContextWindow: 872_000, modelFormat: 'openai' }),
      { includeContextModes: false },
    );
    expect(config['leverframe:openai:endpointless']).toEqual({ context: 272_000 });
  });
});
