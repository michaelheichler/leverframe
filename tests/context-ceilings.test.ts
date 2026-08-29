import { describe, expect, it } from 'vitest';
import { modelContextCeiling, resolveContextCeilingOverride } from '../src/context-ceilings.js';
import type { CachedModel } from '../src/registry/types.js';

function model(partial: Partial<CachedModel>): CachedModel {
  return {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    upstreamModelId: 'gpt-5.6-sol',
    family: 'gpt',
    brand: 'OpenAI',
    modelFormat: 'openai',
    ...partial,
  } as CachedModel;
}

describe('modelContextCeiling', () => {
  it('reports the maximum when it exceeds the served window', () => {
    expect(modelContextCeiling(model({ contextWindow: 272_000, maxContextWindow: 872_000 }))).toBe(872_000);
  });

  it('reports nothing when the maximum matches the served window', () => {
    expect(modelContextCeiling(model({ contextWindow: 272_000, maxContextWindow: 272_000 }))).toBeUndefined();
  });

  it('reports nothing when the maximum is below the served window', () => {
    expect(modelContextCeiling(model({ contextWindow: 400_000, maxContextWindow: 272_000 }))).toBeUndefined();
  });

  it('reports nothing when the provider sent no maximum', () => {
    expect(modelContextCeiling(model({ contextWindow: 272_000 }))).toBeUndefined();
  });

  it('ignores a non-positive maximum', () => {
    expect(modelContextCeiling(model({ contextWindow: 272_000, maxContextWindow: 0 }))).toBeUndefined();
  });
});

describe('resolveContextCeilingOverride', () => {
  const sol = model({ contextWindow: 272_000, maxContextWindow: 872_000 });

  it('applies only to models the user opted in', () => {
    expect(resolveContextCeilingOverride(sol, ['gpt-5.6-sol'])).toBe(872_000);
    expect(resolveContextCeilingOverride(sol, ['gpt-5.6-terra'])).toBeUndefined();
  });

  it('matches the opted-in id case-insensitively', () => {
    expect(resolveContextCeilingOverride(sol, ['GPT-5.6-SOL'])).toBe(872_000);
  });

  it('does nothing without an opt-in', () => {
    expect(resolveContextCeilingOverride(sol, undefined)).toBeUndefined();
    expect(resolveContextCeilingOverride(sol, [])).toBeUndefined();
  });

  it('stays inert for an opted-in model that no longer reports a maximum', () => {
    const withoutMax = model({ contextWindow: 272_000 });
    expect(resolveContextCeilingOverride(withoutMax, ['gpt-5.6-sol'])).toBeUndefined();
  });
});
