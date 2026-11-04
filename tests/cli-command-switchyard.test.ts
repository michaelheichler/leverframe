import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { isAbsolute, relative, sep, join } from 'node:path';
import { buildRoutingCatalog } from '../src/model-routing-catalog.js';
import { loadPreferences, savePreferences } from '../src/config.js';
import { getAppHome, getConfigPath, resetLegacyMigrationForTests } from '../src/paths.js';
import { loadRegistry, saveRegistry } from '../src/registry/io.js';
import { loadPricingCache } from '../src/registry/pricing.js';
import { accountModelsCache } from '../src/registry/account-cache.js';
import { decideRouting } from '../src/routing-policy.js';
import { cachedModel, input, observation, provider } from './model-routing-fixtures.js';

vi.mock('../src/provider-catalog.js', () => ({ fetchFreshProviderCatalog: vi.fn() }));
vi.mock('../src/routing-runtime.js', () => ({ buildRoutingRuntime: vi.fn() }));
vi.mock('../src/claude-installation.js', () => ({ resolveClaudeInstallation: vi.fn() }));
vi.mock('../src/patcher.js', () => ({ runLaunchPatchCheck: vi.fn() }));
vi.mock('../src/patch-reconcile.js', () => ({ checkResolvedPatchState: vi.fn() }));

let tempHome: string | undefined;
let previousHome: string | undefined;
let previousProfile: string | undefined;
let previousLeverframeHome: string | undefined;

function buildSwitchyardFixtureCatalog(providers: ReturnType<typeof loadRegistry>['providers'], credentialsAvailable = true) {
  return buildRoutingCatalog(input(providers, {
    pricing: loadPricingCache(),
    credentials: providers.flatMap(item => item.accounts?.length
      ? item.accounts.filter(account => account.enabled).map(account => ({
        ...observation(item.id, item.authType === 'oauth' ? 'oauth' : item.authType === 'none' ? 'none' : 'api_key'),
        accountId: account.id, available: credentialsAvailable,
      }))
      : [{ ...observation(item.id, item.authType === 'oauth' ? 'oauth' : item.authType === 'none' ? 'none' : 'api_key'),
        available: credentialsAvailable }]),
    discovery: providers.flatMap(item => item.accounts?.length
      ? item.accounts.filter(account => account.enabled).flatMap(account => {
        const cache = accountModelsCache(item, account);
        return cache ? [{ providerId: item.id, accountId: account.id, status: 'live' as const, cacheFetchedAt: cache.fetchedAt }] : [];
      })
      : item.modelsCache
        ? [{ providerId: item.id, status: 'live' as const, cacheFetchedAt: item.modelsCache.fetchedAt }]
        : []),
  }));
}

beforeEach(() => {
  const testRoot = process.env['LEVERFRAME_TEST_HOME'];
  if (!testRoot) throw new Error('The isolated test home is required.');
  mkdirSync(testRoot, { recursive: true });
  tempHome = mkdtempSync(join(testRoot, 'switchyard-'));
  previousHome = process.env['HOME'];
  previousProfile = process.env['USERPROFILE'];
  previousLeverframeHome = process.env['LEVERFRAME_HOME'];
  process.env['HOME'] = tempHome;
  process.env['USERPROFILE'] = join(tempHome, 'profile');
  process.env['LEVERFRAME_HOME'] = join(tempHome, 'app');
  resetLegacyMigrationForTests();
  const appHome = getAppHome();
  const appPath = relative(tempHome, appHome);
  expect(appPath === '' || (!appPath.startsWith(`..${sep}`) && appPath !== '..' && !isAbsolute(appPath))).toBe(true);
  expect(relative(appHome, getConfigPath())).toBe('config.json');
});

