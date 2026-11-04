import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { getAppHome, getConfigPath } from '../src/paths.js';

const existingTarget = { providerId: 'existing-provider', modelId: 'existing-model' };

beforeEach(() => {
  const testHome = process.env['LEVERFRAME_TEST_HOME'];
  expect(testHome).toBeTruthy();
  const appPath = relative(testHome!, getAppHome());
  expect(appPath === '' || (!appPath.startsWith('..') && !isAbsolute(appPath))).toBe(true);
  const configPath = getConfigPath();
  const relativeConfig = relative(testHome!, configPath);
  expect(!relativeConfig.startsWith('..') && !isAbsolute(relativeConfig)).toBe(true);
  mkdirSync(getAppHome(), { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    routing: { enabled: false, subscriptionPreference: 'auto', cheapFloor: existingTarget,
      categories: { coding: { target: existingTarget } } },
    accountPoolBalancing: false,
    accountPoolFailover: false,
    futurePreference: { retained: true },
  }));
});

it('enables shared pool balancing with balanced billing while preserving other preferences', async () => {
  const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

  await expect(runSwitchyardCommand(['billing', 'balanced'])).resolves.toBe(0);

  const stored = JSON.parse(readFileSync(getConfigPath(), 'utf8')) as Record<string, unknown>;
  expect(stored).toMatchObject({
    accountPoolBalancing: true,
    accountPoolFailover: false,
    futurePreference: { retained: true },
    routing: {
      enabled: false,
      subscriptionPreference: 'balanced',
      cheapFloor: existingTarget,
      categories: { coding: { target: existingTarget } },
    },
  });
});

it.each(['auto', 'subscription-first', 'api-first'])('leaves shared pool balancing unchanged for %s billing', async preference => {
  const { runSwitchyardCommand } = await import('../src/cli-command-switchyard.js');

  await expect(runSwitchyardCommand(['billing', preference])).resolves.toBe(0);

  const stored = JSON.parse(readFileSync(getConfigPath(), 'utf8')) as Record<string, unknown>;
  expect(stored['accountPoolBalancing']).toBe(false);
  expect(stored['routing']).toMatchObject({ subscriptionPreference: preference, cheapFloor: existingTarget });
});
