import { describe, expect, it } from 'vitest';
import { resolveContextWindow } from '../src/context-window.js';
import { formatAnthropicModelEntry, formatAnthropicModelList } from '../src/server/models.js';

describe('resolveContextWindow provenance', () => {
  it('returns an explicitly reported window', () => {
    expect(resolveContextWindow('provider-model', 272_000)).toBe(272_000);
  });

  it('omits an explicitly supplied window when its provenance is unconfirmed', () => {
    expect(resolveContextWindow('provider-model', 272_000, true)).toBeUndefined();
  });

  it('omits missing windows instead of inferring them from the model id', () => {
    expect(resolveContextWindow('provider-model', undefined)).toBeUndefined();
    expect(resolveContextWindow('unrecognized-provider-model', undefined, true)).toBeUndefined();
  });
});

describe('/v1/models advertisement', () => {
  it('omits the context fields for an unconfirmed model', () => {
    const entry = formatAnthropicModelEntry({
      id: 'provider-model',
      name: 'Provider Model',
      contextWindow: undefined,
      contextWindowUnconfirmed: true,
    });
    expect(entry.context_window).toBeUndefined();
    expect(entry.max_input_tokens).toBeUndefined();
  });

  it('omits the context fields when no provider metadata was reported', () => {
    const entry = formatAnthropicModelEntry({
      id: 'unrecognized-provider-model',
      name: 'Unrecognized Provider Model',
    });
    expect(entry.context_window).toBeUndefined();
    expect(entry.max_input_tokens).toBeUndefined();
  });

  it('advertises a provider-confirmed window unchanged', () => {
    const entry = formatAnthropicModelEntry({
      id: 'provider-model',
      name: 'Provider Model',
      contextWindow: 272_000,
    });
    expect(entry.context_window).toBe(272_000);
    expect(entry.max_input_tokens).toBe(272_000);
  });

  it('threads provenance through model lists', () => {
    const list = formatAnthropicModelList([
      { id: 'unconfirmed-provider-model', name: 'Unconfirmed Provider Model', contextWindowUnconfirmed: true },
      { id: 'provider-model', name: 'Provider Model', contextWindow: 272_000 },
    ]);
    expect(list.data.map(entry => entry.context_window)).toEqual([undefined, 272_000]);
  });
});
