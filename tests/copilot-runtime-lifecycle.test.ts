/**
 * Specifies Copilot runtime shutdown, escalation, and startup race behavior.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createCopilotRuntime,
  type CopilotRuntimeClient,
  type CopilotRuntimeConfig,
  type CopilotSdkModule,
} from '../src/copilot/runtime.js';

function fakeClient(overrides: Partial<CopilotRuntimeClient>): CopilotRuntimeClient {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => []),
    forceStop: vi.fn(async () => undefined),
    listModels: vi.fn(async () => []),
    createSession: vi.fn(async () => ({})),
    ...overrides,
  };
}

function fakeSdkModule(): CopilotSdkModule {
  return {
    CopilotClient: class {
      async start(): Promise<void> {}
      async stop(): Promise<Error[]> { return []; }
      async forceStop(): Promise<void> {}
      async listModels(): Promise<unknown> { return []; }
    },
    RuntimeConnection: {
      forStdio: () => ({ kind: 'stdio' }),
    },
  };
}

function buildConfig(input: {
  client: CopilotRuntimeClient;
  moduleLoader?: CopilotRuntimeConfig['moduleLoader'];
}): CopilotRuntimeConfig {
  return {
    gitHubToken: ['fixture', 'github', 'credential'].join('-'),
    nodeVersion: '22.12.0',
    baseDirectory: '/fixture/copilot',
    workingDirectory: '/fixture/copilot/workspace',
    environment: { PATH: '/fixture/bin' },
    moduleLoader: input.moduleLoader ?? vi.fn(async () => fakeSdkModule()),
    clientFactory: vi.fn(() => input.client),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>(resolver => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe('Copilot runtime stop', () => {
  it('returns the exact error array the underlying client reports', async () => {
    const stopErrors = [new Error('session close failed'), new Error('process kill failed')];
    const client = fakeClient({ stop: vi.fn(async () => stopErrors) });
    const runtime = createCopilotRuntime(buildConfig({ client }));
    await runtime.start();

    await expect(runtime.stop()).resolves.toBe(stopErrors);
  });

  it('returns an empty array when cleanup fully succeeds', async () => {
    const client = fakeClient({ stop: vi.fn(async () => []) });
    const runtime = createCopilotRuntime(buildConfig({ client }));
    await runtime.start();

    await expect(runtime.stop()).resolves.toEqual([]);
  });

  it('returns an empty array without constructing a client before start', async () => {
    const client = fakeClient({});
    const config = buildConfig({ client });
    const runtime = createCopilotRuntime(config);

    await expect(runtime.stop()).resolves.toEqual([]);
    expect(config.clientFactory).not.toHaveBeenCalled();
  });

  it('calls the underlying client once across repeated stop calls', async () => {
    const clientStop = vi.fn(async () => [] as Error[]);
    const client = fakeClient({ stop: clientStop });
    const runtime = createCopilotRuntime(buildConfig({ client }));
    await runtime.start();

    await runtime.stop();
    await runtime.stop();

    expect(clientStop).toHaveBeenCalledTimes(1);
  });
});

describe('Copilot runtime force stop', () => {
  it('does not construct a client before start', async () => {
    const client = fakeClient({});
    const config = buildConfig({ client });
    const runtime = createCopilotRuntime(config);

    await expect(runtime.forceStop()).resolves.toBeUndefined();
    expect(config.clientFactory).not.toHaveBeenCalled();
  });

  it('delegates once when the client is active', async () => {
    const clientForceStop = vi.fn(async () => undefined);
    const client = fakeClient({ forceStop: clientForceStop });
    const runtime = createCopilotRuntime(buildConfig({ client }));
    await runtime.start();

    await runtime.forceStop();
    await runtime.forceStop();

    expect(clientForceStop).toHaveBeenCalledTimes(1);
  });

  it('does not force stop after a successful graceful stop', async () => {
    const clientForceStop = vi.fn(async () => undefined);
    const client = fakeClient({ forceStop: clientForceStop });
    const runtime = createCopilotRuntime(buildConfig({ client }));
    await runtime.start();

    await runtime.stop();
    await runtime.forceStop();

    expect(clientForceStop).not.toHaveBeenCalled();
  });

  it('escalates after graceful stop reports cleanup errors', async () => {
    const clientForceStop = vi.fn(async () => undefined);
    const client = fakeClient({
      stop: vi.fn(async () => [new Error('runtime still active')]),
      forceStop: clientForceStop,
    });
    const runtime = createCopilotRuntime(buildConfig({ client }));
    await runtime.start();

    await runtime.stop();
    await runtime.forceStop();

    expect(clientForceStop).toHaveBeenCalledTimes(1);
  });


  it('escalates after graceful stop rejects', async () => {
    const clientForceStop = vi.fn(async () => undefined);
    const client = fakeClient({
      stop: vi.fn(async () => { throw new Error('graceful stop rejected'); }),
      forceStop: clientForceStop,
    });
    const runtime = createCopilotRuntime(buildConfig({ client }));
    await runtime.start();

    await expect(runtime.stop()).rejects.toThrow(/graceful stop rejected/);
    await runtime.forceStop();

    expect(clientForceStop).toHaveBeenCalledTimes(1);
  });


  it('escalates while graceful stop is still pending', async () => {
    const stopped = deferred<Error[]>();
    const clientForceStop = vi.fn(async () => undefined);
    const client = fakeClient({
      stop: vi.fn(() => stopped.promise),
      forceStop: clientForceStop,
    });
    const runtime = createCopilotRuntime(buildConfig({ client }));
    await runtime.start();

    const stopping = runtime.stop();
    await vi.waitFor(() => expect(client.stop).toHaveBeenCalledTimes(1));
    await runtime.forceStop();
    stopped.resolve([]);
    await stopping;

    expect(clientForceStop).toHaveBeenCalledTimes(1);
  });
});

describe('Copilot runtime startup races', () => {
  it('does not create a client when stop wins during SDK loading', async () => {
    const sdk = deferred<CopilotSdkModule>();
    const client = fakeClient({});
    const config = buildConfig({
      client,
      moduleLoader: vi.fn(() => sdk.promise),
    });
    const runtime = createCopilotRuntime(config);
    const starting = runtime.start();
    await vi.waitFor(() => expect(config.moduleLoader).toHaveBeenCalledTimes(1));

    const stopping = runtime.stop();
    sdk.resolve(fakeSdkModule());

    await expect(starting).rejects.toThrow(/disposed/);
    await expect(stopping).resolves.toEqual([]);
    expect(config.clientFactory).not.toHaveBeenCalled();
  });

  it('stops a client when stop wins during client startup', async () => {
    const started = deferred<void>();
    const clientStop = vi.fn(async () => [] as Error[]);
    const client = fakeClient({
      start: vi.fn(() => started.promise),
      stop: clientStop,
    });
    const runtime = createCopilotRuntime(buildConfig({ client }));
    const starting = runtime.start();
    await vi.waitFor(() => expect(client.start).toHaveBeenCalledTimes(1));

    const stopping = runtime.stop();
    started.resolve(undefined);

    await expect(starting).rejects.toThrow(/disposed/);
    await expect(stopping).resolves.toEqual([]);
    expect(clientStop).toHaveBeenCalledTimes(1);
  });
});
