/**
 * Verifies Copilot model discovery preserves valid cached data on runtime failures.
 */

import { describe, expect, it, vi } from 'vitest';
import { refreshCopilotModels } from '../src/copilot/models.js';
import type { CachedModel } from '../src/registry/types.js';

const cachedModel = (): CachedModel => ({
  id: 'cached-model',
  name: 'Cached Model',
  upstreamModelId: 'cached-model',
  contextWindowUnconfirmed: true,
  modelFormat: 'openai',
});

describe('refreshCopilotModels', () => {
  it('returns validated live models when discovery succeeds', async () => {
    const result = await refreshCopilotModels({
      listModels: vi.fn().mockResolvedValue([{
        id: 'live-model',
        name: 'Live Model',
        capabilities: {
          supports: { vision: false, reasoningEffort: false },
          limits: { max_context_window_tokens: 128_000 },
        },
      }]),
      cachedModels: [cachedModel()],
    });

    expect(result.source).toBe('live');
    expect(result.models.map(model => model.id)).toEqual(['live-model']);
  });

  it('preserves the same cached records when discovery fails', async () => {
    const cachedModels = [cachedModel()];
    const result = await refreshCopilotModels({
      listModels: vi.fn().mockRejectedValue(new Error('runtime unavailable')),
      cachedModels,
    });

    expect(result.source).toBe('cache');
    if (result.source !== 'cache') throw new Error('expected cached models');
    expect(result.models).toBe(cachedModels);
    expect(result.failureReason).toBe('runtime unavailable');
    expect(result.failureKind).toBe('runtime');
  });


  it('classifies malformed model data as schema drift', async () => {
    const cachedModels = [cachedModel()];
    const result = await refreshCopilotModels({
      listModels: vi.fn().mockResolvedValue([{ id: 'missing-fields' }]),
      cachedModels,
    });

    expect(result).toEqual(expect.objectContaining({
      source: 'cache',
      failureKind: 'schema',
    }));
  });

  it('raises discovery failures when no valid cache exists', async () => {
    const failure = new Error('runtime unavailable');

    await expect(refreshCopilotModels({
      listModels: vi.fn().mockRejectedValue(failure),
      cachedModels: [],
    })).rejects.toBe(failure);
  });

  it('rejects an empty live model list instead of replacing a valid cache', async () => {
    const cachedModels = [cachedModel()];
    const result = await refreshCopilotModels({
      listModels: vi.fn().mockResolvedValue([]),
      cachedModels,
    });

    expect(result.source).toBe('cache');
    if (result.source !== 'cache') throw new Error('expected cached models');
    expect(result.models).toBe(cachedModels);
    expect(result.failureReason).toContain('no models');
  });
});
