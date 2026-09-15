/** Because failed discovery must not replace account data. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchProviderCatalog } from '../src/provider-catalog.js';
import { refreshProviderModels } from '../src/registry/refresh-models.js';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';
import * as env from '../src/env.js';
import { useIsolatedTestHome } from './isolated-test-home.js';

useIsolatedTestHome('leverframe-copilot-refresh');
const ACCESS_TOKEN = globalThis.crypto.randomUUID();
const backend = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/copilot/backend.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/copilot/backend.js')>(), fetchCopilotModels: backend.fetch,
}));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

/** Because migration must preserve existing logins. */
function seedProvider(models: Array<{ id: string; name: string }>): void {
  const registry = emptyRegistry();
  registry.providers.push({
    id: 'github-copilot', templateId: 'github-copilot', name: 'GitHub Copilot', enabled: true,
    authType: 'oauth', authRef: 'keyring:oauth:provider:github-copilot',
    api: { npm: '@github/copilot-sdk', url: '' },
    modelsCache: {
      fetchedAt: new Date().toISOString(),
      models: models.map(model => ({ ...model, upstreamModelId: model.id, contextWindowUnconfirmed: true, modelFormat: 'openai' as const })),
    },
    addedAt: new Date().toISOString(),
  });
  saveRegistry(registry);
}

/** Because fixtures must match the observed HTTP catalog. */
function liveModel(id = 'live-model') {
  return { id, name: id, supported_endpoints: ['/chat/completions'], capabilities: { type: 'chat', supports: { vision: false }, limits: { max_context_window_tokens: 128_000 } } };
}

it('discovers HTTP models and migrates old SDK routing metadata', async () => {
  seedProvider([]);
  backend.fetch.mockResolvedValue([liveModel()]);
  const result = await refreshProviderModels('github-copilot', ACCESS_TOKEN);
  expect(result).toMatchObject({ ok: true, modelCount: 1 });
  expect(backend.fetch).toHaveBeenCalledWith(ACCESS_TOKEN);
  expect(loadRegistry().providers[0]).toMatchObject({
    api: { npm: '@ai-sdk/openai-compatible', url: 'https://api.githubcopilot.com' },
    authRef: 'keyring:oauth:provider:github-copilot',
    modelsCache: { models: [expect.objectContaining({ id: 'live-model', contextWindow: 128_000 })] },
  });
});

it('exposes sparse HTTP records without inventing context limits', async () => {
  seedProvider([]);
  backend.fetch.mockResolvedValue([{ id: 'sparse-model', name: 'Sparse Model', supported_endpoints: ['/chat/completions'], capabilities: { type: 'chat' } }]);
  vi.spyOn(env, 'resolveProviderCredential').mockResolvedValue(ACCESS_TOKEN);
  expect(await refreshProviderModels('github-copilot', ACCESS_TOKEN)).toMatchObject({ ok: true, modelCount: 1 });
  expect(await fetchProviderCatalog()).toContainEqual(expect.objectContaining({
    id: 'github-copilot', models: [expect.objectContaining({ id: 'sparse-model', contextWindowUnconfirmed: true })],
  }));
});

it('preserves cached models and marks a failed HTTP discovery', async () => {
  seedProvider([{ id: 'cached-model', name: 'Cached Model' }]);
  backend.fetch.mockRejectedValue(new Error('HTTP backend unavailable'));
  const result = await refreshProviderModels('github-copilot', ACCESS_TOKEN);
  expect(result).toMatchObject({ ok: true, skipped: true });
  expect(result.reason).toContain('Try refreshing again later');
  expect(loadRegistry().providers[0]?.modelsCache?.models[0]?.id).toBe('cached-model');
  expect(loadRegistry().providers[0]?.modelDiscoveryError?.reason).toBe('HTTP backend unavailable');
});

it('reports schema drift without suggesting an SDK installation', async () => {
  seedProvider([{ id: 'cached-model', name: 'Cached Model' }]);
  backend.fetch.mockResolvedValue([{ id: 'missing-name', capabilities: { type: 'chat' } }]);
  const result = await refreshProviderModels('github-copilot', ACCESS_TOKEN);
  expect(result).toMatchObject({ ok: true, skipped: true });
  expect(result.reason).toContain('unexpected model data');
  expect(result.reason).not.toContain('@github/copilot-sdk');
});

it('fails clearly when no cached models survive an HTTP failure', async () => {
  seedProvider([]);
  backend.fetch.mockRejectedValue(new Error('HTTP backend unavailable'));
  expect(await refreshProviderModels('github-copilot', ACCESS_TOKEN)).toMatchObject({ ok: false });
  expect(loadRegistry().providers[0]?.modelDiscoveryError).toMatchObject({ kind: 'runtime', reason: 'HTTP backend unavailable' });
});

