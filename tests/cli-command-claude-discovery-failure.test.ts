import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ launch: vi.fn(), patch: vi.fn() }));
vi.mock('../src/config.js', () => ({
  loadPreferences: () => ({}), resolveBridgeMode: () => 'endpoint',
  recordLaunchSelection: vi.fn(),
}));
vi.mock('../src/claude-installation.js', () => ({
  resolveClaudeInstallation: () => ({ canonicalPath: '/fake/claude', version: '2.1.263' }),
}));
vi.mock('../src/provider-catalog.js', () => ({
  fetchFreshProviderCatalog: async () => ({ providers: [], unavailable: [{
    providerId: 'custom-fixture', providerName: 'Fixture', reason: 'discovery failed',
  }] }),
  providersForPicker: (providers: unknown[]) => providers,
}));
vi.mock('../src/patcher.js', () => ({ runLaunchPatchCheck: mocks.patch }));
vi.mock('../src/launch.js', () => ({ launchClaude: mocks.launch }));
vi.mock('../src/env.js', () => ({ detectConflicts: () => [] }));
vi.mock('@clack/prompts', () => ({ intro: vi.fn(), spinner: () => ({ start: vi.fn(), stop: vi.fn() }), log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { runClaudeCommand } from '../src/cli-command-claude.js';
afterEach(() => vi.restoreAllMocks());
it('fails an explicit launch when every provider fails discovery without patching or spawning', async () => {
  const code = await runClaudeCommand({
    command: 'claude', showHelp: false, showVersion: false, dryRun: true, trace: false,
    bridgeMode: 'endpoint', claudeArgs: ['-p', 'fixture'],
    launchProvider: 'custom-fixture', launchModel: 'fixture-model',
  });
  expect(code).toBe(1);
  expect(mocks.patch).not.toHaveBeenCalled();
  expect(mocks.launch).not.toHaveBeenCalled();
});
