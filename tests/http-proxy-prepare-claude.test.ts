import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/cli-args.js';
import { startConfiguredHttpProxy } from '../src/http-proxy/index.js';

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  catalog: vi.fn(),
  installation: vi.fn(),
  prepare: vi.fn(),
  bind: vi.fn(),
}));

vi.mock('../src/config.js', () => ({ loadPreferences: () => ({ favoriteModels: [], modelAliases: [] }) }));
vi.mock('../src/provider-catalog.js', () => ({
  fetchFreshProviderCatalog: mocks.catalog,
  resolveLocalProviderApiKey: async () => 'provider-fixture-key',
}));
vi.mock('../src/target-compatibility.js', () => ({ providersForTarget: (providers: unknown[]) => providers }));
vi.mock('../src/claude-installation.js', () => ({ resolveClaudeInstallation: mocks.installation }));
vi.mock('../src/patcher.js', () => ({ runLaunchPatchCheck: mocks.prepare }));
vi.mock('../src/http-proxy/server.js', () => ({ startHttpProxy: mocks.bind }));
vi.mock('../src/http-proxy/ca.js', () => ({ ensureHttpProxyCaBundle: (path: string) => path }));

const installation = { canonicalPath: '/fixture/claude', version: '2.1.266' };
const provider = {
  id: 'fixture',
  name: 'Fixture',
  models: [{
    id: 'available-model',
    upstreamModelId: 'available-model',
    name: 'Available model',
    modelFormat: 'openai',
    npm: '@ai-sdk/openai',
    contextWindow: 272_000,
  }],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.events.length = 0;
  mocks.catalog.mockImplementation(async () => {
    mocks.events.push('catalog');
    return { providers: [provider], unavailable: [] };
  });
  mocks.installation.mockImplementation(() => {
    mocks.events.push('installation');
    return installation;
  });
  mocks.prepare.mockImplementation(async () => { mocks.events.push('prepared'); });
  mocks.bind.mockImplementation(async () => {
    mocks.events.push('bound');
    return { caCertPath: '/fixture/ca.pem' };
  });
});

describe('HTTP proxy Claude preparation', () => {
  it('prepares the complete discovered catalog before opening the proxy listener', async () => {
    const { loaded } = await startConfiguredHttpProxy(0, false, '/fixture/inference.jsonl', undefined, undefined, true);

    expect(loaded.providers.flatMap(entry => entry.models.map(model => model.id))).toEqual(['available-model']);
    expect(mocks.prepare).toHaveBeenCalledWith({
      agentStdout: true,
      installation,
      freshProviders: loaded.providers,
      contextSelectionAvailable: true,
    });
    expect(mocks.events).toEqual(['catalog', 'installation', 'prepared', 'bound']);
  });

  it('rejects preparation failure before opening a listener', async () => {
    mocks.prepare.mockRejectedValueOnce(new Error('fixture patch failure'));

    await expect(startConfiguredHttpProxy(0, false, '/fixture/inference.jsonl', undefined, undefined, true))
      .rejects.toThrow('fixture patch failure');
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it('rejects a missing Claude installation before opening a listener', async () => {
    mocks.installation.mockReturnValueOnce(null);

    await expect(startConfiguredHttpProxy(0, false, '/fixture/inference.jsonl', undefined, undefined, true))
      .rejects.toThrow(/claude/i);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it('delegates an empty catalog to the existing restore or no-op preparation', async () => {
    mocks.catalog.mockResolvedValueOnce({ providers: [], unavailable: [] });

    const { loaded } = await startConfiguredHttpProxy(0, false, '/fixture/inference.jsonl', undefined, undefined, true);

    expect(loaded.providers).toEqual([]);
    expect(mocks.prepare).toHaveBeenCalledWith({
      agentStdout: true,
      installation,
      freshProviders: [],
      contextSelectionAvailable: true,
    });
    expect(mocks.bind).toHaveBeenCalledOnce();
  });

  it('leaves Claude untouched when preparation is not requested', async () => {
    await startConfiguredHttpProxy(0, false, '/fixture/inference.jsonl');

    expect(mocks.bind).toHaveBeenCalledOnce();
    expect(mocks.installation).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('parses the opt-in server preparation flag', () => {
    const parsed = parseArgs(['server', '--proxy', '--prepare-claude']);

    expect(parsed.error).toBeUndefined();
    expect(parsed.serverPrepareClaude).toBe(true);
  });
});
