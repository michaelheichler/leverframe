import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, sep, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadPreferences, savePreferences } from '../src/config.js';
import { getAppHome, getConfigPath } from '../src/paths.js';
import { parseRoutingConfig } from '../src/routing-config.js';
import type { RoutingConfig } from '../src/model-routing.js';

const outerHome = process.env['LEVERFRAME_TEST_HOME'];
const enabledRouting: RoutingConfig = {
  enabled: true,
  cheapFallback: { providerId: 'fixture-recovery-pref-provider', modelId: 'fixture-recovery-pref-model' },
};
type RecoveryPreferences = RoutingConfig & { recoveryEnabled?: boolean };
let previousHome: string | undefined;
let preferencesHome: string | undefined;

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function savedRouting(): RecoveryPreferences | undefined {
  return loadPreferences().routing as RecoveryPreferences | undefined;
}

beforeEach(() => {
  expect(outerHome).toBeTruthy();
  previousHome = process.env['LEVERFRAME_HOME'];
  expect(inside(process.env['HOME']!, outerHome!)).toBe(true);
  mkdirSync(outerHome!, { recursive: true });
  const intendedHome = join(outerHome!, 'routing-recovery-preferences-');
  expect(inside(outerHome!, intendedHome)).toBe(true);
  preferencesHome = mkdtempSync(intendedHome);
  process.env['LEVERFRAME_HOME'] = preferencesHome;
  expect(inside(outerHome!, getAppHome())).toBe(true);
  expect(inside(outerHome!, getConfigPath())).toBe(true);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousHome;
  if (preferencesHome) {
    expect(inside(outerHome!, preferencesHome)).toBe(true);
    rmSync(preferencesHome, { recursive: true, force: true });
  }
});

it('enables recovery persistence when routing is first enabled', () => {
  savePreferences({ routing: enabledRouting });

  expect(savedRouting()).toMatchObject({ enabled: true, recoveryEnabled: true });
});

it('keeps a previously enabled recovery flag when routing is later disabled', () => {
  savePreferences({ routing: enabledRouting });
  savePreferences({ routing: { ...enabledRouting, enabled: false } });

  expect(savedRouting()).toMatchObject({ enabled: false, recoveryEnabled: true });
});

it('enables recovery when disabling a manually saved older routing config without the flag', () => {
  const configPath = getConfigPath();
  expect(inside(outerHome!, configPath)).toBe(true);
  expect(inside(outerHome!, dirname(configPath))).toBe(true);
  mkdirSync(dirname(configPath), { recursive: true });

  try {
    writeFileSync(configPath, JSON.stringify({ routing: enabledRouting }));
    savePreferences({ routing: { ...enabledRouting, enabled: false } });

    expect(savedRouting()).toMatchObject({ enabled: false, recoveryEnabled: true });
  } finally {
    expect(inside(outerHome!, configPath)).toBe(true);
    rmSync(configPath, { force: true });
  }
});

it('leaves recovery persistence absent for fresh disabled preferences', () => {
  savePreferences({ routing: { ...enabledRouting, enabled: false } });

  expect(savedRouting()?.recoveryEnabled).toBeUndefined();
});

it('rejects a nonboolean recovery persistence flag', () => {
  expect(() => parseRoutingConfig({ ...enabledRouting, recoveryEnabled: 'yes' }))
    .toThrow(/routing/i);
});
