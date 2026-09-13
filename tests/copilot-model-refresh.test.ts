/** Failures stay distinct to prevent stale model use. */
import { expect, it, vi } from 'vitest';
import { classifyCopilotModelFailure, refreshCopilotModels } from '../src/copilot/models.js';
import type { CachedModel } from '../src/registry/types.js';

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

it('rejects the whole live catalog when any chat record is malformed', async () => {
  const cachedModels = [cachedModel()];
  const result = await refreshCopilotModels({
    listModels: vi.fn().mockResolvedValue([
      { id: 'valid', name: 'Valid', capabilities: { type: 'chat' } },
      { id: 'missing-fields' },
    ]),
    cachedModels,
  });

  expect(result).toEqual(expect.objectContaining({ source: 'cache', failureKind: 'schema' }));
  expect(result.models).toBe(cachedModels);
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