afterEach(() => {
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = undefined;
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  if (previousProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = previousProfile;
  if (previousLeverframeHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousLeverframeHome;
  resetLegacyMigrationForTests();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

  it('applies an update to current routing preferences and keeps other preferences', async () => {
    const model = { providerId: 'fixture-provider', modelId: 'fixture-model' };
    savePreferences({ lastProvider: model.providerId, lastModel: model.modelId });
    const config = await import('../src/config.js');
    const update = (config as Record<string, unknown>)['updateRoutingPreferences'] as (
      change: (current: Record<string, unknown>) => Record<string, unknown>,
    ) => Record<string, unknown>;

    const saved = update(current => ({
      ...current,
      enabled: false,
      cheapFallback: model,
      categories: { ...current['categories'] as object, implementation: { target: model } },
    }));

    expect(saved).toMatchObject({ enabled: false, cheapFallback: model, categories: { implementation: { target: model } } });
    expect(loadPreferences()).toMatchObject({ lastProvider: model.providerId, lastModel: model.modelId });
  });

  it('leaves saved routing preferences intact when an update is invalid', async () => {
    const model = { providerId: 'fixture-provider', modelId: 'fixture-model' };
    savePreferences({ routing: { enabled: false, cheapFallback: model } });
    const before = loadPreferences().routing;
    const config = await import('../src/config.js');
    const update = (config as Record<string, unknown>)['updateRoutingPreferences'] as (
      change: (current: Record<string, unknown>) => Record<string, unknown>,
    ) => Record<string, unknown>;
    expect(() => update(current => ({ ...current, enabled: true, cheapFallback: undefined })))
      .toThrow(expect.objectContaining({ name: 'Error' }));

    expect(loadPreferences().routing).toEqual(before);
  });

  it('returns success when users ask for routing status without discovery or setup', async () => {
    const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');
    const discovery = await import('../src/provider-catalog.js');
    const runtime = await import('../src/routing-runtime.js');
    const installation = await import('../src/claude-installation.js');
    const patcher = await import('../src/patcher.js');
    const patch = await import('../src/patch-reconcile.js');

    await expect(runSwitchyardCommand(['status'])).resolves.toBe(0);
    expect(discovery.fetchFreshProviderCatalog).not.toHaveBeenCalled();
    expect(runtime.buildRoutingRuntime).not.toHaveBeenCalled();
    expect(installation.resolveClaudeInstallation).not.toHaveBeenCalled();
    expect(patcher.runLaunchPatchCheck).not.toHaveBeenCalled();
    expect(patch.checkResolvedPatchState).not.toHaveBeenCalled();
  });

  it('sorts models without sourced rates after priced models', async () => {
    const priced = {
      ...cachedModel('switchyard-priced-model'),
      pricing: { input: 2, output: 5, source: 'fixture pricing', observedAt: '2026-10-01T00:00:00.000Z' },
    };
    const unknown = cachedModel('switchyard-unpriced-model');
    const registered = provider({
      id: 'switchyard-fixture-provider',
      templateId: 'custom',
      modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [unknown, priced] },
    });
    saveRegistry({ schemaVersion: 1, providers: [registered] });
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

    await expect(runSwitchyardCommand(['costs'])).resolves.toBe(0);

    const lines = output.mock.calls.map(([line]) => String(line));
    const pricedIndex = lines.findIndex(line => line.includes('switchyard-fixture-provider/switchyard-priced-model'));
    const unknownIndex = lines.findIndex(line => line.includes('switchyard-fixture-provider/switchyard-unpriced-model'));
    expect(pricedIndex).toBeGreaterThanOrEqual(0);
    expect(unknownIndex).toBeGreaterThan(pricedIndex);
  });

it('keeps authentication and billing evidence separate without pricing subscription quotas', async () => {
  const fetchedAt = '2026-10-01T00:00:00.000Z';
  const metered = { kind: 'metered' as const, source: 'usage record', observedAt: fetchedAt };
  const subscription = { kind: 'subscription' as const, source: 'plan record', observedAt: fetchedAt };
  const apiProvider = provider({
    id: 'switchyard-api-only', templateId: 'custom', authType: 'api', billing: metered,
    modelsCache: { fetchedAt, models: [{ ...cachedModel('api-only-model'), pricing: { input: 1, output: 2, source: 'rate record' } }] },
  });
  const subscriptionProvider = provider({
    id: 'switchyard-subscription-only', templateId: 'custom', authType: 'api', billing: subscription,
    modelsCache: { fetchedAt, models: [cachedModel('subscription-only-model')] },
  });
  const mixedProvider = provider({
    id: 'switchyard-mixed-billing', templateId: 'custom', authType: 'api',
    accounts: [
      { id: 'quota-account-a', authRef: 'keyring:quota-a', enabled: true, billing: subscription,
        modelsCache: { fetchedAt, models: [{ ...cachedModel('quota-shared-model'), subscriptionQuota: { remainingFraction: 0.1 } }] } },
      { id: 'quota-account-b', authRef: 'keyring:quota-b', enabled: true, billing: metered,
        modelsCache: { fetchedAt, models: [{ ...cachedModel('quota-shared-model'), subscriptionQuota: { remainingFraction: 0.9 } }] } },
    ],
  });
  const unknownProvider = provider({
    id: 'switchyard-unknown-billing', templateId: 'custom', authType: 'oauth',
    modelsCache: { fetchedAt, models: [cachedModel('unknown-billing-model')] },
  });
  saveRegistry({ schemaVersion: 1, providers: [apiProvider, subscriptionProvider, mixedProvider, unknownProvider] });
  const catalog = buildSwitchyardFixtureCatalog(loadRegistry().providers);
  const rows = catalog.models.map(model => ({
    modelId: model.ref.modelId,
    accountId: model.accountId ?? 'default',
    auth: model.credential.kind,
    billing: model.billing.kind,
    estimate: model.estimate.kind,
  }));
  expect(rows).toEqual(expect.arrayContaining([
    { modelId: 'api-only-model', accountId: 'default', auth: 'api_key', billing: 'metered', estimate: 'known' },
    { modelId: 'subscription-only-model', accountId: 'default', auth: 'api_key', billing: 'subscription', estimate: 'unknown' },
    { modelId: 'quota-shared-model', accountId: 'quota-account-a', auth: 'api_key', billing: 'subscription', estimate: 'unknown' },
    { modelId: 'quota-shared-model', accountId: 'quota-account-b', auth: 'api_key', billing: 'metered', estimate: 'unknown' },
    { modelId: 'unknown-billing-model', accountId: 'default', auth: 'oauth', billing: 'unknown', estimate: 'unknown' },
  ]));
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

  await expect(runSwitchyardCommand(['costs'])).resolves.toBe(0);

  const lines = output.mock.calls.map(([line]) => String(line));
  const firstQuotaAccount = lines.findIndex(line => line.includes('quota-account-a'));
  const secondQuotaAccount = lines.findIndex(line => line.includes('quota-account-b'));
  expect(firstQuotaAccount).toBeGreaterThanOrEqual(0);
  expect(secondQuotaAccount).toBeGreaterThan(firstQuotaAccount);
});

  it('keeps costs read-only and independent from provider discovery', async () => {
    const discovery = await import('../src/provider-catalog.js');
    const runtime = await import('../src/routing-runtime.js');
    const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

    await expect(runSwitchyardCommand(['costs'])).resolves.toBe(0);

    expect(discovery.fetchFreshProviderCatalog).not.toHaveBeenCalled();
    expect(runtime.buildRoutingRuntime).not.toHaveBeenCalled();
  });

it('refreshes an empty cache and reports newly discovered provider choices', async () => {
  const providerId = 'switchyard-fresh-provider';
  const cachedProviderId = 'switchyard-primary-cache-provider';
  const inheritedRef = { providerId: cachedProviderId, modelId: 'switchyard-inherited-model' };
  const primaryCacheProvider = provider({
    id: cachedProviderId,
    templateId: 'custom',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel(inheritedRef.modelId)] },
    accounts: [{ id: 'primary-account', authRef: 'keyring:provider:switchyard-primary-cache-provider', enabled: true }],
  });
  saveRegistry({
    schemaVersion: 1,
    providers: [
      provider({ id: providerId, templateId: 'custom', modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [] } }),
      primaryCacheProvider,
    ],
  });
  const discovery = await import('../src/provider-catalog.js');
  const runtime = await import('../src/routing-runtime.js');
  vi.mocked(discovery.fetchFreshProviderCatalog).mockResolvedValue({
    providers: [{ id: providerId, name: providerId, models: [{ id: 'switchyard-new-choice', name: 'new choice' }] }],
    unavailable: [],
    refresh: { refreshed: [
      { id: providerId, ok: true, skipped: false, modelSource: 'live' },
      { id: cachedProviderId, ok: true, skipped: false, modelSource: 'live',
        accountResults: [{ accountId: 'primary-account', ok: true }] },
    ] },
  } as never);
  vi.mocked(runtime.buildRoutingRuntime).mockResolvedValue(buildSwitchyardFixtureCatalog(loadRegistry().providers));
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

  await expect(runSwitchyardCommand(['refresh'])).resolves.toBe(0);

  expect(discovery.fetchFreshProviderCatalog).toHaveBeenCalledTimes(1);
  expect(runtime.buildRoutingRuntime).toHaveBeenCalledTimes(1);
  expect(runtime.buildRoutingRuntime).toHaveBeenCalledWith(expect.objectContaining({
    config: expect.objectContaining({ pool: expect.arrayContaining([inheritedRef]) }),
  }));
  expect(output.mock.calls.map(([line]) => String(line)).join('\n')).toContain(providerId);
});

  it('disables new routing while preserving other saved preferences', async () => {
    const ref = { providerId: 'switchyard-fixture-provider', modelId: 'switchyard-fixture-model' };
    savePreferences({
      routing: {
        enabled: true,
        recoveryEnabled: true,
        cheapFloor: ref,
        cheapFallback: ref,
        categories: { implementation: { target: ref, effort: 'high' } },
      },
      lastProvider: ref.providerId,
      lastModel: ref.modelId,
      accountPoolBalancing: false,
    });
    const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

    await expect(runSwitchyardCommand(['disable'])).resolves.toBe(0);

    expect(loadPreferences()).toMatchObject({
      routing: { enabled: false, recoveryEnabled: true, cheapFloor: ref, cheapFallback: ref,
        categories: { implementation: { target: ref, effort: 'high' } } },
      lastProvider: ref.providerId,
      lastModel: ref.modelId,
      accountPoolBalancing: false,
    });
  });

