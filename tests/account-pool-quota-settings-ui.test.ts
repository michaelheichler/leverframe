/** Because the quota threshold is a user-editable setting. */
import * as prompts from '@clack/prompts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runAccountPoolSettings } from '../src/account-management-prompts.js';
import { loadPreferences } from '../src/config.js';

const promptHarness = vi.hoisted(() => ({
  select: vi.fn(), text: vi.fn(), isCancel: vi.fn(() => false),
  log: { info: vi.fn(), warn: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock('@clack/prompts', () => promptHarness);

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-quota-settings-ui-'));
  previousHome = process.env.LEVERFRAME_HOME;
  process.env.LEVERFRAME_HOME = home;
  vi.mocked(prompts.select).mockReset();
  vi.mocked(prompts.text).mockReset();
  vi.mocked(prompts.isCancel).mockReturnValue(false);
  vi.mocked(prompts.log.info).mockReset();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

it('saves the selected percentage and shows the saved value in the settings list', async () => {
  vi.mocked(prompts.select).mockResolvedValueOnce('threshold').mockResolvedValueOnce('back');
  vi.mocked(prompts.text).mockResolvedValueOnce('31.5');

  await runAccountPoolSettings();

  expect(loadPreferences().accountPoolQuotaThresholdPercent).toBe(31.5);
  const settings = vi.mocked(prompts.select).mock.calls[1]![0].options;
  expect(settings.find(option => option.value === 'threshold')?.label).toContain('31.5%');
});

it('validates the setting within the allowed percentage range', async () => {
  vi.mocked(prompts.select).mockResolvedValueOnce('threshold').mockResolvedValueOnce('back');
  vi.mocked(prompts.text).mockResolvedValueOnce('25');

  await runAccountPoolSettings();

  const validate = vi.mocked(prompts.text).mock.calls[0]![0].validate;
  expect(validate?.('100')).toBeTruthy();
  expect(validate?.('99.5')).toBeUndefined();
});