it.each([401, 403])('preserves an authentication rejection from HTTP %s', async status => {
  seedProvider([]);
  backend.fetch.mockRejectedValue(new Error(`GitHub Copilot request failed with HTTP ${status}`));
  const result = await refreshProviderModels('github-copilot', ACCESS_TOKEN);
  expect(result).toMatchObject({ ok: false, reason: expect.stringContaining(`HTTP ${status}`) });
  expect(result.reason).toContain('Sign in again');
  expect(loadRegistry().providers[0]?.modelDiscoveryError?.kind).toBe('authentication');
});

it('persists malformed model records as schema failures', async () => {
  seedProvider([]);
  backend.fetch.mockResolvedValue([{ id: 'missing-name', capabilities: { type: 'chat' } }]);
  await refreshProviderModels('github-copilot', ACCESS_TOKEN);
  expect(loadRegistry().providers[0]?.modelDiscoveryError).toMatchObject({ kind: 'schema', reason: expect.stringContaining('name must be') });
});

it('distinguishes empty catalogs from policy-filtered chat models', async () => {
  seedProvider([]);
  backend.fetch.mockResolvedValue([]);
  expect(await refreshProviderModels('github-copilot', ACCESS_TOKEN)).toMatchObject({ ok: false, reason: expect.stringContaining('returned no models') });
  expect(loadRegistry().providers[0]?.modelDiscoveryError?.kind).toBe('empty');
  backend.fetch.mockResolvedValue([{ ...liveModel(), policy: { state: 'disabled' } }]);
  expect(await refreshProviderModels('github-copilot', ACCESS_TOKEN)).toMatchObject({ ok: false, reason: expect.stringContaining('no policy-enabled models') });
  expect(loadRegistry().providers[0]?.modelDiscoveryError?.kind).toBe('policy');
});

it('clears previous discovery errors after a successful refresh', async () => {
  seedProvider([]);
  backend.fetch.mockRejectedValueOnce(new Error('HTTP backend unavailable'));
  await refreshProviderModels('github-copilot', ACCESS_TOKEN);
  backend.fetch.mockResolvedValueOnce([liveModel()]);
  await refreshProviderModels('github-copilot', ACCESS_TOKEN);
  expect(loadRegistry().providers[0]?.modelDiscoveryError).toBeUndefined();
});

it('does not let an older failure overwrite a newer successful refresh', async () => {
  seedProvider([]);
  let releaseFailure: (() => void) | undefined;
  let failureStarted: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { releaseFailure = resolve; });
  const started = new Promise<void>(resolve => { failureStarted = resolve; });
  backend.fetch.mockImplementationOnce(async () => { failureStarted?.(); await gate; throw new Error('older HTTP failure'); })
    .mockResolvedValueOnce([liveModel('newer-live-model')]);
  const olderFailure = refreshProviderModels('github-copilot', ACCESS_TOKEN);
  await started;
  expect(await refreshProviderModels('github-copilot', ACCESS_TOKEN)).toMatchObject({ ok: true, modelCount: 1 });
  releaseFailure?.();
  await olderFailure;
  expect(loadRegistry().providers[0]?.modelDiscoveryError).toBeUndefined();
  expect(loadRegistry().providers[0]?.modelsCache?.models[0]?.id).toBe('newer-live-model');
});

it('redacts and bounds persisted discovery errors', async () => {
  seedProvider([]);
  backend.fetch.mockRejectedValue(new Error(`Bearer ${ACCESS_TOKEN}\n[31m${'x'.repeat(800)}`));
  const result = await refreshProviderModels('github-copilot', ACCESS_TOKEN);
  const persisted = loadRegistry().providers[0]?.modelDiscoveryError?.reason ?? '';
  expect(result.reason).not.toContain(ACCESS_TOKEN);
  expect(persisted).not.toContain(ACCESS_TOKEN);
  expect([...persisted].some(char => char.charCodeAt(0) <= 31 || char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)).toBe(false);
  expect(persisted.length).toBeLessThanOrEqual(500);
  expect(persisted).toContain('[truncated]');
});

it('persists partial live catalogs with separate warnings and clears previous failures', async () => {
  seedProvider([{ id: 'cached-model', name: 'Cached Model' }]);
  backend.fetch.mockRejectedValueOnce(new Error('earlier failure'));
  await refreshProviderModels('github-copilot', ACCESS_TOKEN);
  backend.fetch.mockResolvedValueOnce([
    liveModel('first'),
    null,
    { id: 'transport-unknown', name: 'Unknown', capabilities: { type: 'chat' } },
    { id: 'disabled', capabilities: { type: 'chat' }, policy: { state: 'disabled' } },
    { id: 'completion', capabilities: { type: 'completion' } },
    { ...liveModel('sparse'), capabilities: { type: 'chat' }, supported_endpoints: ['/v1/messages'] },
  ]);

  const result = await refreshProviderModels('github-copilot', ACCESS_TOKEN);
  expect(result).toMatchObject({ ok: true, modelSource: 'live', modelCount: 2 });
  expect(result.skipped).not.toBe(true);
  expect(result.failureKind).toBeUndefined();
  expect(result.reason).toBe('GitHub Copilot refreshed live models; skipped 4 records (1 schema, 1 transport-unknown, 1 policy, 1 non-chat).');
  expect(result.skippedModels?.map(record => record.index)).toEqual([1, 2, 3, 4]);
  const provider = loadRegistry().providers[0]!;
  expect(provider.modelDiscoveryError).toBeUndefined();
  expect(provider.modelDiscoveryWarnings).toEqual({
    checkedAt: provider.modelsCache?.fetchedAt,
    skippedModels: result.skippedModels,
  });
  expect(provider.modelsCache?.models.map(model => model.id)).toEqual(['first', 'sparse']);
  expect(provider.modelsCache?.models[1]).toMatchObject({ contextWindowUnconfirmed: true, npm: '@ai-sdk/anthropic' });
});

