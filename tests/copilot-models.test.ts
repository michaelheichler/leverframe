/**
 * Specifies model metadata accepted from the public Copilot SDK.
 * Fixtures contain only the documented `ModelInfo` shape.
 */

import { describe, expect, it } from 'vitest';
import { mapCopilotModels, parseCopilotModelInfo } from '../src/copilot/models.js';

const modelInfo = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  id: 'claude-sonnet-fixture',
  name: 'Claude Sonnet Fixture',
  capabilities: {
    supports: {
      vision: true,
      reasoningEffort: true,
    },
    limits: {
      max_context_window_tokens: 200_000,
    },
  },
  supportedReasoningEfforts: ['low', 'medium', 'high'],
  defaultReasoningEffort: 'medium',
  ...overrides,
});

describe('parseCopilotModelInfo', () => {
  it('preserves provider-confirmed identifiers and capabilities', () => {
    const model = parseCopilotModelInfo(modelInfo({}));

    expect(model).toEqual(expect.objectContaining({
      id: 'claude-sonnet-fixture',
      name: 'Claude Sonnet Fixture',
      upstreamModelId: 'claude-sonnet-fixture',
      contextWindow: 200_000,
      modelFormat: 'openai',
      reasoning: true,
      vision: true,
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'medium',
    }));
    expect(model.contextWindowUnconfirmed).toBeUndefined();
  });

  it('marks an absent context limit as unconfirmed without guessing', () => {
    const model = parseCopilotModelInfo(modelInfo({
      capabilities: {
        supports: { vision: false, reasoningEffort: false },
        limits: {},
      },
      supportedReasoningEfforts: undefined,
      defaultReasoningEffort: undefined,
    }));

    expect(model.contextWindow).toBeUndefined();
    expect(model.contextWindowUnconfirmed).toBe(true);
    expect(model.vision).toBe(false);
    expect(model.reasoning).toBe(false);
    expect(model.supportedReasoningEfforts).toBeUndefined();
    expect(model.defaultReasoningEffort).toBeUndefined();
  });

  it('accepts SDK records with optional capability groups omitted', () => {
    const model = parseCopilotModelInfo(modelInfo({
      capabilities: {},
      supportedReasoningEfforts: undefined,
      defaultReasoningEffort: undefined,
    }));

    expect(model).toEqual(expect.objectContaining({
      id: 'claude-sonnet-fixture',
      contextWindowUnconfirmed: true,
    }));
    expect(model.vision).toBeUndefined();
    expect(model.reasoning).toBeUndefined();
  });

  it('keeps omitted capability booleans unconfirmed', () => {
    const model = parseCopilotModelInfo(modelInfo({
      capabilities: {
        supports: {},
        limits: { max_context_window_tokens: 128_000 },
      },
    }));

    expect(model.contextWindow).toBe(128_000);
    expect(model.vision).toBeUndefined();
    expect(model.reasoning).toBeUndefined();
  });

  it('treats the SDK normalized zero context window as unconfirmed', () => {
    const model = parseCopilotModelInfo(modelInfo({
      capabilities: {
        supports: { vision: false, reasoningEffort: false },
        limits: { max_context_window_tokens: 0 },
      },
    }));

    expect(model.contextWindow).toBeUndefined();
    expect(model.contextWindowUnconfirmed).toBe(true);
  });

  it.each([
    null,
    {},
    modelInfo({ id: '' }),
    modelInfo({ name: 42 }),
    modelInfo({ capabilities: null }),
    modelInfo({ capabilities: { supports: { vision: 'yes', reasoningEffort: true }, limits: {} } }),
    modelInfo({ capabilities: { supports: [], limits: {} } }),
    modelInfo({ capabilities: { supports: {}, limits: 'unknown' } }),
    modelInfo({ capabilities: { supports: { vision: true, reasoningEffort: true }, limits: { max_context_window_tokens: -1 } } }),
    modelInfo({ capabilities: { supports: { vision: true, reasoningEffort: true }, limits: { max_context_window_tokens: Number.NaN } } }),
    modelInfo({ capabilities: { supports: { vision: true, reasoningEffort: true }, limits: { max_context_window_tokens: '128000' } } }),
    modelInfo({ supportedReasoningEfforts: ['medium', 'extreme'] }),
    modelInfo({ defaultReasoningEffort: 'extreme' }),
  ])('rejects malformed model metadata %#', record => {
    expect(() => parseCopilotModelInfo(record)).toThrow(TypeError);
  });
});

describe('mapCopilotModels', () => {
  it('validates every listModels record and preserves order', () => {
    const models = mapCopilotModels([
      modelInfo({ id: 'first', name: 'First' }),
      modelInfo({ id: 'second', name: 'Second' }),
    ]);

    expect(models.map(model => model.id)).toEqual(['first', 'second']);
  });

  it('keeps the complete list when one valid record has sparse SDK capabilities', () => {
    const models = mapCopilotModels([
      modelInfo({ id: 'sparse', name: 'Sparse', capabilities: { supports: {}, limits: { max_context_window_tokens: 0 } } }),
      modelInfo({ id: 'complete', name: 'Complete' }),
    ]);

    expect(models.map(model => model.id)).toEqual(['sparse', 'complete']);
    expect(models[0]).toEqual(expect.objectContaining({ contextWindowUnconfirmed: true }));
  });


  it('excludes models whose SDK policy is not enabled', () => {
    const models = mapCopilotModels([
      modelInfo({ id: 'enabled', name: 'Enabled', policy: { state: 'enabled' } }),
      modelInfo({ id: 'disabled', name: 'Disabled', policy: { state: 'disabled' } }),
      modelInfo({ id: 'unconfigured', name: 'Unconfigured', policy: { state: 'unconfigured' } }),
      modelInfo({ id: 'no-policy', name: 'No Policy' }),
    ]);

    expect(models.map(model => model.id)).toEqual(['enabled', 'no-policy']);
  });

  it('rejects malformed policy states', () => {
    expect(() => mapCopilotModels([
      modelInfo({ policy: { state: 'unexpected' } }),
    ])).toThrow(TypeError);
  });

  it('rejects a non-array listModels result', () => {
    expect(() => mapCopilotModels({ models: [] })).toThrow(TypeError);
  });

  it('does not invent a tool capability absent from ModelInfo', () => {
    const model = parseCopilotModelInfo(modelInfo({}));

    expect(model).not.toHaveProperty('toolCall');
    expect(model).not.toHaveProperty('tool_call');
  });
});