it.each([
  { action: 'router', field: 'cheapFloor' },
  { action: 'router-fallback', field: 'cheapFallback' },
])('saves the $action target in its routing slot', async ({ action, field }) => {
  const providerId = 'switchyard-fixture-provider';
  const target = { providerId, modelId: 'switchyard-target-model' };
  const registered = provider({
    id: providerId,
    templateId: 'custom',
    modelsCache: {
      fetchedAt: '2026-10-01T00:00:00.000Z',
      models: [{ ...cachedModel(target.modelId), pricing: { input: 1, output: 2, source: 'fixture' } }],
    },
  });
  saveRegistry({ schemaVersion: 1, providers: [registered] });
  const discovery = await import('../src/provider-catalog.js');
  const runtime = await import('../src/routing-runtime.js');
  vi.mocked(discovery.fetchFreshProviderCatalog).mockResolvedValue({
    providers: [], unavailable: [], refresh: { refreshed: [{ id: providerId, ok: true, skipped: false, modelSource: 'live' }] },
  } as never);
  vi.mocked(runtime.buildRoutingRuntime).mockResolvedValue(buildSwitchyardFixtureCatalog(loadRegistry().providers));
  const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

  await expect(runSwitchyardCommand(['set', action, '--provider', providerId, '--model', target.modelId])).resolves.toBe(0);

  expect(loadPreferences().routing).toMatchObject({ [field]: target });
});

