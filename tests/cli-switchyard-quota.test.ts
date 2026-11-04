import { isAbsolute, relative } from 'node:path';
import { expect, it } from 'vitest';
import { cachedSwitchyardCatalog, orderedSwitchyardModels, switchyardModelLine } from '../src/cli-switchyard-catalog.js';
import { getAppHome, getProvidersPath } from '../src/paths.js';
import { saveRegistry } from '../src/registry/io.js';
import type { RegistryProvider } from '../src/registry/types.js';

it('shows account-scoped cached quota without ranking it as price or billing evidence', () => {
  const testHome = process.env['LEVERFRAME_TEST_HOME'];
  expect(testHome).toBeTruthy();
  const appHome = getAppHome();
  const appPath = relative(testHome!, appHome);
  expect(appPath === '' || (!appPath.startsWith('..') && !isAbsolute(appPath))).toBe(true);
  const registryPath = relative(testHome!, getProvidersPath());
  expect(!registryPath.startsWith('..') && !isAbsolute(registryPath)).toBe(true);

  const fetchedAt = '2026-10-01T00:00:00.000Z';
  const provider: RegistryProvider = {
    id: 'quota-fixture-provider', templateId: 'custom', name: 'quota fixture', enabled: true,
    authRef: 'keyring:quota-fixture', authType: 'api', api: { url: 'https://quota-fixture.invalid/v1' },
    addedAt: fetchedAt,
    accounts: [
      { id: 'quota-account-a', authRef: 'keyring:quota-a', enabled: true, modelsCache: {
        source: 'harness', fetchedAt, models: [{ id: 'model-a', name: 'model-a', upstreamModelId: 'model-a', modelFormat: 'anthropic',
          subscriptionQuota: { remainingFraction: 0, resetTime: '2026-10-02T00:00:00.000Z' } }],
      } },
      { id: 'quota-account-b', authRef: 'keyring:quota-b', enabled: true, modelsCache: {
        source: 'harness', fetchedAt, models: [{ id: 'model-b', name: 'model-b', upstreamModelId: 'model-b', modelFormat: 'anthropic',
          subscriptionQuota: { remainingFraction: 0.9, resetTime: '2026-10-03T00:00:00.000Z' } }],
      } },
    ],
  };
  saveRegistry({ schemaVersion: 1, providers: [provider] });

  const models = orderedSwitchyardModels(cachedSwitchyardCatalog());
  const lines = models.map(model => switchyardModelLine(model));

  expect(lines).toHaveLength(2);
  expect(models.map(model => model.subscriptionQuota?.remainingFraction)).toEqual([0, 0.9]);
  expect(models.map(model => model.subscriptionQuota?.freshness)).toEqual(['unknown', 'unknown']);
  expect(models.map(model => model.billing.kind)).toEqual(['unknown', 'unknown']);
  expect(models.map(model => model.capacity)).toEqual([undefined, undefined]);
  expect(lines[0]).toMatch(/remaining fraction\s+0(?:,|\b)/);
  expect(lines[0]).toContain('2026-10-02T00:00:00.000Z');
  expect(lines[0]).toContain('harness');
  expect(lines[0]).toMatch(new RegExp(`source harness, observed ${fetchedAt}, freshness unknown`));
  expect(lines[1]).toMatch(/remaining fraction\s+0\.9(?:,|\b)/);
  expect(lines[1]).toContain('2026-10-03T00:00:00.000Z');
  expect(lines[1]).toContain('harness');
  expect(lines[1]).toMatch(new RegExp(`source harness, observed ${fetchedAt}, freshness unknown`));
  expect(lines[0]).not.toBe(switchyardModelLine({ ...models[0]!, subscriptionQuota: undefined }));
  expect(lines[1]).not.toBe(switchyardModelLine({ ...models[1]!, subscriptionQuota: undefined }));
});

it('does not display malformed or absent cached quota as evidence', () => {
  const testHome = process.env['LEVERFRAME_TEST_HOME'];
  expect(testHome).toBeTruthy();
  const appPath = relative(testHome!, getAppHome());
  expect(appPath === '' || (!appPath.startsWith('..') && !isAbsolute(appPath))).toBe(true);
  const registryPath = relative(testHome!, getProvidersPath());
  expect(!registryPath.startsWith('..') && !isAbsolute(registryPath)).toBe(true);

  const fetchedAt = '2026-10-01T00:00:00.000Z';
  const provider: RegistryProvider = {
    id: 'quota-invalid-fixture', templateId: 'custom', name: 'quota fixture', enabled: true,
    authRef: 'keyring:quota-invalid-fixture', authType: 'api', api: { url: 'https://quota-fixture.invalid/v1' },
    addedAt: fetchedAt,
    modelsCache: { fetchedAt, models: [
      { id: 'missing-quota', name: 'missing quota', upstreamModelId: 'missing-quota', modelFormat: 'anthropic' },
      { id: 'malformed-quota', name: 'malformed quota', upstreamModelId: 'malformed-quota', modelFormat: 'anthropic',
        subscriptionQuota: { remainingFraction: 1.2, resetTime: 'not-a-reset-time' } },
    ] },
  };
  saveRegistry({ schemaVersion: 1, providers: [provider] });

  const lines = orderedSwitchyardModels(cachedSwitchyardCatalog()).map(model => switchyardModelLine(model));
  const output = lines.join('\n');

  expect(lines).toHaveLength(2);
  expect(output).not.toContain(String(1.2));
  expect(output).not.toContain('not-a-reset-time');
});
