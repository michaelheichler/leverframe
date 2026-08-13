/**
 * Verifies the registry dispatches Copilot discovery through an injected SDK runtime.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CopilotRuntimeHandle } from '../src/copilot/runtime.js';
import { refreshProviderModels } from '../src/registry/refresh-models.js';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';

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

});

describe('refreshProviderModels github-copilot failure safety', () => {
  registerRefreshTestLifecycle();

  it('preserves cached models when the runtime fails', async () => {
    seedProvider([{ id: 'cached-model', name: 'Cached Model' }]);
    runtime.listModels.mockRejectedValue(new Error('runtime unavailable'));

    const result = await refreshProviderModels('github-copilot', ACCESS_TOKEN);

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('runtime unavailable');
    expect(loadRegistry().providers[0]?.modelsCache?.models[0]?.id).toBe('cached-model');
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

    expect(result).toMatchObject({ ok: false, reason: 'runtime unavailable' });
    expect(runtime.stop).toHaveBeenCalledTimes(1);
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