it('saves a category target with its requested effort', async () => {
  const providerId = 'switchyard-fixture-provider';
  const target = { providerId, modelId: 'switchyard-category-model' };
  const fallback = { providerId, modelId: 'switchyard-category-fallback' };
  const registered = provider({
    id: providerId,
    templateId: 'custom',
    modelsCache: {
      fetchedAt: '2026-10-01T00:00:00.000Z',
      models: [
        { ...cachedModel(target.modelId), supportedReasoningEfforts: ['high', 'medium'], supportedParameters: ['tools'], contextWindow: 8_192, outputTokenLimit: 2_048 },
        { ...cachedModel(fallback.modelId), supportedReasoningEfforts: ['high'] },
      ],
    },
  });
  saveRegistry({ schemaVersion: 1, providers: [registered] });
  savePreferences({ routing: { enabled: false, categories: { implementation: { fallbacks: [fallback] } } } });
  const discovery = await import('../src/provider-catalog.js');
  const runtime = await import('../src/routing-runtime.js');
  vi.mocked(discovery.fetchFreshProviderCatalog).mockResolvedValue({
    providers: [], unavailable: [], refresh: { refreshed: [{ id: providerId, ok: true, skipped: false, modelSource: 'live' }] },
  } as never);
  vi.mocked(runtime.buildRoutingRuntime).mockResolvedValue(buildSwitchyardFixtureCatalog(loadRegistry().providers));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

  await expect(runSwitchyardCommand(['set', 'implementation', '--provider', providerId, '--model', target.modelId, '--effort', 'high']))
    .resolves.toBe(0);

  expect(loadPreferences().routing?.categories?.['implementation']).toMatchObject({ target, effort: 'high' });
  expect(warning).not.toHaveBeenCalled();
});

it('stores two deep research targets with their own supported efforts', async () => {
  const providerId = 'switchyard-fixture-provider';
  const first = { providerId, modelId: 'switchyard-research-first' };
  const second = { providerId, modelId: 'switchyard-research-second' };
  const registered = provider({
    id: providerId,
    templateId: 'custom',
    modelsCache: {
      fetchedAt: '2026-10-01T00:00:00.000Z',
      models: [
        { ...cachedModel(first.modelId), supportedReasoningEfforts: ['low'] },
        { ...cachedModel(second.modelId), supportedReasoningEfforts: ['high'] },
      ],
    },
  });
  saveRegistry({ schemaVersion: 1, providers: [registered] });
  const discovery = await import('../src/provider-catalog.js');
  const runtime = await import('../src/routing-runtime.js');
  vi.mocked(discovery.fetchFreshProviderCatalog).mockResolvedValue({
    providers: [], unavailable: [], refresh: { refreshed: [{ id: providerId, ok: true, skipped: false, modelSource: 'live' }] },
  } as never);
  vi.mocked(runtime.buildRoutingRuntime).mockResolvedValue(buildSwitchyardFixtureCatalog(loadRegistry().providers));
  const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

  await expect(runSwitchyardCommand([
    'set', 'deep_research', '--provider', providerId, '--model', first.modelId, '--effort', 'low',
    '--provider', providerId, '--model', second.modelId, '--effort', 'high',
  ])).resolves.toBe(0);

  expect(loadPreferences().routing?.categories?.['deep_research']?.alternatingTargets).toEqual([
    { ...first, effort: 'low' },
    { ...second, effort: 'high' },
  ]);
});

