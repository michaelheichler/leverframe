/** Failures stay distinct to prevent stale model use. */
import { expect, it, vi } from 'vitest';
import { classifyCopilotModelFailure, refreshCopilotModels } from '../src/copilot/models.js';
import type { CachedModel } from '../src/registry/types.js';
import { fetchCopilotModels } from '../src/copilot/backend.js';

const cachedModel = (): CachedModel => ({
  id: 'cached-model',
  name: 'Cached Model',
  upstreamModelId: 'cached-model',
  contextWindowUnconfirmed: true,
  modelFormat: 'openai',
});

it('returns validated live chat models when HTTP discovery succeeds', async () => {
  const result = await refreshCopilotModels({
    listModels: vi.fn().mockResolvedValue([
      { id: 'completion', capabilities: { type: 'completion' } },
      {
        id: 'live-model', name: 'Live Model', model_picker_enabled: false,
        supported_endpoints: ['/chat/completions'],
        capabilities: {
          type: 'chat', supports: { vision: false, reasoning_effort: false },
          limits: { max_context_window_tokens: 128_000 },
        },
      },
    ]),
    cachedModels: [cachedModel()],
  });

  expect(result.source).toBe('live');
  expect(result.models).toEqual([expect.objectContaining({
    id: 'live-model', contextWindow: 128_000,
    npm: '@ai-sdk/openai-compatible', apiUrl: 'https://api.githubcopilot.com',
  })]);
});

it('preserves the same cached records when discovery fails', async () => {
  const cachedModels = [cachedModel()];
  const result = await refreshCopilotModels({
    listModels: vi.fn().mockRejectedValue(new Error('network unavailable')),
    cachedModels,
  });

  expect(result.source).toBe('cache');
  if (result.source !== 'cache') throw new Error('expected cached models');
  expect(result.models).toBe(cachedModels);
  expect(result.failureReason).toBe('network unavailable');
  expect(result.failureKind).toBe('runtime');
});

it('keeps valid live records and reports malformed siblings instead of falling back', async () => {
  const cachedModels = [cachedModel()];
  const result = await refreshCopilotModels({
    listModels: vi.fn().mockResolvedValue([
      { id: 'valid', name: 'Valid', capabilities: { type: 'chat' }, supported_endpoints: ['/responses'] },
      { id: 'missing-fields' },
      null,
    ]),
    cachedModels,
  });

  expect(result.source).toBe('live');
  expect(result.models).toEqual([expect.objectContaining({ id: 'valid', contextWindowUnconfirmed: true, npm: '@ai-sdk/openai' })]);
  expect(result).not.toHaveProperty('failureKind');
  expect(result.skippedModels).toEqual([
    expect.objectContaining({ index: 1, modelId: 'missing-fields', kind: 'schema' }),
    expect.objectContaining({ index: 2, kind: 'schema' }),
  ]);
});

it('raises discovery failures when no valid cache exists', async () => {
  const failure = new Error('network unavailable');

  await expect(refreshCopilotModels({
    listModels: vi.fn().mockRejectedValue(failure), cachedModels: [],
  })).rejects.toBe(failure);
});

it('rejects an empty live model list instead of replacing a valid cache', async () => {
  const cachedModels = [cachedModel()];
  const result = await refreshCopilotModels({
    listModels: vi.fn().mockResolvedValue([]), cachedModels,
  });

  expect(result.source).toBe('cache');
  if (result.source !== 'cache') throw new Error('expected cached models');
  expect(result.models).toBe(cachedModels);
  expect(result.failureKind).toBe('empty');
  expect(result.failureReason).toContain('no models');
});

it('classifies a non-chat-only catalog as empty rather than restricted by policy', async () => {
  const result = await refreshCopilotModels({
    listModels: vi.fn().mockResolvedValue([
      { id: 'completion', capabilities: { type: 'completion' } },
    ]),
    cachedModels: [cachedModel()],
  });

  expect(result).toEqual(expect.objectContaining({ source: 'cache', failureKind: 'empty' }));
});

it('preserves the policy failure kind when every chat model is disabled', async () => {
  const result = await refreshCopilotModels({
    listModels: vi.fn().mockResolvedValue([
      { id: 'completion', capabilities: { type: 'completion' } },
      {
        id: 'disabled', name: 'Disabled', capabilities: { type: 'chat' },
        policy: { state: 'disabled' },
      },
    ]),
    cachedModels: [cachedModel()],
  });

  expect(result).toEqual(expect.objectContaining({ source: 'cache', failureKind: 'policy' }));
});

