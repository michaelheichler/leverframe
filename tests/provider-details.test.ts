import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProvidersHub } from '../src/providers-command-crud.js';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';
import type { RegistryProvider } from '../src/registry/types.js';
import * as catalog from '../src/provider-catalog.js';
import * as prompts from '../src/prompts.js';

const selectMock = vi.hoisted(() => vi.fn());

vi.mock('@clack/prompts', async importOriginal => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return { ...actual, select: selectMock };
});

const previousHome = process.env.LEVERFRAME_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-provider-detail-'));
  process.env.LEVERFRAME_HOME = home;
  selectMock.mockReset();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function openaiEntry(partial: Partial<RegistryProvider> = {}): RegistryProvider {
  return {
    id: 'openai', templateId: 'openai', name: 'OpenAI', enabled: true,
    authRef: 'keyring:provider:openai', api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
    addedAt: new Date().toISOString(), ...partial,
  };
}

it('shows discovery errors with refresh and sign-in actions', async () => {
  const registry = emptyRegistry();
  registry.providers.push({
    id: 'github-copilot', templateId: 'github-copilot', name: 'GitHub Copilot', enabled: true,
    authType: 'oauth', authRef: 'keyring:oauth:provider:github-copilot',
    api: { npm: '@github/copilot-sdk' }, addedAt: new Date().toISOString(),
    modelDiscoveryError: { failedAt: new Date().toISOString(), kind: 'runtime', reason: 'Provider setup is incomplete.' },
  });
  saveRegistry(registry);
  selectMock.mockResolvedValueOnce('provider:github-copilot').mockResolvedValueOnce('back').mockResolvedValueOnce('done');
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  await runProvidersHub();

  expect(output.mock.calls.flat().join('')).toContain('Provider setup is incomplete.');
  expect(selectMock.mock.calls[1]?.[0].options.map((option: { value: string }) => option.value))
    .toEqual(expect.arrayContaining(['refresh', 'auth']));
});

it('refreshes an enabled provider before browsing its models', async () => {
  saveRegistry({ ...emptyRegistry(), providers: [openaiEntry()] });
  const model = { id: 'fresh-model', upstreamModelId: 'fresh-model', name: 'Fresh model', family: 'gpt', brand: 'OpenAI', modelFormat: 'openai' as const };
  const provider = { id: 'openai', name: 'OpenAI', apiKey: '', models: [model] };
  const refresh = vi.spyOn(catalog, 'fetchBrowsingProviderCatalog').mockResolvedValue({
    providers: [provider], statuses: [{ providerId: 'openai', providerName: 'OpenAI', source: 'live', fetchedAt: '2026-09-14' }],
  });
  const browse = vi.spyOn(prompts, 'browseAllModels').mockResolvedValue(null);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  selectMock.mockResolvedValueOnce('provider:openai').mockResolvedValueOnce('browse').mockResolvedValueOnce('done');

  await runProvidersHub();

  expect(refresh).toHaveBeenCalledOnce();
  expect(browse).toHaveBeenCalledWith(provider, expect.any(Object));
  expect(loadRegistry().providers[0]?.enabled).toBe(true);
});

it('uses cached models for a disabled provider without refreshing', async () => {
  saveRegistry({ ...emptyRegistry(), providers: [openaiEntry({
    enabled: false,
    modelsCache: { fetchedAt: '2026-09-01', models: [{ id: 'old-model', upstreamModelId: 'old-model', name: 'Old model', modelFormat: 'openai' }] },
  })] });
  const refresh = vi.spyOn(catalog, 'fetchBrowsingProviderCatalog');
  const browse = vi.spyOn(prompts, 'browseAllModels').mockResolvedValue(null);
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  selectMock.mockResolvedValueOnce('provider:openai').mockResolvedValueOnce('browse').mockResolvedValueOnce('done');

  await runProvidersHub();

  expect(refresh).not.toHaveBeenCalled();
  expect(browse).toHaveBeenCalledWith(expect.objectContaining({ models: [expect.objectContaining({ id: 'old-model' })] }), expect.any(Object));
  expect(output.mock.calls.flat().join('')).toContain('Showing cached models without refreshing');
  expect(loadRegistry().providers[0]?.enabled).toBe(false);
});
