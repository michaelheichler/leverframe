import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProvider, UserPreferences } from '../src/types.js';

const mocks = vi.hoisted(() => ({
  runLaunchPatchCheck: vi.fn(),
  loadPreferences: vi.fn(),
  resolveBridgeMode: vi.fn(),
  startConfiguredHttpProxy: vi.fn(),
  loadHttpProxyRoutes: vi.fn(),
  launchClaude: vi.fn(),
}));

const installation = {
  identity: 'fixture-claude',
  logicalPath: '/tmp/claude',
  canonicalPath: '/tmp/claude',
  installationKind: 'native' as const,
  version: '2.1.263',
};

const freshProvider: LocalProvider = {
  id: 'openai-oauth',
  name: 'OpenAI OAuth',
  apiKey: 'provider-key',
  authType: 'oauth',
  models: [{
    id: 'gpt-fresh',
    name: 'Fresh model',
    family: 'gpt',
    brand: 'OpenAI',
    modelFormat: 'openai',
    upstreamModelId: 'gpt-fresh',
    npm: '@ai-sdk/openai',
    contextWindow: 272_000,
    maxContextWindow: 872_000,
  }],
};

vi.mock('../src/patcher.js', () => ({
  runLaunchPatchCheck: mocks.runLaunchPatchCheck,
}));

vi.mock('../src/claude-installation.js', () => ({
  resolveClaudeInstallation: vi.fn(() => installation),
}));

vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    loadPreferences: mocks.loadPreferences,
    resolveBridgeMode: mocks.resolveBridgeMode,
  };
});

vi.mock('../src/http-proxy/index.js', () => ({
  loadHttpProxyRoutes: mocks.loadHttpProxyRoutes,
  printHttpProxyModels: vi.fn(),
  reportSkippedHttpProxyFavorites: vi.fn(),
  startConfiguredHttpProxy: mocks.startConfiguredHttpProxy,
}));

vi.mock('../src/launch.js', () => ({
  launchClaude: mocks.launchClaude,
}));

import { runClaudeCommand } from '../src/cli-command-claude.js';

describe('Claude proxy context selection launch', () => {
  beforeEach(() => {
    mocks.loadPreferences.mockReturnValue({} satisfies UserPreferences);
    mocks.resolveBridgeMode.mockReturnValue('proxy');
    mocks.runLaunchPatchCheck.mockResolvedValue(undefined);
    mocks.startConfiguredHttpProxy.mockResolvedValue({
      handle: {
        host: '127.0.0.1',
        port: 17645,
        caCertPath: '/tmp/leverframe-ca.pem',
        token: 'proxy-token',
        modelIds: ['leverframe:openai-oauth:gpt-fresh'],
        close: vi.fn().mockResolvedValue(undefined),
      },
      loaded: {
        routes: [],
        unavailable: [],
        unsupported: [],
        aliases: [],
        unavailableAliases: [],
        favoriteCount: 0,
        providers: [freshProvider],
      },
    });
    mocks.launchClaude.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const mock of Object.values(mocks)) {
      if (typeof mock === 'function') mock.mockReset();
    }
  });

  it('keeps Anthropic traffic on the MITM origin while exposing a per-run context callback', async () => {
    vi.stubEnv('NO_PROXY', 'example.com');
    const code = await runClaudeCommand({
      command: 'claude',
      showHelp: false,
      showVersion: false,
      dryRun: false,
      trace: false,
      claudeArgs: [],
      bridgeMode: 'proxy',
    });

    expect(code).toBe(0);
    expect(mocks.runLaunchPatchCheck).toHaveBeenCalledWith(expect.objectContaining({
      installation,
      freshProviders: [freshProvider],
      contextSelectionAvailable: true,
    }));
    const [launch] = mocks.launchClaude.mock.calls[0]! as [{ env: NodeJS.ProcessEnv; extraArgs: string[] }];
    expect(launch.env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
    expect(launch.env.NO_PROXY?.split(',')).toEqual(expect.arrayContaining(['example.com', '127.0.0.1', 'localhost']));
    expect(launch.env.no_proxy).toBe(launch.env.NO_PROXY);
    expect(launch.env.LEVERFRAME_CONTEXT_SELECTION_BASE_URL).toBe('http://127.0.0.1:17645');
    expect(launch.env.LEVERFRAME_CONTEXT_SELECTION_TOKEN).toBe('proxy-token');
    expect(JSON.parse(launch.extraArgs[1]!)).toEqual({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } });
  });

  it('closes the proxy before returning when launch patch reconciliation fails', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.startConfiguredHttpProxy.mockResolvedValueOnce({
      handle: {
        host: '127.0.0.1',
        port: 17645,
        caCertPath: '/tmp/leverframe-ca.pem',
        token: 'proxy-token',
        modelIds: [],
        close,
      },
      loaded: {
        routes: [],
        unavailable: [],
        unsupported: [],
        aliases: [],
        unavailableAliases: [],
        favoriteCount: 0,
        providers: [freshProvider],
      },
    });
    mocks.runLaunchPatchCheck.mockRejectedValueOnce(new Error('patch failed'));

    const code = await runClaudeCommand({
      command: 'claude',
      showHelp: false,
      showVersion: false,
      dryRun: false,
      trace: false,
      claudeArgs: [],
      bridgeMode: 'proxy',
    });

    expect(code).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(mocks.launchClaude).not.toHaveBeenCalled();
  });
});
