import { beforeEach, expect, it, vi } from 'vitest';
import * as prompts from '@clack/prompts';
import { isAbsolute, relative } from 'node:path';
import { getAppHome, getConfigPath, getProvidersPath } from '../src/paths.js';
import { saveRegistry } from '../src/registry/io.js';
import type { RegistryProvider } from '../src/registry/types.js';
import { loadPreferences, savePreferences } from '../src/config.js';

const accountCredentialFixture = vi.hoisted(() => ({ values: {} as Record<string, string> }));

const harness = vi.hoisted(() => ({
  answers: [] as unknown[],
  selections: [] as Array<{ options: Array<{ value: string; label: string; hint?: string }> }>,
  routingAtSelection: [] as unknown[],
  readRouting: () => undefined as unknown,
  infos: [] as string[],
  fetchFreshProviderCatalog: vi.fn(),
  readNativeAuth: vi.fn(async () => null),
  fetchNativeModels: vi.fn(async (_baseUrl: string, _apiKey: string, _headers?: Record<string, string>) => {
    throw new Error('Native model discovery is blocked in this fixture.');
  }),
  resolveProviderAccountAuth: vi.fn(async (providerId: string, account: { id: string }) => {
    const apiKey = accountCredentialFixture.values[`${providerId}/${account.id}`];
    if (!apiKey) throw new Error('Unexpected account credential request in this fixture.');
    return { apiKey };
  }),
  resolveProviderAuth: vi.fn(async () => {
    throw new Error('Unexpected provider credential request in this fixture.');
  }),
}));

vi.mock('@clack/prompts', async importOriginal => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return {
    ...actual,
    select: vi.fn(async (input: { options: Array<{ value: string; label: string; hint?: string }> }) => {
      harness.selections.push(input);
      harness.routingAtSelection.push(harness.readRouting());
      return harness.answers.shift();
    }),
    log: { ...actual.log, info: vi.fn((message: string) => { harness.infos.push(message); }) },
  };
});

vi.mock('../src/provider-catalog.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/provider-catalog.js')>();
  return { ...actual, fetchFreshProviderCatalog: harness.fetchFreshProviderCatalog };
});

vi.mock('../src/claude-code-credentials.js', () => ({ readClaudeCodeAuthMaterial: harness.readNativeAuth }));
vi.mock('../src/registry/anthropic-models-fetch.js', () => ({ fetchAnthropicModels: harness.fetchNativeModels }));
vi.mock('../src/env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/env.js')>();
  return { ...actual, resolveProviderAccountAuth: harness.resolveProviderAccountAuth, resolveProviderAuth: harness.resolveProviderAuth };
});

beforeEach(() => {
  const testHome = process.env['LEVERFRAME_TEST_HOME'];
  expect(testHome).toBeTruthy();
  const relativeConfig = relative(testHome!, getConfigPath());
  expect(!relativeConfig.startsWith('..') && !isAbsolute(relativeConfig)).toBe(true);
  savePreferences({ routing: { enabled: false, subscriptionPreference: 'auto' } });
  harness.answers = [];
  harness.selections = [];
  harness.routingAtSelection = [];
  harness.readRouting = () => loadPreferences().routing;
  harness.infos = [];
  accountCredentialFixture.values = {};
  harness.fetchFreshProviderCatalog.mockReset();
  harness.readNativeAuth.mockClear();
  harness.fetchNativeModels.mockClear();
  harness.resolveProviderAccountAuth.mockClear();
  harness.resolveProviderAuth.mockClear();
  vi.mocked(prompts.select).mockClear();
  vi.mocked(prompts.log.info).mockClear();
});

