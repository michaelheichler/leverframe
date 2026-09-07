import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProvider } from '../src/types.js';

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  fetchFreshProviderCatalog: vi.fn(),
  runLaunchPatchCheck: vi.fn(),
}));

const installation = {
  identity: 'fixture-claude',
  logicalPath: '/tmp/claude',
  canonicalPath: '/tmp/claude',
  installationKind: 'native' as const,
  version: '2.1.263',
};

vi.mock('../src/patcher.js', () => ({
  runLaunchPatchCheck: mocks.runLaunchPatchCheck,
}));

vi.mock('../src/claude-installation.js', () => ({
  resolveClaudeInstallation: vi.fn(() => installation),
}));

vi.mock('../src/provider-catalog.js', () => ({
  fetchFreshProviderCatalog: mocks.fetchFreshProviderCatalog,
  providersForPicker: (providers: LocalProvider[]) => providers,
  resolveLocalProviderApiKey: vi.fn(),
}));

import { runClaudeCommand } from '../src/cli-command-claude.js';

function freshCatalog(): { providers: LocalProvider[]; unavailable: [] } {
  return {
    providers: [{
      id: 'openai-oauth',
      name: 'OpenAI OAuth',
      apiKey: 'provider-key',
      authType: 'oauth',
      models: [{
        id: 'gpt-cold',
        name: 'Cold model',
        family: 'gpt',
        brand: 'OpenAI',
        modelFormat: 'openai',
        upstreamModelId: 'gpt-cold',
        npm: '@ai-sdk/openai',
        contextWindow: 301_000,
        maxContextWindow: 1_101_000,
      }],
    }],
    unavailable: [],
  };
}

describe('Claude launch freshness ordering', () => {
  beforeEach(() => {
    mocks.events.length = 0;
    mocks.fetchFreshProviderCatalog.mockImplementation(async () => {
      mocks.events.push('fresh');
      return freshCatalog();
    });
    mocks.runLaunchPatchCheck.mockImplementation(async () => {
      mocks.events.push('patch');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.fetchFreshProviderCatalog.mockReset();
    mocks.runLaunchPatchCheck.mockReset();
  });

  it('discovers model metadata before patch reconciliation when the cache starts empty', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const code = await runClaudeCommand({
        command: 'claude',
        showHelp: false,
        showVersion: false,
        dryRun: true,
        trace: false,
        claudeArgs: [],
        bridgeMode: 'endpoint',
        launchProvider: 'openai-oauth',
        launchModel: 'gpt-cold',
      });

      expect(code).toBe(0);
      expect(mocks.events).toEqual(['fresh', 'patch']);
      expect(mocks.runLaunchPatchCheck).toHaveBeenCalledWith(expect.objectContaining({
        agentStdout: false,
        dryRun: true,
        installation,
        freshProviders: expect.any(Array),
      }));
    } finally {
      output.mockRestore();
    }
  });
});