it('clears obsolete warnings after an entirely valid live refresh', async () => {
  seedProvider([]);
  backend.fetch.mockResolvedValueOnce([liveModel(), null]);
  await refreshProviderModels('github-copilot', ACCESS_TOKEN);
  expect(loadRegistry().providers[0]?.modelDiscoveryWarnings?.skippedModels).toHaveLength(1);
  backend.fetch.mockResolvedValueOnce([liveModel('clean')]);
  const result = await refreshProviderModels('github-copilot', ACCESS_TOKEN);
  expect(result).toMatchObject({ ok: true, modelSource: 'live', skippedModels: [] });
  expect(result.reason).toBeUndefined();
  expect(loadRegistry().providers[0]?.modelDiscoveryWarnings).toBeUndefined();
});

it('keeps all-unknown transport discovery classified as cache fallback, never empty live success', async () => {
  seedProvider([{ id: 'cached-model', name: 'Cached Model' }]);
  backend.fetch.mockResolvedValueOnce([
    { id: 'missing', name: 'Missing', capabilities: { type: 'chat' } },
    { ...liveModel('unsupported'), supported_endpoints: ['/embeddings'] },
  ]);
  const result = await refreshProviderModels('github-copilot', ACCESS_TOKEN);
  expect(result).toMatchObject({ ok: true, skipped: true, modelSource: 'cache', failureKind: 'schema' });
  expect(result.skippedModels?.map(record => record.kind)).toEqual(['transport-unknown', 'transport-unknown']);
  expect(loadRegistry().providers[0]?.modelsCache?.models[0]?.id).toBe('cached-model');
  expect(loadRegistry().providers[0]?.modelDiscoveryError?.kind).toBe('schema');
});

it('redacts and bounds skipped record IDs before returning or persisting warnings', async () => {
  seedProvider([]);
  const modelId = `private-${ACCESS_TOKEN}\u001b${'x'.repeat(800)}`;
  backend.fetch.mockResolvedValueOnce([liveModel(), { id: modelId, name: 42, capabilities: { type: 'chat' } }]);
  const result = await refreshProviderModels('github-copilot', ACCESS_TOKEN);
  const persisted = loadRegistry().providers[0]?.modelDiscoveryWarnings?.skippedModels[0]?.modelId ?? '';
  expect(result).toMatchObject({ ok: true, modelSource: 'live' });
  expect(result.skippedModels?.[0]?.modelId).toBe(persisted);
  expect(persisted).not.toContain(ACCESS_TOKEN);
  expect(persisted).not.toContain('\u001b');
  expect(persisted.length).toBeLessThanOrEqual(500);
  expect(persisted).toContain('[truncated]');
  expect(loadRegistry().providers[0]?.modelDiscoveryError).toBeUndefined();
});

it.each([
  null,
  [],
  { checkedAt: 42, skippedModels: [] },
  { checkedAt: 'now', skippedModels: {} },
  { checkedAt: 'now', skippedModels: [null] },
  { checkedAt: 'now', skippedModels: [{ index: -1, kind: 'schema', reason: 'invalid' }] },
  { checkedAt: 'now', skippedModels: [{ index: 0.5, kind: 'schema', reason: 'invalid' }] },
  { checkedAt: 'now', skippedModels: [{ index: 0, kind: 'unknown-kind', reason: 'invalid' }] },
  { checkedAt: 'now', skippedModels: [{ index: 0, kind: 'schema', reason: 42 }] },
  { checkedAt: 'now', skippedModels: [{ index: 0, kind: 'schema', modelId: 42, reason: 'invalid' }] },
])('rejects malformed persisted discovery warnings %# without changing the saved provider', warnings => {
  seedProvider([]);
  const registry = loadRegistry();
  Object.assign(registry.providers[0]!, { modelDiscoveryWarnings: warnings });
  expect(() => saveRegistry(registry)).toThrow('Provider registry contains an invalid provider entry.');
  expect(loadRegistry().providers[0]?.modelDiscoveryWarnings).toBeUndefined();
});
