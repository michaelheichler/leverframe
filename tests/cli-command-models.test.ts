import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runModelsCommand } from '../src/cli-command-models.js';
import { loadPreferences, savePreferences } from '../src/config.js';
import { resetLegacyMigrationForTests } from '../src/paths.js';
import { parseArgs } from '../src/cli-args.js';
import { getAppHome, getConfigPath } from '../src/paths.js';
import { loadRegistry } from '../src/registry/io.js';
import type { LocalProvider } from '../src/types.js';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  confirm: vi.fn(),
  fetchBrowsingProviderCatalog: vi.fn(),
  fetchFreshProviderCatalog: vi.fn(),
  readNativeAuth: vi.fn(),
  fetchNativeModels: vi.fn(),
}));

vi.mock('@clack/prompts', async importOriginal => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return {
    ...actual,
    log: {
      error: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
    },
    select: mocks.select,
    confirm: mocks.confirm,
  };
});

vi.mock('../src/provider-catalog.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/provider-catalog.js')>(),
  fetchBrowsingProviderCatalog: mocks.fetchBrowsingProviderCatalog,
  fetchFreshProviderCatalog: mocks.fetchFreshProviderCatalog,
}));

vi.mock('../src/claude-code-credentials.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/claude-code-credentials.js')>(),
  readClaudeCodeAuthMaterial: mocks.readNativeAuth,
}));

vi.mock('../src/registry/anthropic-models-fetch.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/registry/anthropic-models-fetch.js')>(),
  fetchAnthropicModels: mocks.fetchNativeModels,
}));

let tempHome: string;
let previousHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'leverframe-models-cmd-'));
  previousHome = process.env['LEVERFRAME_HOME'];
  process.env['LEVERFRAME_HOME'] = tempHome;
  resetLegacyMigrationForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousHome;
  resetLegacyMigrationForTests();
  vi.clearAllMocks();
});

describe('runModelsCommand retired context ceiling flags', () => {
  it('preserves a stored ceiling preference and explains the picker migration', async () => {
    savePreferences({ contextCeilingOverrides: ['gpt-5.6-sol'] });
    expect(loadPreferences().contextCeilingOverrides).toEqual(['gpt-5.6-sol']);

    const code = await runModelsCommand({ noContextCeiling: 'gpt-5.6-sol' });

    expect(code).toBe(1);
    expect(loadPreferences().contextCeilingOverrides).toEqual(['gpt-5.6-sol']);
  });

  it('does not write a new ceiling preference', async () => {
    const code = await runModelsCommand({ contextCeiling: 'gpt-5.6-sol' });

    expect(code).toBe(1);
    expect(loadPreferences().contextCeilingOverrides).toBeUndefined();
  });

  it('refuses to opt out of a ceiling that was never stored', async () => {
    const code = await runModelsCommand({ noContextCeiling: 'gpt-5.6-sol' });

    expect(code).toBe(1);
    expect(loadPreferences().contextCeilingOverrides).toBeUndefined();
  });
});

describe('Switchyard root command parsing', () => {
  it('accepts the model-routing action and its arguments', () => {
    const parsed = parseArgs(['switchyard', 'status']);

    expect(parsed.error).toBeUndefined();
    expect(parsed.claudeArgs).toEqual(['status']);
  });
});

