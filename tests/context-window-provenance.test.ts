import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW,
  contextWindowFromHeuristics,
  resolveContextWindow,
} from '../src/context-window.js';
import { formatAnthropicModelEntry, formatAnthropicModelList } from '../src/server/models.js';

describe('resolveContextWindow provenance', () => {
  it('returns the explicit window when provided, even if unconfirmed is set', () => {
    expect(resolveContextWindow('gpt-5.6-terra', 272_000, true)).toBe(272_000);
  });

  it('uses the heuristic match for unconfirmed models instead of the flat default', () => {
    expect(resolveContextWindow('gpt-5.6-terra', undefined, true)).toBe(272_000);
    expect(resolveContextWindow('gpt-5.6-sol', undefined, true)).toBe(272_000);
  });

  it('uses a sub-200K heuristic match for unconfirmed models, not the flat default', () => {
    expect(resolveContextWindow('deepseek-chat', undefined, true)).toBe(64_000);
  });

  it('falls back to the flat default for an unconfirmed model with no heuristic match', () => {
    expect(resolveContextWindow('totally-unknown-model-xyz', undefined, true)).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('keeps heuristic resolution when provenance is not marked unconfirmed', () => {
    // Fictional id: never in the host OpenCode cache, so resolution is heuristic-only.
    expect(resolveContextWindow('gpt-4.1-leverframe-test', undefined)).toBe(1_000_000);
  });
});

describe('GPT heuristic buckets', () => {
  it('does not report 1M for gpt-5 family models', () => {
    expect(contextWindowFromHeuristics('gpt-5')).toBe(272_000);
    expect(contextWindowFromHeuristics('gpt-5.6-terra')).toBe(272_000);
    expect(contextWindowFromHeuristics('gpt-5.4-mini')).toBe(272_000);
  });

  it('reports 200K for o3/o4 series and keeps 1M for gpt-4.1', () => {
    expect(contextWindowFromHeuristics('o3-mini')).toBe(200_000);
    expect(contextWindowFromHeuristics('o4-mini')).toBe(200_000);
    expect(contextWindowFromHeuristics('gpt-4.1')).toBe(1_000_000);
  });
});

describe('/v1/models advertisement', () => {
  it('advertises the heuristic match for an unconfirmed model', () => {
    const entry = formatAnthropicModelEntry({
      id: 'gpt-5.6-terra',
      name: 'GPT-5.6 Terra',
      contextWindow: undefined,
      contextWindowUnconfirmed: true,
    });
    expect(entry.context_window).toBe(272_000);
    expect(entry.max_input_tokens).toBe(272_000);
  });

  it('advertises the flat default for an unconfirmed model with no heuristic match', () => {
    const entry = formatAnthropicModelEntry({
      id: 'totally-unknown-model-xyz',
      name: 'Totally Unknown Model',
      contextWindow: undefined,
      contextWindowUnconfirmed: true,
    });
    expect(entry.context_window).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('advertises a provider-confirmed window unchanged', () => {
    const entry = formatAnthropicModelEntry({
      id: 'gpt-5.6-terra',
      name: 'GPT-5.6 Terra',
      contextWindow: 272_000,
    });
    expect(entry.context_window).toBe(272_000);
  });

  it('threads unconfirmed provenance through model lists', () => {
    const list = formatAnthropicModelList([
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindowUnconfirmed: true },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 272_000 },
    ]);
    expect(list.data.map(entry => entry.context_window)).toEqual([272_000, 272_000]);
  });
});
