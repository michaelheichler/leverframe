import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadPreferences, savePreferences } from '../src/config.js';
import { resetLegacyMigrationForTests } from '../src/paths.js';

const originalHome = process.env['HOME'];
const originalAppHome = process.env['LEVERFRAME_HOME'];
let temporaryHome: string;

afterEach(() => {
  rmSync(temporaryHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;
  if (originalAppHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = originalAppHome;
  resetLegacyMigrationForTests();
});

function isolatePreferences(): void {
  temporaryHome = mkdtempSync(join(tmpdir(), 'leverframe-summary-config-'));
  vi.stubEnv('HOME', temporaryHome);
  vi.stubEnv('LEVERFRAME_HOME', join(temporaryHome, 'app'));
  resetLegacyMigrationForTests();
}

it('loads summaries disabled when no opt-in has been saved', () => {
  isolatePreferences();

  expect(loadPreferences().summarySettings).toEqual({ enabled: false });
});

it('persists the explicit summary opt-in and lifetime spending limit', () => {
  isolatePreferences();
  const preferences = {
    enabled: true,
    engineId: 'fixture-engine',
    lifetimeLimitMicros: 8_000,
    pricing: { inputMicrosPerMillion: 2_000, outputMicrosPerMillion: 3_000, provenance: 'fixture-rate-card' },
  };

  savePreferences({ summarySettings: preferences });

  expect(loadPreferences().summarySettings).toEqual(preferences);
});