it.each([
  { modelSource: 'live' as const, hintsEqual: false, unresolvedInfoCount: 0 },
  { modelSource: 'cache' as const, hintsEqual: true, unresolvedInfoCount: 1 },
])('offers family suggestions only when discovery is confirmed current ($modelSource)', async ({ modelSource, hintsEqual, unresolvedInfoCount }) => {
  const testHome = process.env['LEVERFRAME_TEST_HOME'];
  expect(testHome).toBeTruthy();
  const appPath = relative(testHome!, getAppHome());
  expect(appPath === '' || (!appPath.startsWith('..') && !isAbsolute(appPath))).toBe(true);
  const registryPath = relative(testHome!, getProvidersPath());
  expect(!registryPath.startsWith('..') && !isAbsolute(registryPath)).toBe(true);

  const fetchedAt = '2026-10-01T00:00:00.000Z';
  const routerId = 'fixture-router-provider';
  const customId = 'fixture-custom-provider';
  const selectedModel = 'fixture-cheap-model';
  const suggestedModel = 'fixture-deepseek-flash';
  const otherSuggestedVersion = 'fixture-deepseek-flash-version2';
  const expensiveModel = 'fixture-expensive-model';
  const lookalikeModel = 'fixture-custom-deepseek-flash';
  accountCredentialFixture.values = {
    [`${routerId}/router-account`]: 'synthetic-router-auth',
    [`${customId}/custom-account`]: 'synthetic-custom-auth',
  };
  const providers: RegistryProvider[] = [
    {
      id: routerId, templateId: 'opencode-go', name: 'Generic provider', enabled: true,
      authRef: `none:${routerId}`, authType: 'none', api: { url: 'https://router-fixture.invalid/v1' }, addedAt: fetchedAt,
      accounts: [{ id: 'router-account', authRef: 'keyring:router-account', enabled: true, modelsCache: { fetchedAt, models: [
          { id: selectedModel, name: selectedModel, upstreamModelId: selectedModel, modelFormat: 'anthropic',
            pricing: { input: 1, output: 1, source: 'fixture', observedAt: fetchedAt } },
        { id: suggestedModel, name: 'flash', family: 'deepseek', upstreamModelId: suggestedModel, modelFormat: 'anthropic' },
          { id: otherSuggestedVersion, name: 'flash', family: 'deepseek', upstreamModelId: otherSuggestedVersion, modelFormat: 'anthropic' },
          { id: expensiveModel, name: expensiveModel, upstreamModelId: expensiveModel, modelFormat: 'anthropic',
            pricing: { input: 4, output: 4, source: 'fixture', observedAt: fetchedAt } },
          { id: 'fixture-unrelated-unknown', name: 'Other family', family: 'other', upstreamModelId: 'fixture-unrelated-upstream', modelFormat: 'anthropic' },
        ] } }],
    },
    {
      id: customId, templateId: 'custom', name: 'OpenCode Go', enabled: true,
      authRef: `none:${customId}`, authType: 'none', api: { url: 'https://custom-fixture.invalid/v1' }, addedAt: fetchedAt,
      accounts: [{ id: 'custom-account', authRef: 'keyring:custom-account', enabled: true, modelsCache: { fetchedAt, models: [
        { id: lookalikeModel, name: 'flash', family: 'deepseek', upstreamModelId: lookalikeModel, modelFormat: 'anthropic' },
      ] } }],
    },
  ];
  saveRegistry({ schemaVersion: 1, providers });
  harness.fetchFreshProviderCatalog.mockResolvedValue({
    providers: [], unavailable: [], refresh: { refreshed: providers.map(provider => ({
      id: provider.id, ok: true, skipped: false, modelSource,
      accountResults: provider.accounts?.map(account => ({ accountId: account.id, ok: true })),
    })) },
  });
  harness.answers = ['refresh', 'router', '0', 'done'];

  const { runSwitchyardMenu } = await import('../src/cli-switchyard-menu.js');
  await expect(runSwitchyardMenu()).resolves.toBe(0);

  const choices = harness.selections[2]!.options;
  expect(choices.map(choice => choice.label)).toEqual([
    `${routerId}/${selectedModel}`,
    `${routerId}/${expensiveModel}`,
    `${customId}/${lookalikeModel}`,
    `${routerId}/${suggestedModel}`,
    `${routerId}/${otherSuggestedVersion}`,
    `${routerId}/fixture-unrelated-unknown`,
  ]);
  expect(harness.routingAtSelection[2]).toMatchObject({ enabled: false, subscriptionPreference: 'auto' });
  expect(loadPreferences().routing?.cheapFloor).toEqual({ providerId: routerId, modelId: selectedModel });
  expect(harness.fetchFreshProviderCatalog).toHaveBeenCalledTimes(2);
  expect(harness.fetchFreshProviderCatalog).toHaveBeenNthCalledWith(1, { agent: 'claude' });
  expect(harness.fetchFreshProviderCatalog).toHaveBeenNthCalledWith(2, { agent: 'claude' });
  expect(harness.readNativeAuth).toHaveBeenCalledTimes(1);
  expect(harness.fetchNativeModels).not.toHaveBeenCalled();
  expect(harness.resolveProviderAccountAuth.mock.calls.map(([providerId, account]) => [providerId, account.id]))
    .toEqual([[routerId, 'router-account'], [customId, 'custom-account'], [routerId, 'router-account']]);
  expect(harness.resolveProviderAuth).not.toHaveBeenCalled();
  expect(prompts.select).toHaveBeenCalledTimes(4);
  expect(choices[2]!.hint).toBe(choices[5]!.hint);
  expect(choices[3]!.hint === choices[5]!.hint).toBe(hintsEqual);
  expect(choices[4]!.hint === choices[5]!.hint).toBe(hintsEqual);
  expect(prompts.log.info).toHaveBeenCalledTimes(unresolvedInfoCount);
});

