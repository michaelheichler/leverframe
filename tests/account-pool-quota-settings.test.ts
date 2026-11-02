/** Because invalid stored or edited thresholds must never enable switching. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadPreferences, savePreferences } from '../src/config.js';
import { getConfigPath } from '../src/paths.js';

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-quota-settings-'));
  previousHome = process.env.LEVERFRAME_HOME;
  process.env.LEVERFRAME_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

it.each([0, 27.5, 99.5])('defaults the threshold and persists valid value %s', value => {
  expect(loadPreferences().accountPoolQuotaThresholdPercent).toBe(10);

  savePreferences({ accountPoolQuotaThresholdPercent: value });

  expect(loadPreferences().accountPoolQuotaThresholdPercent).toBe(value);
});

it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 100, 100.1])('rejects invalid persisted threshold writes (%s)', value => {
  expect(() => savePreferences({ accountPoolQuotaThresholdPercent: value })).toThrow(RangeError);
});

it('loads malformed stored thresholds as disabled rather than inferring active capacity policy', () => {
  writeFileSync(getConfigPath(), JSON.stringify({ accountPoolQuotaThresholdPercent: 'unsafe' }));

  expect(loadPreferences().accountPoolQuotaThresholdPercent).toBe(0);
});

it('loads a stored 100 percent threshold as disabled because nothing can exceed it', () => {
  writeFileSync(getConfigPath(), JSON.stringify({ accountPoolQuotaThresholdPercent: 100 }));

  expect(loadPreferences().accountPoolQuotaThresholdPercent).toBe(0);
});