it('reports unsupported inference endpoints as schema failure', async () => {
  const result = await refreshCopilotModels({
    listModels: vi.fn().mockResolvedValue([{
      id: 'unsupported', name: 'Unsupported', capabilities: { type: 'chat' },
      supported_endpoints: ['/embeddings'],
    }]),
    cachedModels: [cachedModel()],
  });

  expect(result).toEqual(expect.objectContaining({ source: 'cache', failureKind: 'schema' }));
  expect(result.skippedModels).toEqual([expect.objectContaining({ modelId: 'unsupported', kind: 'transport-unknown' })]);
});

it('reports absent transport metadata without guessing chat completions', async () => {
  const result = await refreshCopilotModels({
    listModels: vi.fn().mockResolvedValue([{ id: 'unknown', name: 'Unknown', capabilities: { type: 'chat' } }]),
    cachedModels: [cachedModel()],
  });
  expect(result).toMatchObject({
    source: 'cache', failureKind: 'schema', failureReason: expect.stringContaining('transport is unknown'),
    skippedModels: [{ index: 0, modelId: 'unknown', kind: 'transport-unknown' }],
  });
});

it('does not confuse invalid enabled records with a policy-only exclusion', async () => {
  const result = await refreshCopilotModels({
    listModels: vi.fn().mockResolvedValue([
      { id: 'disabled', capabilities: { type: 'chat' }, policy: { state: 'disabled' } },
      { id: 'invalid', capabilities: { type: 'chat' } },
    ]),
    cachedModels: [cachedModel()],
  });
  expect(result).toMatchObject({ source: 'cache', failureKind: 'schema' });
  expect(result.skippedModels.map(record => record.kind)).toEqual(['policy', 'schema']);
});

it.each([null, {}, { data: [] }, 'invalid'])('classifies a malformed list result as schema fallback: %j', records => {
  return expect(refreshCopilotModels({
    listModels: vi.fn().mockResolvedValue(records), cachedModels: [cachedModel()],
  })).resolves.toMatchObject({ source: 'cache', failureKind: 'schema', skippedModels: [] });
});

it.each(['not json', '{}', '{"data":null}', '{"data":{}}', '[]'])(
  'classifies malformed HTTP catalog envelopes as schema fallback: %s', body => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    return expect(refreshCopilotModels({
      listModels: () => fetchCopilotModels(globalThis.crypto.randomUUID(), { fetchImpl: network }),
      cachedModels: [cachedModel()],
    })).resolves.toMatchObject({ source: 'cache', failureKind: 'schema', skippedModels: [] });
  },
);

it.each([[401, 'authentication'], [403, 'authentication'], [429, 'runtime'], [500, 'runtime']])(
  'keeps HTTP %s as classified cache fallback', async (status, failureKind) => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response('private response', { status: Number(status) }));
    const cachedModels = [cachedModel()];
    const result = await refreshCopilotModels({
      listModels: () => fetchCopilotModels(globalThis.crypto.randomUUID(), { fetchImpl: network }), cachedModels,
    });
    expect(result).toMatchObject({ source: 'cache', failureKind, skippedModels: [] });
    expect(result.models).toBe(cachedModels);
    if (result.source !== 'cache') throw new Error('expected cached models');
    expect(result.failureReason).not.toContain('private response');
    expect(network).toHaveBeenCalledTimes(1);
  },
);

it('rejects unusable live metadata as a classified schema error without a cache', async () => {
  const error = await refreshCopilotModels({
    listModels: vi.fn().mockResolvedValue([null]), cachedModels: [],
  }).catch(error => error);
  expect(error).toBeInstanceOf(TypeError);
  expect(classifyCopilotModelFailure(error)).toBe('schema');
});

it.each(['401 Unauthorized', '403 Forbidden', 'Copilot subscription required'])(
  'recognizes HTTP authentication failures through causes: %s', message => {
    const error = new Error('discovery failed', { cause: new Error(message) });

    expect(classifyCopilotModelFailure(error)).toBe('authentication');
  },
);

it.each(['CopilotSdkNotInstalledError', 'CopilotSdkIncompatibleError'])(
  'does not classify obsolete SDK installation errors: %s', name => {
    const error = new Error('Copilot CLI not found');
    error.name = name;

    expect(classifyCopilotModelFailure(error)).toBe('runtime');
  },
);
