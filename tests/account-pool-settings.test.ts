import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as prompts from '@clack/prompts';
import { loadPreferences } from '../src/config.js';
import { runAccountPoolSettings } from '../src/account-management-prompts.js';

const settingsPrompt = vi.hoisted(() => ({
  responses: [] as string[],
  textResponses: [] as string[],
  infos: [] as string[],
}));

vi.mock('@clack/prompts', async importOriginal => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return {
    ...actual,
    select: vi.fn(async (_options: unknown) => settingsPrompt.responses.shift()),
    text: vi.fn(async (_options: unknown) => settingsPrompt.textResponses.shift()),
    log: { ...actual.log, info: vi.fn((message: string) => settingsPrompt.infos.push(message)) },
  };
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-pool-settings-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('LEVERFRAME_HOME', join(home, '.leverframe'));
  settingsPrompt.responses = [];
  settingsPrompt.textResponses = [];
  settingsPrompt.infos = [];
  vi.mocked(prompts.select).mockClear();
  vi.mocked(prompts.text).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

it('defaults account balancing and quota failover to enabled', () => {
  expect(loadPreferences()).toMatchObject({ accountPoolBalancing: true, accountPoolFailover: true });
});

it.each([
  { selection: 'balancing', expected: { accountPoolBalancing: false, accountPoolFailover: true } },
  { selection: 'failover', expected: { accountPoolBalancing: true, accountPoolFailover: false } },
])('persists the $selection terminal setting independently', async ({ selection, expected }) => {
  settingsPrompt.responses = [selection, 'back'];

  await runAccountPoolSettings();

  expect(prompts.select).toHaveBeenCalledTimes(2);
  expect(loadPreferences()).toMatchObject(expected);
});

it('persists paid summary opt-in from the account settings menu', async () => {
  settingsPrompt.responses = ['summary-toggle', 'back'];

  await runAccountPoolSettings();

  expect(loadPreferences().summarySettings?.enabled).toBe(true);
});

it('saves the selected summary engine and explicit lifetime spending limit', async () => {
  settingsPrompt.responses = ['summary-configure', 'back'];
  settingsPrompt.textResponses = ['openai:fixture-model', '0.008', '0.002', '0.003', 'fixture-rate-card'];

  await runAccountPoolSettings();

  expect(loadPreferences().summarySettings).toEqual({
    enabled: false,
    engineId: 'openai:fixture-model',
    lifetimeLimitMicros: 8_000,
    pricing: { inputMicrosPerMillion: 2_000, outputMicrosPerMillion: 3_000, provenance: 'fixture-rate-card' },
  });
});

it('converts USD settings to exact micros before persisting them', async () => {
  settingsPrompt.responses = ['summary-configure', 'back'];
  settingsPrompt.textResponses = ['openai:fixture-model', '0.000001', '0.123456', '1.000001', 'fixture-rate-card'];

  await runAccountPoolSettings();

  expect(loadPreferences().summarySettings).toEqual({
    enabled: false,
    engineId: 'openai:fixture-model',
    lifetimeLimitMicros: 1,
    pricing: { inputMicrosPerMillion: 123_456, outputMicrosPerMillion: 1_000_001, provenance: 'fixture-rate-card' },
  });
});

it.each(['0', '-1', '1.0000001', '9007199254.740992', 'not-a-price'])('does not save unsupported lifetime USD input %s', async lifetime => {
  settingsPrompt.responses = ['summary-configure', 'back'];
  settingsPrompt.textResponses = ['openai:fixture-model', lifetime];

  await runAccountPoolSettings();

  expect(loadPreferences().summarySettings).toEqual({ enabled: false });
});

it('accepts zero input and output prices', async () => {
  settingsPrompt.responses = ['summary-configure', 'back'];
  settingsPrompt.textResponses = ['openai:fixture-model', '0.000001', '0', '0', 'fixture-rate-card'];

  await runAccountPoolSettings();

  expect(loadPreferences().summarySettings).toEqual({
    enabled: false,
    engineId: 'openai:fixture-model',
    lifetimeLimitMicros: 1,
    pricing: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, provenance: 'fixture-rate-card' },
  });
});
