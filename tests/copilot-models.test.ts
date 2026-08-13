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

  it.each([
    null,
    {},
    modelInfo({ id: '' }),
    modelInfo({ name: 42 }),
    modelInfo({ capabilities: null }),
    modelInfo({ capabilities: { supports: { vision: 'yes', reasoningEffort: true }, limits: {} } }),
    modelInfo({ capabilities: { supports: { vision: true, reasoningEffort: true }, limits: { max_context_window_tokens: -1 } } }),
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
