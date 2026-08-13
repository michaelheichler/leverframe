/**
 * Verifies the registry dispatches Copilot discovery through an injected SDK runtime.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CopilotRuntimeHandle } from '../src/copilot/runtime.js';
import { CopilotSdkNotInstalledError } from '../src/copilot/runtime.js';
import { fetchProviderCatalog } from '../src/provider-catalog.js';
import { refreshProviderModels } from '../src/registry/refresh-models.js';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';
import * as env from '../src/env.js';

const ACCESS_TOKEN = ['fixture', 'github', 'oauth', 'token'].join('-');
const runtime = vi.hoisted(() => ({
  create: vi.fn(),
  listModels: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  forceStop: vi.fn(),
}));

vi.mock('../src/copilot/runtime.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/copilot/runtime.js')>();
  return {
    ...actual,
    createDefaultCopilotRuntime: runtime.create,
  };
});

function runtimeHandle(): CopilotRuntimeHandle {
  return {
    start: runtime.start,
    listModels: runtime.listModels,
    stop: runtime.stop,
    forceStop: runtime.forceStop,
    createSession: vi.fn(async () => ({})),
  };
}

function seedProvider(models: Array<{ id: string; name: string }>): void {
  const registry = emptyRegistry();
  registry.providers.push({
    id: 'github-copilot',
    templateId: 'github-copilot',
    name: 'GitHub Copilot',
    enabled: true,
    authType: 'oauth',
    authRef: 'keyring:oauth:provider:github-copilot',
    api: { npm: '@github/copilot-sdk', url: '' },
    modelsCache: {
      fetchedAt: new Date().toISOString(),
      models: models.map(model => ({
        ...model,
        upstreamModelId: model.id,
        contextWindowUnconfirmed: true,
        modelFormat: 'openai' as const,
      })),
    },
    addedAt: new Date().toISOString(),
  });
  saveRegistry(registry);
}

let home: string;
const previousHome = process.env.LEVERFRAME_HOME;

function registerRefreshTestLifecycle(): void {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'leverframe-copilot-refresh-'));
    process.env.LEVERFRAME_HOME = home;
    vi.clearAllMocks();
    runtime.create.mockReturnValue(runtimeHandle());
    runtime.start.mockResolvedValue(undefined);
    runtime.stop.mockResolvedValue([]);
    runtime.forceStop.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
    else process.env.LEVERFRAME_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
}

describe('refreshProviderModels github-copilot live discovery', () => {
  registerRefreshTestLifecycle();

  it('discovers and stores live models without an API base URL', async () => {
    seedProvider([]);
    runtime.listModels.mockResolvedValue([{
      id: 'live-model',
      name: 'Live Model',
      capabilities: {
        supports: { vision: false, reasoningEffort: false },
        limits: { max_context_window_tokens: 128_000 },
      },
    }]);

    const result = await refreshProviderModels('github-copilot', ACCESS_TOKEN);

    expect(result).toMatchObject({ ok: true, modelCount: 1 });
    expect(runtime.create).toHaveBeenCalledWith(expect.objectContaining({
      gitHubToken: ACCESS_TOKEN,
    }));
    expect(loadRegistry().providers[0]?.modelsCache?.models[0]).toEqual(
      expect.objectContaining({ id: 'live-model', contextWindow: 128_000 }),
    );
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });

  it('stores sparse SDK records and exposes the provider in the catalog', async () => {
    seedProvider([]);
    runtime.listModels.mockResolvedValue([{
      id: 'sparse-model',
      name: 'Sparse Model',
      capabilities: {
        supports: {},
        limits: { max_context_window_tokens: 0 },
      },
    }]);
    vi.spyOn(env, 'resolveProviderCredential').mockResolvedValue(ACCESS_TOKEN);

    const result = await refreshProviderModels('github-copilot', ACCESS_TOKEN);
    const catalog = await fetchProviderCatalog();

    expect(result).toMatchObject({ ok: true, modelCount: 1 });
    expect(catalog).toContainEqual(expect.objectContaining({
      id: 'github-copilot',
      models: [expect.objectContaining({
        id: 'sparse-model',
        contextWindowUnconfirmed: true,
      })],
    }));
  });

});

describe('refreshProviderModels github-copilot failure safety', () => {
  registerRefreshTestLifecycle();

  it('preserves cached models when the runtime fails', async () => {
    seedProvider([{ id: 'cached-model', name: 'Cached Model' }]);
    runtime.listModels.mockRejectedValue(new Error('runtime unavailable'));

    const result = await refreshProviderModels('github-copilot', ACCESS_TOKEN);

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('GitHub Copilot model discovery failed');
    expect(result.reason).toContain('Try refreshing again later');
    expect(loadRegistry().providers[0]?.modelsCache?.models[0]?.id).toBe('cached-model');
    expect(loadRegistry().providers[0]?.modelDiscoveryError?.reason).toBe('runtime unavailable');
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });


  it('reports SDK schema drift separately from transient failures', async () => {
    seedProvider([{ id: 'cached-model', name: 'Cached Model' }]);
    runtime.listModels.mockResolvedValue([{ id: 'missing-fields' }]);

    const result = await refreshProviderModels('github-copilot', ACCESS_TOKEN);

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('unexpected model data');
    expect(result.reason).not.toContain('Try refreshing again later');
  });

  it('fails clearly when no cached models survive a runtime error', async () => {
    seedProvider([]);
    runtime.listModels.mockRejectedValue(new Error('runtime unavailable'));

    const result = await refreshProviderModels('github-copilot', ACCESS_TOKEN);

    expect(result).toMatchObject({ ok: false });
    expect(result.reason).toContain('Try refreshing again later');
    expect(loadRegistry().providers[0]?.modelDiscoveryError).toEqual(expect.objectContaining({
      kind: 'runtime',
      reason: 'runtime unavailable',
    }));
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      error: new CopilotSdkNotInstalledError(new Error('missing optional dependency')),
      kind: 'sdk',
      message: 'npm install @github/copilot-sdk',
    },
    {
      error: new Error('GitHub Copilot request failed with HTTP 401'),
      kind: 'authentication',
      message: 'HTTP 401',
    },
  ])('persists distinct $kind discovery failures', async ({ error, kind, message }) => {
    seedProvider([]);
    runtime.listModels.mockRejectedValue(error);

    const result = await refreshProviderModels('github-copilot', ACCESS_TOKEN);

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining(message) });
    expect(result.reason).toContain(kind === 'sdk' ? 'Install @github/copilot-sdk@1.0.9' : 'Sign in again');
    expect(loadRegistry().providers[0]?.modelDiscoveryError).toEqual(expect.objectContaining({
      kind,
      reason: expect.stringContaining(message),
    }));
  });

  it('persists malformed SDK responses as schema failures', async () => {
    seedProvider([]);
    runtime.listModels.mockResolvedValue([{ id: 'missing-fields' }]);

    await refreshProviderModels('github-copilot', ACCESS_TOKEN);

    expect(loadRegistry().providers[0]?.modelDiscoveryError).toEqual(expect.objectContaining({
      kind: 'schema',
      reason: expect.stringContaining('name must be a non-empty string'),
    }));
  });

  it('distinguishes an empty account catalog from policy-filtered models', async () => {
    seedProvider([]);
    runtime.listModels.mockResolvedValue([]);

    const emptyResult = await refreshProviderModels('github-copilot', ACCESS_TOKEN);

    expect(emptyResult).toMatchObject({
      ok: false,
      reason: expect.stringContaining('returned no models'),
    });
    expect(emptyResult.reason).toContain('eligible Copilot subscription');
    expect(loadRegistry().providers[0]?.modelDiscoveryError?.kind).toBe('empty');

    runtime.listModels.mockResolvedValue([{
      id: 'disabled-model',
      name: 'Disabled Model',
      capabilities: {},
      policy: { state: 'disabled' },
    }]);

    const policyResult = await refreshProviderModels('github-copilot', ACCESS_TOKEN);

    expect(policyResult).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no policy-enabled models'),
    });
    expect(policyResult.reason).toContain('organization model policy');
    expect(loadRegistry().providers[0]?.modelDiscoveryError?.kind).toBe('policy');
  });

  it('clears a previous discovery error after live models are stored', async () => {
    seedProvider([]);
    runtime.listModels.mockRejectedValueOnce(new Error('runtime unavailable'));
    await refreshProviderModels('github-copilot', ACCESS_TOKEN);
    runtime.listModels.mockResolvedValueOnce([{
      id: 'live-model',
      name: 'Live Model',
      capabilities: {},
    }]);

    await refreshProviderModels('github-copilot', ACCESS_TOKEN);

    expect(loadRegistry().providers[0]?.modelDiscoveryError).toBeUndefined();
  });

  it('does not let an older failed refresh overwrite a newer success', async () => {
    seedProvider([]);
    let releaseFailure: (() => void) | undefined;
    let failureStarted: (() => void) | undefined;
    const failureGate = new Promise<void>(resolve => { releaseFailure = resolve; });
    const failureStart = new Promise<void>(resolve => { failureStarted = resolve; });
    runtime.listModels
      .mockImplementationOnce(async () => {
        failureStarted?.();
        await failureGate;
        throw new Error('older runtime failure');
      })
      .mockResolvedValueOnce([{
        id: 'newer-live-model',
        name: 'Newer Live Model',
        capabilities: {},
      }]);
    const olderFailure = refreshProviderModels('github-copilot', ACCESS_TOKEN);
    await failureStart;

    const newerSuccess = await refreshProviderModels('github-copilot', ACCESS_TOKEN);
    releaseFailure?.();
    await olderFailure;

    expect(newerSuccess).toMatchObject({ ok: true, modelCount: 1 });
    expect(loadRegistry().providers[0]?.modelDiscoveryError).toBeUndefined();
    expect(loadRegistry().providers[0]?.modelsCache?.models[0]?.id).toBe('newer-live-model');
  });

  it('redacts, compacts, and bounds persisted discovery errors', async () => {
    seedProvider([]);
    const longSecret = `Bearer ${ACCESS_TOKEN}\n\u001b[31m${'x'.repeat(800)}`;
    runtime.listModels.mockRejectedValue(new Error(longSecret));

    const result = await refreshProviderModels('github-copilot', ACCESS_TOKEN);
    const persisted = loadRegistry().providers[0]?.modelDiscoveryError?.reason ?? '';

    expect(result.reason).not.toContain(ACCESS_TOKEN);
    expect(persisted).not.toContain(ACCESS_TOKEN);
    expect(Array.from(persisted).some(character => {
      const code = character.charCodeAt(0);
      return code <= 31 || code >= 127 && code <= 159;
    })).toBe(false);
    expect(persisted.length).toBeLessThanOrEqual(500);
    expect(persisted).toContain('[truncated]');
  });


  it('keeps the discovery failure primary when cleanup also fails', async () => {
    seedProvider([]);
    runtime.listModels.mockRejectedValue(new Error('authentication failed'));
    runtime.stop.mockRejectedValue(new Error('graceful stop failed'));
    runtime.forceStop.mockRejectedValue(new Error('forced stop failed'));

    const result = await refreshProviderModels('github-copilot', ACCESS_TOKEN);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('authentication failed');
    expect(runtime.forceStop).toHaveBeenCalledTimes(1);
  });
});
