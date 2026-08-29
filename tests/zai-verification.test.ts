import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTemplateById } from '../src/provider-templates.js';
import { addProviderFromTemplate } from '../src/registry/add-template.js';
import * as env from '../src/env.js';
import * as io from '../src/registry/io.js';
import * as pricing from '../src/registry/pricing.js';
import { withCredentialMutationLock } from '../src/registry/lock.js';

const lifecycle = vi.hoisted(() => ({
  cancelCredentialDelete: vi.fn(),
  journalCredentialWrite: vi.fn(),
  reconcilePendingCredentialDeletes: vi.fn(async () => ({ deleted: [], pending: [] })),
}));

vi.mock('../src/env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/env.js')>();
  return {
    ...actual,
    saveProviderCredential: vi.fn(),
    resolveProviderCredential: vi.fn(),
  };
});
vi.mock('../src/provider-factory.js', () => ({ isSdkMigratedNpm: vi.fn(() => true) }));
vi.mock('../src/registry/credential-lifecycle.js', () => ({
  cancelCredentialDelete: lifecycle.cancelCredentialDelete,
  journalCredentialWrite: lifecycle.journalCredentialWrite,
  reconcilePendingCredentialDeletes: lifecycle.reconcilePendingCredentialDeletes,
}));
vi.mock('../src/registry/io.js', () => ({
  loadRegistry: vi.fn(),
  loadRegistryStrict: vi.fn(),
  saveRegistry: vi.fn(),
  updateRegistry: vi.fn((mutate: (registry: { schemaVersion: 1; providers: unknown[] }) => unknown) => {
    const registry = { schemaVersion: 1 as const, providers: [] };
    return mutate(registry);
  }),
}));
vi.mock('../src/registry/pricing.js', () => ({
  loadPricingCache: vi.fn(),
  enrichModelsWithPricing: vi.fn(),
  enrichPricingAsync: vi.fn(),
  pricingPlatformForProvider: vi.fn(),
  buildPricingIndex: vi.fn(),
}));

const zai = () => getTemplateById('zai')!;

process.env['LEVERFRAME_HOME'] = join(mkdtempSync(join(tmpdir(), 'leverframe-zai-')), 'home');

describe('z.ai Coding Plan live key verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(env.saveProviderCredential).mockResolvedValue(true);
    lifecycle.cancelCredentialDelete.mockResolvedValue(undefined);
    vi.mocked(io.loadRegistry).mockReturnValue({ schemaVersion: 1, providers: [] });
    vi.mocked(io.loadRegistryStrict).mockReturnValue({ schemaVersion: 1, providers: [] });
    vi.mocked(pricing.enrichModelsWithPricing).mockImplementation(
      (models: unknown) => models as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('validates the key against the live Coding Plan models endpoint and caches its models', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [
          { id: 'glm-4.7' },
          { id: 'glm-5-turbo' },
          { id: 'glm-5.2' },
        ],
      }),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await addProviderFromTemplate(zai(), 'test-key');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.z.ai/api/coding/paas/v4/models',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    );
    expect(result.added).toBe(true);
    expect(result.keyVerified).toBe(true);
    expect(result.provider?.modelsCache?.models.map(model => model.id)).toEqual([
      'glm-4.7',
      'glm-5-turbo',
      'glm-5.2',
    ]);
  });

  it('keeps the live GLM-5.2 context window over the declared template constant', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{ id: 'glm-5.2', name: 'GLM-5.2 live', context_length: 128_000 }],
      }),
    } as Response));

    const result = await addProviderFromTemplate(zai(), 'test-key');

    expect(result.keyVerified).toBe(true);
    expect(result.provider?.modelsCache?.models[0]).toMatchObject({
      id: 'glm-5.2',
      name: 'GLM-5.2 live',
      contextWindow: 128_000,
    });
  });

  it('falls back to the declared template context window when the listing omits one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{ id: 'glm-5.2', name: 'GLM-5.2 live' }],
      }),
    } as Response));

    const result = await addProviderFromTemplate(zai(), 'test-key');

    const declared = zai().staticModels?.find(model => model.id === 'glm-5.2')?.contextWindow;
    expect(result.keyVerified).toBe(true);
    expect(result.provider?.modelsCache?.models[0]).toMatchObject({
      id: 'glm-5.2',
      contextWindow: declared,
    });
  });

  it('rejects a 401 response without persisting the credential or registry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid api key',
    } as Response));

    const result = await addProviderFromTemplate(zai(), 'test-key');

    expect(result.added).toBe(false);
    expect(result.error).toMatch(/rejected/i);
    expect(env.saveProviderCredential).not.toHaveBeenCalled();
    expect(io.saveRegistry).not.toHaveBeenCalled();
  });

  it('uses the documented static models after a 5xx response and stores the key unverified', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
    } as Response));

    const result = await addProviderFromTemplate(zai(), 'test-key');

    expect(result.added).toBe(true);
    expect(result.keyVerified).toBe(false);
    expect(result.provider?.modelsCache?.models.map(model => model.id)).toEqual([
      'glm-5.2',
      'glm-5-turbo',
      'glm-4.7',
    ]);
    expect(result.provider?.modelsCache?.models[0]?.contextWindow)
      .toBe(zai().staticModels?.find(model => model.id === 'glm-5.2')?.contextWindow);
    expect(result.hint).toMatch(/listing.*unavailable|did not verify/i);
  });

  it('holds the credential lock through template registry publication', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ id: 'glm-5.2' }] }),
    } as Response));
    let releaseSave: (() => void) | undefined;
    let saveStarted: (() => void) | undefined;
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
    const saveStart = new Promise<void>(resolve => { saveStarted = resolve; });
    vi.mocked(env.saveProviderCredential).mockImplementation(async () => {
      saveStarted?.();
      await saveGate;
      return true;
    });
    const publication = addProviderFromTemplate(zai(), 'test-key');
    await saveStart;
    let contenderEntered = false;
    const contender = withCredentialMutationLock(
      'keyring:provider:zai',
      async () => { contenderEntered = true; },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(contenderEntered).toBe(false);
    releaseSave?.();
    await expect(publication).resolves.toMatchObject({ added: true });
    await contender;
    expect(contenderEntered).toBe(true);
    expect(lifecycle.cancelCredentialDelete).toHaveBeenCalledWith('keyring:provider:zai');
  });
});