it('warns and saves a discovered target when credentials are unavailable', async () => {
  const providerId = 'switchyard-fixture-provider';
  const target = { providerId, modelId: 'switchyard-unavailable-model' };
  const registered = provider({
    id: providerId,
    templateId: 'custom',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel(target.modelId)] },
  });
  saveRegistry({ schemaVersion: 1, providers: [registered] });
  const discovery = await import('../src/provider-catalog.js');
  const runtime = await import('../src/routing-runtime.js');
  vi.mocked(discovery.fetchFreshProviderCatalog).mockResolvedValue({
    providers: [], unavailable: [], refresh: { refreshed: [{ id: providerId, ok: true, skipped: false, modelSource: 'live' }] },
  } as never);
  vi.mocked(runtime.buildRoutingRuntime).mockResolvedValue(buildSwitchyardFixtureCatalog(loadRegistry().providers, false));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

  await expect(runSwitchyardCommand(['set', 'implementation', '--provider', providerId, '--model', target.modelId]))
    .resolves.toBe(0);

  expect(warning).toHaveBeenCalledTimes(2);
  expect(String(warning.mock.calls[0]?.[0])).toContain(target.modelId);
  expect(loadPreferences().routing?.categories?.['implementation']).toMatchObject({ target });
});

it('rejects an unresolved explicit target without replacing saved routing settings', async () => {
  const providerId = 'switchyard-fixture-provider';
  const original = { providerId, modelId: 'switchyard-existing-model' };
  const registered = provider({
    id: providerId,
    templateId: 'custom',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel(original.modelId)] },
  });
  saveRegistry({ schemaVersion: 1, providers: [registered] });
  savePreferences({ routing: { enabled: false, cheapFallback: original } });
  const before = loadPreferences().routing;
  const discovery = await import('../src/provider-catalog.js');
  const runtime = await import('../src/routing-runtime.js');
  vi.mocked(discovery.fetchFreshProviderCatalog).mockResolvedValue({
    providers: [], unavailable: [], refresh: { refreshed: [{ id: providerId, ok: true, skipped: false, modelSource: 'live' }] },
  } as never);
  vi.mocked(runtime.buildRoutingRuntime).mockResolvedValue(buildSwitchyardFixtureCatalog(loadRegistry().providers));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

  await expect(runSwitchyardCommand([
    'set', 'implementation', '--provider', providerId, '--model', 'switchyard-unresolved-model',
  ])).resolves.toBe(1);

  expect(loadPreferences().routing).toEqual(before);
});

it('rejects a category effort the discovered model does not support', async () => {
  const providerId = 'switchyard-fixture-provider';
  const target = { providerId, modelId: 'switchyard-effort-model' };
  const registered = provider({
    id: providerId,
    templateId: 'custom',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel(target.modelId)] },
  });
  saveRegistry({ schemaVersion: 1, providers: [registered] });
  const discovery = await import('../src/provider-catalog.js');
  const runtime = await import('../src/routing-runtime.js');
  vi.mocked(discovery.fetchFreshProviderCatalog).mockResolvedValue({
    providers: [], unavailable: [], refresh: { refreshed: [{ id: providerId, ok: true, skipped: false, modelSource: 'live' }] },
  } as never);
  vi.mocked(runtime.buildRoutingRuntime).mockResolvedValue(buildSwitchyardFixtureCatalog(loadRegistry().providers));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

  await expect(runSwitchyardCommand([
    'set', 'implementation', '--provider', providerId, '--model', target.modelId, '--effort', 'high',
  ])).resolves.toBe(1);

  expect(loadPreferences().routing?.categories?.['implementation']).toBeUndefined();
});

