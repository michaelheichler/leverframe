/**
 * Specifies the lazy Copilot runtime boundary without spawning its CLI.
 * SDK loading and client construction are controlled by test doubles.
 */
import { describe, expect, it, vi } from 'vitest';
import { getAppHome } from '../src/paths.js';
import {
  COPILOT_SDK_PACKAGE,
  CopilotSdkIncompatibleError,
  CopilotSdkNotInstalledError,
  CopilotUnsupportedNodeVersionError,
  createCopilotRuntime,
  isCopilotSupportedNodeVersion,
  resolveCopilotDirectories,
  validateCopilotSdkModule,
} from '../src/copilot/runtime.js';
import type {
  CopilotClientConstructOptions,
  CopilotRuntimeClient,
  CopilotRuntimeConfig,
  CopilotSdkModule,
} from '../src/copilot/runtime.js';

const FAKE_GITHUB_TOKEN = ['fixture', 'not', 'a', 'real', 'github', 'credential'].join('-');
const SUPPORTED_NODE_VERSION = '22.12.0';
const FAKE_BASE_DIRECTORY = '/fake/leverframe-home/copilot';
const FAKE_WORKING_DIRECTORY = '/fake/leverframe-home/copilot/workspace';

function fakeClient(overrides: Partial<CopilotRuntimeClient>): CopilotRuntimeClient {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => [] as Error[]),
    forceStop: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    createSession: vi.fn(async () => ({})),
    ...overrides,
  };
}

function fakeSdkModule(): { sdk: CopilotSdkModule; forStdioCalls: unknown[][] } {
  const forStdioCalls: unknown[][] = [];
  const sdk: CopilotSdkModule = {
    CopilotClient: class {
      async start(): Promise<void> {}
      async stop(): Promise<Error[]> { return []; }
      async forceStop(): Promise<void> {}
      async listModels(): Promise<unknown> { return []; }
    },
    RuntimeConnection: {
      forStdio: (...args: unknown[]) => {
        forStdioCalls.push(args);
        return { kind: 'stdio' };
      },
    },
  };
  return { sdk, forStdioCalls };
}

function buildConfig(overrides: Partial<CopilotRuntimeConfig>): CopilotRuntimeConfig {
  const { sdk } = fakeSdkModule();
  return {
    gitHubToken: FAKE_GITHUB_TOKEN,
    nodeVersion: SUPPORTED_NODE_VERSION,
    baseDirectory: FAKE_BASE_DIRECTORY,
    workingDirectory: FAKE_WORKING_DIRECTORY,
    environment: {
      PATH: '/fixture/bin',
      GH_TOKEN: ['fixture', 'ambient', 'gh'].join('-'),
      GITHUB_TOKEN: ['fixture', 'ambient', 'github'].join('-'),
      GH_ENTERPRISE_TOKEN: ['fixture', 'ambient', 'enterprise'].join('-'),
      GITHUB_ENTERPRISE_TOKEN: ['fixture', 'ambient', 'github-enterprise'].join('-'),
      COPILOT_GITHUB_TOKEN: ['fixture', 'ambient', 'copilot'].join('-'),
      COPILOT_CLI_PATH: '/fixture/untrusted-copilot',
      COPILOT_HOME: '/fixture/ambient-home',
      COPILOT_API_TOKEN: ['fixture', 'ambient', 'api'].join('-'),
    },
    moduleLoader: vi.fn(async () => sdk),
    clientFactory: vi.fn(() => fakeClient({})),
    ...overrides,
  };
}

describe('isCopilotSupportedNodeVersion', () => {
  it.each([
    '20.19.0', '20.19.1', '20.99.99', 'v20.19.0',
    '22.12.0', '22.12.1', '22.99.0', '23.0.0', '24.5.2', 'v22.12.0',
  ])('accepts %s as within the package-declared ^20.19.0 || >=22.12.0 range', version => {
    expect(isCopilotSupportedNodeVersion(version)).toBe(true);
  });

  it.each([
    '20.18.9', '20.0.0', '19.9.9', '21.0.0', '21.99.99',
    '22.0.0', '22.11.99', 'v18.20.4',
  ])('rejects %s as outside the package-declared ^20.19.0 || >=22.12.0 range', version => {
    expect(isCopilotSupportedNodeVersion(version)).toBe(false);
  });

  it('raises rather than silently defaulting on an unparseable version string', () => {
    expect(() => isCopilotSupportedNodeVersion('not-a-version')).toThrow();
  });
});

