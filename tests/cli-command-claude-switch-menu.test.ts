import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProvider, UserPreferences } from '../src/types.js';

const mocks = vi.hoisted(() => ({
  fetchFreshProviderCatalog: vi.fn(),
  runLaunchPatchCheck: vi.fn(),
  loadPreferences: vi.fn(),
  recordLaunchSelection: vi.fn(),
  resolveBridgeMode: vi.fn(),
  needsFirstRunSetup: vi.fn(),
  runFirstRunWizard: vi.fn(),
  startProxy: vi.fn(),
  startProxyCatalog: vi.fn(),
  launchClaude: vi.fn(),
}));

const installation = {
  identity: 'fixture-claude',
  logicalPath: '/tmp/claude',
  canonicalPath: '/tmp/claude',
  installationKind: 'native' as const,
  version: '2.1.263',
};

const provider: LocalProvider = {
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
    completionsUrl: 'https://api.openai.com/v1/chat/completions',
    contextWindow: 301_000,
    maxContextWindow: 1_101_000,
  }],
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

vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    loadPreferences: mocks.loadPreferences,
    recordLaunchSelection: mocks.recordLaunchSelection,
    resolveBridgeMode: mocks.resolveBridgeMode,
  };
});

vi.mock('../src/first-run.js', () => ({
  needsFirstRunSetup: mocks.needsFirstRunSetup,
  runFirstRunWizard: mocks.runFirstRunWizard,
}));

vi.mock('../src/proxy.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/proxy.js')>();
  return {
    ...actual,
    startProxy: mocks.startProxy,
    startProxyCatalog: mocks.startProxyCatalog,
  };
});

vi.mock('../src/launch.js', () => ({
  launchClaude: mocks.launchClaude,
}));

import { runClaudeCommand } from '../src/cli-command-claude.js';

describe('Claude endpoint switch menu', () => {
  beforeEach(() => {
    const prefs: UserPreferences = {
      favoriteModels: [{ providerId: provider.id, modelId: provider.models[0]!.id }],
      modelAliases: [{ name: 'cold', providerId: provider.id, modelId: provider.models[0]!.id }],
    };
    mocks.loadPreferences.mockReturnValue(prefs);
    mocks.resolveBridgeMode.mockReturnValue('endpoint');
    mocks.needsFirstRunSetup.mockResolvedValue(false);
    mocks.runFirstRunWizard.mockResolvedValue('continue');
    mocks.fetchFreshProviderCatalog.mockResolvedValue({ providers: [provider], unavailable: [] });
    mocks.runLaunchPatchCheck.mockResolvedValue(undefined);
    mocks.startProxyCatalog.mockResolvedValue({ port: 17645, token: 'proxy-token', close: vi.fn() });
    mocks.startProxy.mockResolvedValue({ port: 17646, token: 'single-token', close: vi.fn() });
    mocks.launchClaude.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const mock of Object.values(mocks)) {
      if (typeof mock === 'function') mock.mockReset();
    }
  });

  it('keeps the fresh catalog when an explicit starting model is supplied', async () => {
    const code = await runClaudeCommand({
      command: 'claude',
      showHelp: false,
      showVersion: false,
      dryRun: false,
      trace: false,
      claudeArgs: [],
      bridgeMode: 'endpoint',
      launchProvider: provider.id,
      launchModel: provider.models[0]!.id,
    });

    expect(code).toBe(0);
    expect(mocks.startProxyCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.startProxy).not.toHaveBeenCalled();
    const [routes, defaultAlias, , , , , aliases] = mocks.startProxyCatalog.mock.calls[0]! as [
      Array<{ aliasId: string; providerId?: string }>,
      string,
      boolean,
      unknown,
      unknown,
      unknown,
      Array<{ name: string; routeId: string }>,
    ];
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ providerId: provider.id });
    expect(defaultAlias).toBe(routes[0]!.aliasId);
    expect(aliases).toEqual([
      { name: 'leverframe:openai-oauth:gpt-cold', routeId: routes[0]!.aliasId },
      { name: 'cold', routeId: routes[0]!.aliasId },
    ]);
    expect(mocks.launchClaude).toHaveBeenCalledTimes(1);
  });

  it('uses catalog routing and fresh context for an explicit external model without favorites', async () => {
    mocks.loadPreferences.mockReturnValue({} satisfies UserPreferences);
    vi.stubEnv('CLAUDE_CODE_MAX_CONTEXT_TOKENS', '999999');

    const code = await runClaudeCommand({
      command: 'claude',
      showHelp: false,
      showVersion: false,
      dryRun: false,
      trace: false,
      claudeArgs: [],
      bridgeMode: 'endpoint',
      launchProvider: provider.id,
      launchModel: provider.models[0]!.id,
    });

    expect(code).toBe(0);
    expect(mocks.startProxyCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.startProxy).not.toHaveBeenCalled();
    const [routes] = mocks.startProxyCatalog.mock.calls[0]! as [Array<{
      contextWindow?: number;
      maxContextWindow?: number;
    }>];
    expect(routes[0]).toMatchObject({ contextWindow: 301_000, maxContextWindow: 1_101_000 });

    const [launch] = mocks.launchClaude.mock.calls[0]! as [{
      env: NodeJS.ProcessEnv;
      model: string;
    }];
    expect(launch.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
    expect(launch.env.ANTHROPIC_MODEL).toBe('leverframe:openai-oauth:gpt-cold');
    expect(launch.model).toBe('leverframe:openai-oauth:gpt-cold');
    expect(mocks.runLaunchPatchCheck).toHaveBeenCalledWith(expect.objectContaining({
      selectedModel: { providerId: provider.id, modelId: provider.models[0]!.id },
    }));
  });

  it('keeps an initial [1m] model identity without pinning a catalog context scalar', async () => {
    const largeProvider: LocalProvider = {
      ...provider,
      models: [{
        ...provider.models[0]!,
        contextWindow: 1_048_576,
        maxContextWindow: 1_203_017,
      }],
    };
    mocks.loadPreferences.mockReturnValue({} satisfies UserPreferences);
    mocks.fetchFreshProviderCatalog.mockResolvedValue({ providers: [largeProvider], unavailable: [] });
    vi.stubEnv('CLAUDE_CODE_MAX_CONTEXT_TOKENS', '999999');

    const code = await runClaudeCommand({
      command: 'claude',
      showHelp: false,
      showVersion: false,
      dryRun: false,
      trace: false,
      claudeArgs: [],
      bridgeMode: 'endpoint',
      launchProvider: largeProvider.id,
      launchModel: largeProvider.models[0]!.id,
    });

    expect(code).toBe(0);
    const [launch] = mocks.launchClaude.mock.calls[0]! as [{
      env: NodeJS.ProcessEnv;
      model: string;
    }];
    expect(launch.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
    expect(launch.env.ANTHROPIC_MODEL).toBe('leverframe:openai-oauth:gpt-cold[1m]');
    expect(launch.model).toBe('leverframe:openai-oauth:gpt-cold[1m]');
  });
});
