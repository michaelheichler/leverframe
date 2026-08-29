import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runModelsCommand } from '../src/cli-command-models.js';
import { loadPreferences, savePreferences } from '../src/config.js';
import { resetLegacyMigrationForTests } from '../src/paths.js';

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
  };
});

let tempHome: string;
let previousHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'leverframe-models-cmd-'));
  previousHome = process.env['LEVERFRAME_HOME'];
  process.env['LEVERFRAME_HOME'] = tempHome;
  resetLegacyMigrationForTests();
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousHome;
  resetLegacyMigrationForTests();
  vi.clearAllMocks();
});

describe('runModelsCommand context ceiling flags', () => {
  it('clears a stored ceiling opt-in even when the model no longer reports a maximum', async () => {
    savePreferences({ contextCeilingOverrides: ['gpt-5.6-sol'] });
    expect(loadPreferences().contextCeilingOverrides).toEqual(['gpt-5.6-sol']);

    const code = await runModelsCommand({ noContextCeiling: 'gpt-5.6-sol' });

    expect(code).toBe(0);
    expect(loadPreferences().contextCeilingOverrides).toBeUndefined();
  });

  it('still refuses to opt in when no live maximum is on record', async () => {
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