describe('resolveCopilotDirectories', () => {
  it('roots both the base and working directory under the Leverframe app home', () => {
    const env = { LEVERFRAME_HOME: '/fake/leverframe-home' };
    const { baseDirectory, workingDirectory } = resolveCopilotDirectories(env);
    const home = getAppHome(env);

    expect(baseDirectory.startsWith(home)).toBe(true);
    expect(workingDirectory.startsWith(home)).toBe(true);
    expect(baseDirectory).not.toBe(workingDirectory);
  });

  it('follows LEVERFRAME_HOME overrides like every other Leverframe path helper', () => {
    const homeA = resolveCopilotDirectories({ LEVERFRAME_HOME: '/fake/home-a' });
    const homeB = resolveCopilotDirectories({ LEVERFRAME_HOME: '/fake/home-b' });

    expect(homeA.baseDirectory).not.toBe(homeB.baseDirectory);
    expect(homeA.workingDirectory).not.toBe(homeB.workingDirectory);
  });
});

describe('lazy loading of the Copilot SDK', () => {
  it('does not invoke the injected module loader when the runtime is only constructed', () => {
    const config = buildConfig({});

    createCopilotRuntime(config);

    expect(config.moduleLoader).not.toHaveBeenCalled();
  });

  it('never touches the module loader or client factory for a runtime that never calls start()', async () => {
    const config = buildConfig({});
    const runtime = createCopilotRuntime(config);

    await Promise.resolve();

    expect(config.moduleLoader).not.toHaveBeenCalled();
    expect(config.clientFactory).not.toHaveBeenCalled();
    expect(runtime).toBeDefined();
  });

  it('invokes the injected module loader exactly once when start() runs', async () => {
    const config = buildConfig({});
    const runtime = createCopilotRuntime(config);

    await runtime.start();

    expect(config.moduleLoader).toHaveBeenCalledTimes(1);
    expect(config.moduleLoader).toHaveBeenCalledWith();
  });
});

describe('Node version gate', () => {
  it('rejects start() below the supported range without loading the SDK', async () => {
    const config = buildConfig({ nodeVersion: '18.20.4' });
    const runtime = createCopilotRuntime(config);

    await expect(runtime.start()).rejects.toBeInstanceOf(CopilotUnsupportedNodeVersionError);
    expect(config.moduleLoader).not.toHaveBeenCalled();
    expect(config.clientFactory).not.toHaveBeenCalled();
  });

  it('rejects start() in the unsupported gap between the two ranges', async () => {
    const config = buildConfig({ nodeVersion: '21.5.0' });
    const runtime = createCopilotRuntime(config);

    await expect(runtime.start()).rejects.toBeInstanceOf(CopilotUnsupportedNodeVersionError);
    expect(config.moduleLoader).not.toHaveBeenCalled();
  });

  it.each(['20.19.0', '22.12.0'])('accepts start() at the %s range boundary', async version => {
    const config = buildConfig({ nodeVersion: version });
    const runtime = createCopilotRuntime(config);

    await expect(runtime.start()).resolves.toBeUndefined();
  });
});

describe('CopilotClient construction: fixed request shape', () => {
  it('builds mode empty, a stdio connection, disabled logged-in user, log level none, and no telemetry content capture', async () => {
    const { sdk, forStdioCalls } = fakeSdkModule();
    let captured: CopilotClientConstructOptions | undefined;
    const config = buildConfig({
      moduleLoader: vi.fn(async () => sdk),
      clientFactory: vi.fn((_sdk, options) => {
        captured = options;
        return fakeClient({});
      }),
    });

    await createCopilotRuntime(config).start();

    expect(forStdioCalls).toEqual([[]]);
    expect(captured).toEqual({
      connection: { kind: 'stdio' },
      mode: 'empty',
      gitHubToken: FAKE_GITHUB_TOKEN,
      useLoggedInUser: false,
      baseDirectory: FAKE_BASE_DIRECTORY,
      workingDirectory: FAKE_WORKING_DIRECTORY,
      logLevel: 'none',
      telemetry: { captureContent: false },
      sessionFs: {
        initialCwd: FAKE_WORKING_DIRECTORY,
        sessionStatePath: '/session',
        conventions: 'posix',
        capabilities: { sqlite: false },
      },
      env: { PATH: '/fixture/bin' },
    });
  });
});

