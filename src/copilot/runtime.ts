/**
 * Owns the optional Copilot SDK process boundary.
 * Construction is inert so non-Copilot providers never load the SDK or its platform runtime.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getAppHome } from '../paths.js';

export const COPILOT_SDK_PACKAGE = '@github/copilot-sdk';

/** Gives one install command only when the optional package cannot be resolved. */

export class CopilotSdkNotInstalledError extends Error {
  constructor(cause: unknown) {
    super(`GitHub Copilot support is not installed. Run: npm install ${COPILOT_SDK_PACKAGE}`, {
      cause,
    });
    this.name = 'CopilotSdkNotInstalledError';
  }
}

/** Reports optional SDK versions that lack the required public surface. */
export class CopilotSdkIncompatibleError extends Error {
  constructor() {
    super(`Installed ${COPILOT_SDK_PACKAGE} is incompatible. Install ${COPILOT_SDK_PACKAGE}@1.0.9`);
    this.name = 'CopilotSdkIncompatibleError';
  }
}

export class CopilotUnsupportedNodeVersionError extends Error {
  constructor(version: string) {
    super(
      `GitHub Copilot requires Node.js ^20.19.0 or >=22.12.0; current version is ${version}`,
    );
    this.name = 'CopilotUnsupportedNodeVersionError';
  }
}

export interface CopilotClientConstructOptions {
  connection: object;
  mode: 'empty';
  gitHubToken: string;
  useLoggedInUser: false;
  baseDirectory: string;
  workingDirectory: string;
  logLevel: 'none';
  telemetry: { captureContent: false };
  sessionFs: {
    initialCwd: string;
    sessionStatePath: '/session';
    conventions: 'posix';
    capabilities: { sqlite: false };
  };
  env: Record<string, string | undefined>;
}

export interface CopilotRuntimeClient {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  forceStop(): Promise<void>;
  listModels(): Promise<unknown>;
  createSession?(config: unknown): Promise<unknown>;
}

export interface CopilotSdkModule {
  CopilotClient: new (options: CopilotClientConstructOptions) => CopilotRuntimeClient;
  RuntimeConnection: {
    forStdio(): object;
  };
}

/** Validates the small SDK surface used before constructing a runtime client. */
export function validateCopilotSdkModule(value: unknown): CopilotSdkModule {
  if (value === null || typeof value !== 'object') {
    throw new CopilotSdkIncompatibleError();
  }
  const module = value as Record<string, unknown>;
  const connection = module.RuntimeConnection;
  if (
    typeof module.CopilotClient !== 'function'
    || connection === null
    || typeof connection !== 'object'
    || typeof (connection as Record<string, unknown>).forStdio !== 'function'
  ) {
    throw new CopilotSdkIncompatibleError();
  }
  return value as CopilotSdkModule;
}

export type CopilotSdkModuleLoader = () => Promise<unknown>;
export type CopilotClientFactory = (
  sdk: CopilotSdkModule,
  options: CopilotClientConstructOptions,
) => CopilotRuntimeClient;

export interface CopilotRuntimeConfig {
  gitHubToken: string;
  nodeVersion: string;
  baseDirectory: string;
  workingDirectory: string;
  environment: NodeJS.ProcessEnv;
  moduleLoader: CopilotSdkModuleLoader;
  clientFactory: CopilotClientFactory;
}

export interface CopilotRuntimeHandle {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  forceStop(): Promise<void>;
  listModels(): Promise<unknown>;
  createSession(config: unknown): Promise<unknown>;
}