it('merges a concurrent category update into the latest routing preferences', async () => {
  const providerId = 'switchyard-fixture-provider';
  const implementation = { providerId, modelId: 'switchyard-implementation-model' };
  const research = { providerId, modelId: 'switchyard-concurrent-research-model' };
  const registered = provider({
    id: providerId,
    templateId: 'custom',
    modelsCache: {
      fetchedAt: '2026-10-01T00:00:00.000Z',
      models: [cachedModel(implementation.modelId), cachedModel(research.modelId)],
    },
  });
  saveRegistry({ schemaVersion: 1, providers: [registered] });
  savePreferences({ lastModel: 'kept-model' });
  const discovery = await import('../src/provider-catalog.js');
  const runtime = await import('../src/routing-runtime.js');
  vi.mocked(discovery.fetchFreshProviderCatalog).mockResolvedValue({
    providers: [], unavailable: [], refresh: { refreshed: [{ id: providerId, ok: true, skipped: false, modelSource: 'live' }] },
  } as never);
  vi.mocked(runtime.buildRoutingRuntime).mockImplementation(async () => {
    const { updateRoutingPreferences } = await import('../src/config.js');
    updateRoutingPreferences(current => ({ ...current, categories: { concurrent: { target: research } } }));
    return buildSwitchyardFixtureCatalog(loadRegistry().providers);
  });
  const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

  await expect(runSwitchyardCommand([
    'set', 'implementation', '--provider', providerId, '--model', implementation.modelId,
  ])).resolves.toBe(0);

  expect(loadPreferences().routing?.categories).toMatchObject({
    concurrent: { target: research },
    implementation: { target: implementation },
  });
  expect(loadPreferences().lastModel).toBe('kept-model');
});

it('warns that a category cannot start when its target is unavailable despite an eligible fallback', async () => {
  const targetProviderId = 'switchyard-unavailable-provider';
  const fallbackProviderId = 'switchyard-available-provider';
  const target = { providerId: targetProviderId, modelId: 'switchyard-unavailable-target' };
  const fallback = { providerId: fallbackProviderId, modelId: 'switchyard-available-fallback' };
  const fetchedAt = '2026-10-01T00:00:00.000Z';
  const targetProvider = provider({
    id: targetProviderId,
    templateId: 'custom',
    accounts: [{ id: 'target-account', authRef: 'keyring:target-account', enabled: true,
      modelsCache: { fetchedAt, models: [cachedModel(target.modelId)] } }],
  });
  const fallbackProvider = provider({
    id: fallbackProviderId,
    templateId: 'custom',
    accounts: [{ id: 'fallback-account', authRef: 'keyring:fallback-account', enabled: true,
      modelsCache: { fetchedAt, models: [cachedModel(fallback.modelId)] } }],
  });
  saveRegistry({ schemaVersion: 1, providers: [targetProvider, fallbackProvider] });
  savePreferences({ routing: { enabled: false, categories: { implementation: { fallbacks: [fallback] } } } });
  const registry = loadRegistry();
  const catalog = buildRoutingCatalog(input(registry.providers, {
    pricing: loadPricingCache(),
    credentials: [
      { providerId: targetProviderId, accountId: 'target-account', kind: 'api_key', available: false },
      { providerId: fallbackProviderId, accountId: 'fallback-account', kind: 'api_key', available: true },
    ],
    discovery: [
      { providerId: targetProviderId, accountId: 'target-account', status: 'live', cacheFetchedAt: fetchedAt },
      { providerId: fallbackProviderId, accountId: 'fallback-account', status: 'live', cacheFetchedAt: fetchedAt },
    ],
  }));
  const discovery = await import('../src/provider-catalog.js');
  const runtime = await import('../src/routing-runtime.js');
  vi.mocked(discovery.fetchFreshProviderCatalog).mockResolvedValue({
    providers: [], unavailable: [], refresh: { refreshed: [
      { id: targetProviderId, ok: true, skipped: false, modelSource: 'live' },
      { id: fallbackProviderId, ok: true, skipped: false, modelSource: 'live' },
    ] },
  } as never);
  vi.mocked(runtime.buildRoutingRuntime).mockResolvedValue(catalog);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

  await expect(runSwitchyardCommand([
    'set', 'implementation', '--provider', target.providerId, '--model', target.modelId,
  ])).resolves.toBe(0);

  const warnings = warning.mock.calls.map(([message]) => String(message));
  expect(warnings).toHaveLength(2);
  expect(warnings.join('\n')).toContain(target.modelId);
  expect(warnings.join('\n')).toContain('implementation');
});