describe('CopilotClient construction: connection and token passthrough', () => {
  it('passes through the exact object RuntimeConnection.forStdio() returned as the connection', async () => {
    const stdioConnection = { kind: 'stdio' as const };
    const sdk: CopilotSdkModule = {
      CopilotClient: class {
      async start(): Promise<void> {}
      async stop(): Promise<Error[]> { return []; }
      async forceStop(): Promise<void> {}
      async listModels(): Promise<unknown> { return []; }
    },
      RuntimeConnection: { forStdio: vi.fn(() => stdioConnection) },
    };
    let capturedConnection: unknown;
    const config = buildConfig({
      moduleLoader: vi.fn(async () => sdk),
      clientFactory: vi.fn((_sdk, options) => {
        capturedConnection = options.connection;
        return fakeClient({});
      }),
    });

    await createCopilotRuntime(config).start();

    expect(capturedConnection).toBe(stdioConnection);
  });

  it('sends the token only through the SDK gitHubToken option', async () => {
    const otherFixtureToken = ['fixture', 'second', 'not', 'a', 'real', 'credential'].join('-');
    let captured: CopilotClientConstructOptions | undefined;
    const config = buildConfig({
      gitHubToken: otherFixtureToken,
      clientFactory: vi.fn((_sdk, options) => {
        captured = options;
        return fakeClient({});
      }),
    });

    await createCopilotRuntime(config).start();

    expect(captured?.gitHubToken).toBe(otherFixtureToken);
  });
});

describe('Copilot SDK module validation', () => {
  it('accepts the pinned SDK surface without cloning it', () => {
    const { sdk } = fakeSdkModule();

    expect(validateCopilotSdkModule(sdk)).toBe(sdk);
  });

  it.each([
    null,
    {},
    { CopilotClient: class {} },
    { CopilotClient: class {}, RuntimeConnection: {} },
  ])('rejects an incompatible optional SDK module %#', module => {
    expect(() => validateCopilotSdkModule(module))
      .toThrow(CopilotSdkIncompatibleError);
  });
});

describe('absent SDK module', () => {
  it('surfaces a single actionable install command when the loader reports the module is missing', async () => {
    const notFound = Object.assign(
      new Error(`Cannot find package '${COPILOT_SDK_PACKAGE}'`),
      { code: 'ERR_MODULE_NOT_FOUND' },
    );
    const config = buildConfig({ moduleLoader: vi.fn(async () => { throw notFound; }) });
    const runtime = createCopilotRuntime(config);

    await expect(runtime.start()).rejects.toBeInstanceOf(CopilotSdkNotInstalledError);
    await expect(createCopilotRuntime(config).start()).rejects.toThrow(
      new RegExp(`npm install ${COPILOT_SDK_PACKAGE.replace('/', '\\/')}`),
    );
  });

  it('mentions the install command exactly once', async () => {
    const notFound = Object.assign(new Error('module not found'), { code: 'ERR_MODULE_NOT_FOUND' });
    const config = buildConfig({ moduleLoader: vi.fn(async () => { throw notFound; }) });

    let caught: Error | undefined;
    try {
      await createCopilotRuntime(config).start();
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeDefined();
    const installCommand = `npm install ${COPILOT_SDK_PACKAGE}`;
    const occurrences = (caught?.message ?? '').split(installCommand).length - 1;
    expect(occurrences).toBe(1);
  });

  it('does not reinterpret an unrelated loader failure as a missing-SDK error', async () => {
    const unrelatedFailure = new Error('loader crashed for an unrelated reason');
    const config = buildConfig({ moduleLoader: vi.fn(async () => { throw unrelatedFailure; }) });

    await expect(createCopilotRuntime(config).start()).rejects.toBe(unrelatedFailure);
  });
});