function parseNodeVersion(version: string): { major: number; minor: number; patch: number } {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) {
    throw new TypeError(`Invalid Node.js version: ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Checks the exact Node.js range declared by the pinned Copilot SDK. */
export function isCopilotSupportedNodeVersion(version: string): boolean {
  const parsed = parseNodeVersion(version);
  if (parsed.major === 20) return parsed.minor >= 19;
  if (parsed.major === 22) return parsed.minor >= 12;
  return parsed.major > 22;
}

/** Resolves runtime data under Leverframe's configurable application home. */
export function resolveCopilotDirectories(env: NodeJS.ProcessEnv): {
  baseDirectory: string;
  workingDirectory: string;
} {
  const runtimeHome = join(getAppHome(env), 'copilot');
  return {
    baseDirectory: runtimeHome,
    workingDirectory: join(runtimeHome, 'workspace'),
  };
}

function isModuleNotFound(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'ERR_MODULE_NOT_FOUND';
}

const GITHUB_CREDENTIAL_ENV_NAMES = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
]);

/** Removes ambient auth and Copilot controls before the SDK injects owned settings. */
function runtimeEnvironment(environment: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => (
      !name.startsWith('COPILOT_') && !GITHUB_CREDENTIAL_ENV_NAMES.has(name)
    )),
  );
}

function clientOptions(config: CopilotRuntimeConfig, sdk: CopilotSdkModule): CopilotClientConstructOptions {
  return {
    connection: sdk.RuntimeConnection.forStdio(),
    mode: 'empty',
    gitHubToken: config.gitHubToken,
    useLoggedInUser: false,
    baseDirectory: config.baseDirectory,
    workingDirectory: config.workingDirectory,
    logLevel: 'none',
    telemetry: { captureContent: false },
    sessionFs: {
      initialCwd: config.workingDirectory,
      sessionStatePath: '/session',
      conventions: 'posix',
      capabilities: { sqlite: false },
    },
    env: runtimeEnvironment(config.environment),
  };
}

async function loadCopilotSdk(moduleLoader: CopilotSdkModuleLoader): Promise<CopilotSdkModule> {
  try {
    return validateCopilotSdkModule(await moduleLoader());
  } catch (error) {
    if (isModuleNotFound(error)) throw new CopilotSdkNotInstalledError(error);
    throw error;
  }
}

export function createCopilotRuntime(config: CopilotRuntimeConfig): CopilotRuntimeHandle {
  let client: CopilotRuntimeClient | undefined;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<Error[]> | undefined;
  let stopErrors: Error[] | undefined;
  let stopSettled = false;
  let forceStopPromise: Promise<void> | undefined;
  let disposed = false;

  const start = async (): Promise<void> => {
    if (disposed) throw new Error('Copilot runtime has already been disposed');
    if (startPromise !== undefined) return startPromise;
    startPromise = (async () => {
      if (!isCopilotSupportedNodeVersion(config.nodeVersion)) {
        throw new CopilotUnsupportedNodeVersionError(config.nodeVersion);
      }
      const sdk = await loadCopilotSdk(config.moduleLoader);
      if (disposed) throw new Error('Copilot runtime was disposed during startup');
      client = config.clientFactory(sdk, clientOptions(config, sdk));
      await client.start();
      if (disposed) throw new Error('Copilot runtime was disposed during startup');
    })();
    return startPromise;
  };

  const stop = async (): Promise<Error[]> => {
    if (stopPromise !== undefined) return stopPromise;
    disposed = true;
    stopPromise = (async () => {
      if (startPromise !== undefined) {
        try {
          await startPromise;
        } catch {
          // Startup failure is returned to its caller. Cleanup still owns any created client.
        }
      }
      return client === undefined ? [] : client.stop();
    })().then(
      errors => {
        stopErrors = errors;
        stopSettled = true;
        return errors;
      },
      error => {
        stopSettled = true;
        throw error;
      },
    );
    return stopPromise;
  };

  const activeClient = async (): Promise<CopilotRuntimeClient> => {
    await start();
    if (client === undefined) throw new Error('Copilot runtime client did not start');
    return client;
  };

  const listModels = async (): Promise<unknown> => (await activeClient()).listModels();

  const createSession = async (sessionConfig: unknown): Promise<unknown> => {
    const runtimeClient = await activeClient();
    if (runtimeClient.createSession === undefined) {
      throw new CopilotSdkIncompatibleError();
    }
    return runtimeClient.createSession(sessionConfig);
  };

  const forceStop = async (): Promise<void> => {
    if (forceStopPromise !== undefined) return forceStopPromise;
    const stoppedCleanly = stopSettled && stopErrors !== undefined && stopErrors.length === 0;
    if (client === undefined || stoppedCleanly) {
      disposed = true;
      forceStopPromise = Promise.resolve();
      return forceStopPromise;
    }
    disposed = true;
    forceStopPromise = client.forceStop();
    return forceStopPromise;
  };

  return { start, stop, forceStop, listModels, createSession };
}

export async function loadCopilotSdkModule(): Promise<unknown> {
  return import('@github/copilot-sdk');
}

/** Constructs the public SDK client without exposing its class to callers. */
export function createCopilotSdkClient(
  sdk: CopilotSdkModule,
  options: CopilotClientConstructOptions,
): CopilotRuntimeClient {
  return new sdk.CopilotClient(options);
}

/** Creates the production runtime handle without loading the optional SDK. */
export function createDefaultCopilotRuntime(input: {
  gitHubToken: string;
  nodeVersion: string;
  environment: NodeJS.ProcessEnv;
}): CopilotRuntimeHandle {
  const directories = resolveCopilotDirectories(input.environment);
  mkdirSync(directories.workingDirectory, { recursive: true, mode: 0o700 });
  return createCopilotRuntime({
    gitHubToken: input.gitHubToken,
    nodeVersion: input.nodeVersion,
    baseDirectory: directories.baseDirectory,
    workingDirectory: directories.workingDirectory,
    environment: input.environment,
    moduleLoader: loadCopilotSdkModule,
    clientFactory: createCopilotSdkClient,
  });
}