it('reports each unavailable deep research arm separately', async () => {
  const providerId = 'switchyard-research-provider';
  const first = { providerId, modelId: 'switchyard-research-first' };
  const second = { providerId, modelId: 'switchyard-research-second' };
  const registered = provider({
    id: providerId,
    templateId: 'custom',
    modelsCache: {
      fetchedAt: '2026-10-01T00:00:00.000Z',
      models: [
        { ...cachedModel(first.modelId), supportedReasoningEfforts: ['low'] },
        { ...cachedModel(second.modelId), supportedReasoningEfforts: ['high'] },
      ],
    },
  });
  saveRegistry({ schemaVersion: 1, providers: [registered] });
  const discovery = await import('../src/provider-catalog.js');
  const runtime = await import('../src/routing-runtime.js');
  vi.mocked(discovery.fetchFreshProviderCatalog).mockResolvedValue({
    providers: [], unavailable: [], refresh: { refreshed: [{ id: providerId, ok: true, skipped: false, modelSource: 'live' }] },
  } as never);
  vi.mocked(runtime.buildRoutingRuntime).mockResolvedValue(buildSwitchyardFixtureCatalog(loadRegistry().providers, false));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

  await expect(runSwitchyardCommand([
    'set', 'deep_research', '--provider', providerId, '--model', first.modelId, '--effort', 'low',
    '--provider', providerId, '--model', second.modelId, '--effort', 'high',
  ])).resolves.toBe(0);

  const warnings = warning.mock.calls.map(([message]) => String(message));
  expect(warnings).toHaveLength(4);
  expect(warnings.join('\n')).toContain(first.modelId);
  expect(warnings.join('\n')).toContain(second.modelId);
});

it('enables routing only after an eligible front target and current patch state are confirmed', async () => {
  const providerId = 'switchyard-fixture-provider';
  const target = { providerId, modelId: 'switchyard-front-model' };
  const registered = provider({
    id: providerId,
    templateId: 'custom',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel(target.modelId)] },
  });
  saveRegistry({ schemaVersion: 1, providers: [registered] });
  savePreferences({
    routing: { enabled: false, cheapFallback: target },
    modelAliases: [{ name: 'personal-router-alias', ...target }],
  });
  const catalog = buildSwitchyardFixtureCatalog(loadRegistry().providers);
  expect(decideRouting({ config: { enabled: true, cheapFallback: target }, catalog, role: 'router', workload: { input: 1, output: 1 } }).target)
    .toEqual(target);
  const discovery = await import('../src/provider-catalog.js');
  const runtime = await import('../src/routing-runtime.js');
  const installation = await import('../src/claude-installation.js');
  const patcher = await import('../src/patcher.js');
  const patch = await import('../src/patch-reconcile.js');
  const patchState = await import('../src/patch-state.js');
  vi.mocked(discovery.fetchFreshProviderCatalog).mockResolvedValue({
    providers: [], unavailable: [], refresh: { refreshed: [{ id: providerId, ok: true, skipped: false, modelSource: 'live' }] },
  } as never);
  vi.mocked(runtime.buildRoutingRuntime).mockResolvedValue(catalog);
  vi.mocked(installation.resolveClaudeInstallation).mockReturnValue({} as never);
  vi.mocked(patcher.runLaunchPatchCheck).mockResolvedValue(undefined);
  vi.mocked(patch.checkResolvedPatchState).mockResolvedValue({
    state: 'patched',
    manifest: { configHash: 'current-config', transformVersion: patchState.currentTransformVersion() },
    configHash: 'current-config',
  } as never);
  const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

  await expect(runSwitchyardCommand(['enable'])).resolves.toBe(0);

  expect(loadPreferences().routing).toMatchObject({ enabled: true, cheapFallback: target });
  expect(loadPreferences().routing?.cheapFloor).toBeUndefined();
  expect(loadPreferences().modelAliases).toEqual([{ name: 'personal-router-alias', ...target }]);
});