it.each([{ category: 'summarization' }])('suggests opaque models by projected family metadata for Antigravity ($category)', async ({ category }) => {
  const testHome = process.env['LEVERFRAME_TEST_HOME'];
  expect(testHome).toBeTruthy();
  const appPath = relative(testHome!, getAppHome());
  expect(appPath === '' || (!appPath.startsWith('..') && !isAbsolute(appPath))).toBe(true);
  const registryPath = relative(testHome!, getProvidersPath());
  expect(!registryPath.startsWith('..') && !isAbsolute(registryPath)).toBe(true);

  const fetchedAt = '2026-10-01T00:00:00.000Z';
  const templateProviderId = 'fixture-z-template-provider';
  const customProviderId = 'fixture-a-custom-provider';
  const templateModelId = 'opaque-template-model';
  const customModelId = 'opaque-custom-model';
  const providers: RegistryProvider[] = [
    {
      id: customProviderId, templateId: 'custom', name: 'Antigravity', enabled: true,
      authRef: `none:${customProviderId}`, authType: 'none', api: { url: 'https://custom-template.invalid/v1' }, addedAt: fetchedAt,
      accounts: [{ id: 'custom-account', authRef: 'keyring:custom-account', enabled: true, modelsCache: { fetchedAt, models: [
        { id: customModelId, name: 'Gemini Flash', family: 'gemini', upstreamModelId: customModelId, modelFormat: 'openai',
          npm: '@ai-sdk/anthropic', supportedParameters: ['tools'], contextWindow: 8_192, outputTokenLimit: 2_048 },
        { id: 'opaque-unrelated-model', name: 'Other model', family: 'other', upstreamModelId: 'opaque-unrelated-upstream', modelFormat: 'openai' },
      ] } }],
    },
    {
      id: templateProviderId, templateId: 'antigravity', name: 'Generic template provider', enabled: true,
      authRef: `none:${templateProviderId}`, authType: 'none', api: { url: 'https://template-provider.invalid/v1' }, addedAt: fetchedAt,
      accounts: [{ id: 'template-account', authRef: 'keyring:template-account', enabled: true, modelsCache: { fetchedAt, models: [
        { id: templateModelId, name: 'Gemini Flash', family: 'gemini', upstreamModelId: templateModelId, modelFormat: 'openai',
          npm: '@ai-sdk/anthropic', supportedParameters: ['tools'], contextWindow: 8_192, outputTokenLimit: 2_048 },
      ] } }],
    },
  ];
  accountCredentialFixture.values = {
    [`${customProviderId}/custom-account`]: 'synthetic-custom-auth',
    [`${templateProviderId}/template-account`]: 'synthetic-template-auth',
  };
  saveRegistry({ schemaVersion: 1, providers });
  harness.fetchFreshProviderCatalog.mockResolvedValue({
    providers: [], unavailable: [], refresh: { refreshed: providers.map(provider => ({
      id: provider.id, ok: true, skipped: false, modelSource: 'live',
      accountResults: provider.accounts?.map(account => ({ accountId: account.id, ok: true })),
    })) },
  });
  harness.answers = ['refresh', 'category', category, '2', 'done'];

  const { runSwitchyardMenu } = await import('../src/cli-switchyard-menu.js');
  await expect(runSwitchyardMenu()).resolves.toBe(0);

  const choices = harness.selections[3]!.options;
  expect(choices.map(choice => choice.label)).toEqual([
    `${customProviderId}/${customModelId}`,
    `${customProviderId}/opaque-unrelated-model`,
    `${templateProviderId}/${templateModelId}`,
  ]);
  expect(choices[0]!.hint).toBe(choices[1]!.hint);
  expect(choices[1]!.hint).not.toBe(choices[2]!.hint);
  expect(loadPreferences().routing?.categories?.[category]).toMatchObject({
    target: { providerId: templateProviderId, modelId: templateModelId },
  });
  expect(harness.routingAtSelection[3]).toMatchObject({ enabled: false, subscriptionPreference: 'auto' });
  expect(prompts.select).toHaveBeenCalledTimes(5);
  expect(prompts.log.info).not.toHaveBeenCalled();
  expect(harness.fetchFreshProviderCatalog).toHaveBeenCalledTimes(2);
  expect(harness.fetchFreshProviderCatalog).toHaveBeenNthCalledWith(1, { agent: 'claude' });
  expect(harness.fetchFreshProviderCatalog).toHaveBeenNthCalledWith(2, { agent: 'claude' });
  expect(harness.readNativeAuth).toHaveBeenCalledTimes(1);
  expect(harness.fetchNativeModels).not.toHaveBeenCalled();
  expect(harness.resolveProviderAccountAuth.mock.calls.map(([providerId, account]) => [providerId, account.id]).sort())
    .toEqual([[customProviderId, 'custom-account'], [templateProviderId, 'template-account'], [templateProviderId, 'template-account']].sort());
  expect(harness.resolveProviderAuth).not.toHaveBeenCalled();
});
