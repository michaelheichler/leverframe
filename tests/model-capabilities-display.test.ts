import { describe, expect, it } from 'vitest';
import { formatModelCapabilities, modelSelectOption } from '../src/ui.js';
import type { LocalProviderModel } from '../src/types.js';

function model(overrides: Partial<LocalProviderModel> = {}): LocalProviderModel {
  return {
    id: 'glm-5.2',
    name: 'GLM-5.2',
    family: 'glm',
    brand: 'GLM',
    modelFormat: 'openai',
    upstreamModelId: 'glm-5.2',
    contextWindow: 1_000_000,
    usageMultiplier: 6,
    ...overrides,
  };
}

describe('model capability display', () => {
  it('shows context and Go usage multiplier in brackets', () => {
    expect(formatModelCapabilities(model())).toBe('[1M context, 6x usage]');
    expect(modelSelectOption(model()).label).toContain('[1M context, 6x usage]');
  });

  it('marks API-only multiplier metadata as unconfirmed', () => {
    expect(formatModelCapabilities(model({
      contextWindow: 256_000,
      usageMultiplier: undefined,
      usageMultiplierApplies: true,
      deprecated: true,
    }))).toBe('[256K context, usage multiplier unconfirmed, deprecated]');
  });

  it('does not mention a usage multiplier for regular providers', () => {
    expect(formatModelCapabilities(model({
      contextWindow: 128_000,
      usageMultiplier: undefined,
      usageMultiplierApplies: undefined,
    }))).toBe('[128K context]');
  });
});