it.each([
  { condition: 'missing installation', installation: null, manifestHash: 'current-config', desiredHash: 'current-config' },
  { condition: 'stale manifest hash', installation: {}, manifestHash: 'saved-config', desiredHash: 'current-config' },
])('keeps routing disabled when enable preparation finds a $condition', async ({ installation: installed, manifestHash, desiredHash }) => {
  const providerId = 'switchyard-fixture-provider';
  const target = { providerId, modelId: 'switchyard-front-model' };
  const registered = provider({
    id: providerId,
    templateId: 'custom',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel(target.modelId)] },
  });
  saveRegistry({ schemaVersion: 1, providers: [registered] });
  savePreferences({ routing: { enabled: false, cheapFallback: target } });
  const discovery = await import('../src/provider-catalog.js');
  const runtime = await import('../src/routing-runtime.js');
  const installation = await import('../src/claude-installation.js');
  const patcher = await import('../src/patcher.js');
  const patch = await import('../src/patch-reconcile.js');
  const patchState = await import('../src/patch-state.js');
  vi.mocked(discovery.fetchFreshProviderCatalog).mockResolvedValue({
    providers: [], unavailable: [], refresh: { refreshed: [{ id: providerId, ok: true, skipped: false, modelSource: 'live' }] },
  } as never);
  vi.mocked(runtime.buildRoutingRuntime).mockResolvedValue(buildSwitchyardFixtureCatalog(loadRegistry().providers));
  vi.mocked(installation.resolveClaudeInstallation).mockReturnValue(installed as never);
  vi.mocked(patcher.runLaunchPatchCheck).mockResolvedValue(undefined);
  vi.mocked(patch.checkResolvedPatchState).mockResolvedValue({
    state: 'patched',
    manifest: { configHash: manifestHash, transformVersion: patchState.currentTransformVersion() },
    configHash: desiredHash,
  } as never);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

  await expect(runSwitchyardCommand(['enable'])).resolves.toBe(1);

  expect(loadPreferences().routing?.enabled).toBe(false);
});

it('keeps routing disabled when supported harness readiness rejects enable', async () => {
  const providerId = 'switchyard-fixture-provider';
  const target = { providerId, modelId: 'switchyard-front-model' };
  const registered = provider({
    id: providerId,
    templateId: 'custom',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel(target.modelId)] },
  });
  saveRegistry({ schemaVersion: 1, providers: [registered] });
  savePreferences({ routing: { enabled: false, cheapFallback: target } });
  const discovery = await import('../src/provider-catalog.js');
  const runtime = await import('../src/routing-runtime.js');
  const installation = await import('../src/claude-installation.js');
  const patcher = await import('../src/patcher.js');
  vi.mocked(discovery.fetchFreshProviderCatalog).mockResolvedValue({
    providers: [], unavailable: [], refresh: { refreshed: [{ id: providerId, ok: true, skipped: false, modelSource: 'live' }] },
  } as never);
  vi.mocked(runtime.buildRoutingRuntime).mockResolvedValue(buildSwitchyardFixtureCatalog(loadRegistry().providers));
  vi.mocked(installation.resolveClaudeInstallation).mockReturnValue({} as never);
  vi.mocked(patcher.runLaunchPatchCheck).mockRejectedValue(new Error('Unsupported harness anchor'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

  await expect(runSwitchyardCommand(['enable'])).resolves.toBe(1);

  expect(loadPreferences().routing?.enabled).toBe(false);
});

it('rejects enable when routing preferences change during patch readiness', async () => {
  const providerId = 'switchyard-fixture-provider';
  const target = { providerId, modelId: 'switchyard-front-model' };
  const registered = provider({
    id: providerId,
    templateId: 'custom',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel(target.modelId)] },
  });
  saveRegistry({ schemaVersion: 1, providers: [registered] });
  savePreferences({ routing: { enabled: false, cheapFallback: target }, lastModel: 'saved-model' });
  const discovery = await import('../src/provider-catalog.js');
  const runtime = await import('../src/routing-runtime.js');
  const installation = await import('../src/claude-installation.js');
  const patcher = await import('../src/patcher.js');
  const patch = await import('../src/patch-reconcile.js');
  const patchState = await import('../src/patch-state.js');
  vi.mocked(discovery.fetchFreshProviderCatalog).mockResolvedValue({
    providers: [], unavailable: [], refresh: { refreshed: [{ id: providerId, ok: true, skipped: false, modelSource: 'live' }] },
  } as never);
  vi.mocked(runtime.buildRoutingRuntime).mockResolvedValue(buildSwitchyardFixtureCatalog(loadRegistry().providers));
  vi.mocked(installation.resolveClaudeInstallation).mockReturnValue({} as never);
  vi.mocked(patcher.runLaunchPatchCheck).mockResolvedValue(undefined);
  vi.mocked(patch.checkResolvedPatchState).mockImplementation(async () => {
    const { updateRoutingPreferences } = await import('../src/config.js');
    updateRoutingPreferences(current => ({ ...current, subscriptionPreference: 'api-first' }));
    return {
      state: 'patched',
      manifest: { configHash: 'current-config', transformVersion: patchState.currentTransformVersion() },
      configHash: 'current-config',
    } as never;
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

  await expect(runSwitchyardCommand(['enable'])).resolves.toBe(1);

  expect(loadPreferences().routing).toMatchObject({ enabled: false, cheapFallback: target, subscriptionPreference: 'api-first' });
  expect(loadPreferences().lastModel).toBe('saved-model');
});
