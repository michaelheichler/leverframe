import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClaudeInstallation } from '../src/claude-installation.js';
import type { LocalProvider, UserPreferences } from '../src/types.js';

const boundary = vi.hoisted(() => ({
  startProxy: vi.fn(),
  startProxyCatalog: vi.fn(),
  launchClaude: vi.fn(),
  resolveLocalProviderApiKey: vi.fn(),
}));

vi.mock('../src/proxy.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/proxy.js')>(),
  startProxy: boundary.startProxy,
  startProxyCatalog: boundary.startProxyCatalog,
}));
vi.mock('../src/launch.js', () => ({ launchClaude: boundary.launchClaude }));
vi.mock('../src/provider-catalog.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/provider-catalog.js')>(),
  resolveLocalProviderApiKey: boundary.resolveLocalProviderApiKey,
}));

const previousHome = process.env.LEVERFRAME_HOME;
let home: string;
const installation: ClaudeInstallation = {
  identity: 'claude-fixture', logicalPath: '/tmp/claude', canonicalPath: '/tmp/claude', installationPath: '/tmp/claude',
  discoverySource: 'path-lookup', installationKind: 'custom', executableType: 'binary', version: 'fixture',
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-native-account-launch-'));
  process.env.LEVERFRAME_HOME = home;
  vi.clearAllMocks();
  boundary.startProxyCatalog.mockResolvedValue({ port: 17645, token: 'proxy-token', close: vi.fn() });
  boundary.launchClaude.mockResolvedValue(0);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

it('routes a native Anthropic account model through the switch catalog without favorites', async () => {
  const provider: LocalProvider = {
    id: 'anthropic-api', name: 'Anthropic API', apiKey: 'primary-account-key', authType: 'api',
    models: [{
      id: 'claude-model@secondary', upstreamModelId: 'claude-model', name: 'Claude model [WORK]',
      family: 'claude', brand: 'Anthropic', modelFormat: 'anthropic', baseUrl: 'https://api.anthropic.com',
      accountId: 'secondary', accountTag: 'WORK', accountName: 'Work account',
    }],
  };
  const model = provider.models[0]!;
  const { launchSelectedEndpoint } = await import('../src/claude-endpoint-launch.js');

  const exitCode = await launchSelectedEndpoint({
    installation, provider, model, providers: [provider], favorites: [], prefs: {} as UserPreferences,
    dryRun: false, trace: false, claudeArgs: [],
  });

  expect(exitCode).toBe(0);
  expect(boundary.startProxyCatalog).toHaveBeenCalledTimes(1);
  expect(boundary.startProxy).not.toHaveBeenCalled();
  expect(boundary.resolveLocalProviderApiKey).not.toHaveBeenCalled();
  const [routes] = boundary.startProxyCatalog.mock.calls[0]! as [Array<{
    providerId?: string; accountId?: string; accountTag?: string; realModelId: string;
  }>];
  expect(routes).toMatchObject([{ providerId: 'anthropic-api', accountId: 'secondary', accountTag: 'WORK', realModelId: 'claude-model' }]);
  const [launch] = boundary.launchClaude.mock.calls[0]! as [{ env: NodeJS.ProcessEnv }];
  expect(launch.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:17645');
});