describe('Switchyard submenu in models', () => {
  it('returns cleanly from the no-provider screen without changing preferences', async () => {
    mocks.fetchBrowsingProviderCatalog.mockResolvedValue({ providers: [], statuses: [] });
    mocks.select.mockResolvedValueOnce('done');
    const before = loadPreferences();
    expect(getAppHome()).toBe(tempHome);
    expect(getConfigPath()).toBe(join(tempHome, 'config.json'));

    const result = await runModelsCommand();

    expect(result).toBe(0);
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(loadPreferences()).toEqual(before);
  });

  it('opens the Switchyard submenu from the no-provider screen', async () => {
    mocks.fetchBrowsingProviderCatalog.mockResolvedValue({ providers: [], statuses: [] });
    mocks.select.mockImplementationOnce((input: { options: Array<{ value: string }> }) =>
      Promise.resolve(input.options.some(option => option.value === 'switchyard') ? 'switchyard' : 'done'));
    mocks.select.mockResolvedValueOnce('done');

    const result = await runModelsCommand();

    expect(result).toBe(0);
    expect(mocks.select).toHaveBeenCalledTimes(2);
  });

  it('discovers and displays native models from a local first-setup snapshot', async () => {
    const model = { id: 'first-setup-native-model', name: 'First setup native model', upstreamModelId: 'first-setup-native-upstream', modelFormat: 'anthropic' as const };
    const registryBefore = loadRegistry(), output = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.fetchBrowsingProviderCatalog.mockResolvedValue({ providers: [], statuses: [] });
    mocks.fetchFreshProviderCatalog.mockResolvedValue({ providers: [], unavailable: [], refresh: { refreshed: [] } });
    mocks.readNativeAuth.mockResolvedValue({ kind: 'oauth', token: 'first-setup-menu-secret' });
    mocks.fetchNativeModels.mockImplementation(async baseUrl => ({ baseUrl, models: [model] }));
    mocks.select.mockImplementationOnce((input: { options: Array<{ value: string }> }) => Promise.resolve(input.options.some(option => option.value === 'switchyard') ? 'switchyard' : 'done'));
    mocks.select.mockImplementationOnce((input: { options: Array<{ value: string }> }) => Promise.resolve(input.options.some(option => option.value === 'refresh') ? 'refresh' : 'done'));
    mocks.select.mockResolvedValueOnce('done');
    expect(getAppHome()).toBe(tempHome); expect(getConfigPath()).toBe(join(tempHome, 'config.json'));

    const result = await runModelsCommand();

    expect(result).toBe(0); expect(mocks.fetchFreshProviderCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.readNativeAuth).toHaveBeenCalledTimes(1); expect(mocks.fetchNativeModels).toHaveBeenCalledTimes(1);
    expect(output.mock.calls.flat().join('\n')).toContain(model.id); expect(loadRegistry()).toEqual(registryBefore);
  });

});

describe('models behavior with saved routing', () => {
  it('shows the active-routing notice when saved routing is enabled', async () => {
    const model = { providerId: 'fixture-provider', modelId: 'fixture-model' };
    mocks.fetchBrowsingProviderCatalog.mockResolvedValue({ providers: [], statuses: [] });
    mocks.select.mockResolvedValueOnce('done');
    savePreferences({ routing: { enabled: true, cheapFallback: model } });

    await runModelsCommand();

    expect(loadPreferences().routing?.enabled).toBe(true);
    expect(getConfigPath()).toBe(join(tempHome, 'config.json'));
    expect(vi.mocked((await import('@clack/prompts')).log.info)).toHaveBeenCalledTimes(2);
  });

  it('keeps favorite removal available in the existing provider flow', async () => {
    const provider: LocalProvider = {
      id: 'fixture-provider',
      name: 'Fixture provider',
      apiKey: 'fixture-key',
      authType: 'api',
      models: [{
        id: 'fixture-model',
        name: 'Fixture model',
        family: 'fixture',
        brand: 'Fixture',
        modelFormat: 'anthropic',
        upstreamModelId: 'fixture-model',
        npm: '@ai-sdk/anthropic',
        completionsUrl: 'https://fixture.invalid/v1',
        contextWindow: 1000,
        maxContextWindow: 1000,
      }],
    };
    mocks.fetchBrowsingProviderCatalog.mockResolvedValue({ providers: [provider], statuses: [] });
    mocks.select.mockImplementationOnce((input: { options: Array<{ value: string }> }) =>
      Promise.resolve(input.options.some(option => option.value === 'fav-0') ? 'fav-0' : '__done__'));
    mocks.select.mockResolvedValueOnce('__done__');
    mocks.confirm.mockResolvedValue(true);
    savePreferences({ favoriteModels: [{ providerId: provider.id, modelId: provider.models[0]!.id }] });
    expect(getConfigPath()).toBe(join(tempHome, 'config.json'));

    const result = await runModelsCommand();

    expect(result).toBe(0);
    expect(loadPreferences().favoriteModels).toEqual([]);
  });
});
