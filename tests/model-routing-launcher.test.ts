import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  launchClaude: vi.fn(async (_input: { env: NodeJS.ProcessEnv; model?: string; extraArgs?: string[] }) => 0),
  startConfiguredHttpProxy: vi.fn(),
  runLaunchPatchCheck: vi.fn(async () => undefined),
  writeProxyLifecycleLog: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock('../src/launch.js', () => ({ launchClaude: mocks.launchClaude }));
vi.mock('../src/http-proxy/index.js', () => ({
  loadHttpProxyRoutes: vi.fn(),
  printHttpProxyModels: vi.fn(),
  reportSkippedHttpProxyFavorites: vi.fn(),
  startConfiguredHttpProxy: mocks.startConfiguredHttpProxy,
}));
vi.mock('../src/patcher.js', () => ({ runLaunchPatchCheck: mocks.runLaunchPatchCheck }));
vi.mock('../src/trace-log.js', () => ({
  printTraceLog: vi.fn(),
  writeProxyLifecycleLog: mocks.writeProxyLifecycleLog,
}));
vi.mock('@clack/prompts', () => ({ log: { error: mocks.logError, info: mocks.logInfo } }));

import { runClaudeHttpProxyCommand } from '../src/claude-http-launch.js';
import { withProxyAnthropicOriginSettings } from '../src/env.js';
import { ROUTING_ACTIVE_ENV, ROUTING_ACTIVE_VALUE } from '../src/constants.js';
import type { ClaudeInstallation } from '../src/claude-installation.js';
import type { HttpProxyHandle } from '../src/http-proxy/server.js';

const installationPath = '/tmp/leverframe-claude-launch-fixture';
const installation: ClaudeInstallation = {
  logicalPath: installationPath,
  canonicalPath: installationPath,
  installationPath,
  discoverySource: 'explicit-target',
  installationKind: 'custom',
  identity: createHash('sha256').update(installationPath).digest('hex'),
  version: '2.1.314',
  executableType: 'binary',
};
const activeHandle = {
  host: '127.0.0.1',
  port: 43_123,
  caCertPath: '/tmp/leverframe-test-ca.pem',
  token: 'fixture-launch-proxy-token',
  modelIds: [],
  inferenceLogPath: '/tmp/leverframe-inference.jsonl',
  routingEnabled: true as const,
  routingVisibleModelId: 'fixture-router-choice',
  close: vi.fn(async () => undefined),
} satisfies HttpProxyHandle;
const inactiveHandle = { ...activeHandle, routingEnabled: undefined } as unknown as HttpProxyHandle;
const recoveryHandle = { ...inactiveHandle, routingRecoveryOnly: true } as HttpProxyHandle;
const loaded = {
  providers: [],
  routes: [],
  aliases: [],
  favoriteCount: 0,
  freshUnavailable: [],
  routingEvidence: { config: { enabled: true, visibleModelId: 'fixture-router-choice' } },
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function runLaunch(handle: HttpProxyHandle, claudeArgs: string[]) {
  mocks.startConfiguredHttpProxy.mockResolvedValue({ handle, loaded });
  return runClaudeHttpProxyCommand({
    installation,
    parsed: { command: 'claude', showHelp: false, showVersion: false, dryRun: false, trace: false, claudeArgs: [] },
    claudeArgs,
    agentStdout: true,
  });
}

it.each(['auto', 'fixture-router-choice'])('launches with visible routing model %s only when routing is active', async visibleModelId => {
  const args = ['--print', 'Synthetic task'];
  const handle = { ...activeHandle, routingVisibleModelId: visibleModelId };
  vi.stubEnv(ROUTING_ACTIVE_ENV, undefined);

  const exitCode = await runLaunch(handle, args);

  expect(exitCode).toBe(0);
  expect(mocks.launchClaude).toHaveBeenCalledTimes(1);
  expect(mocks.launchClaude).toHaveBeenCalledWith(expect.objectContaining({
    model: visibleModelId,
    extraArgs: withProxyAnthropicOriginSettings(args),
  }));
  expect(mocks.launchClaude.mock.calls[0]?.[0].env).toHaveProperty(ROUTING_ACTIVE_ENV, ROUTING_ACTIVE_VALUE);
});

it.each([
  { label: 'disabled', handle: inactiveHandle },
  { label: 'recovery-only', handle: recoveryHandle },
])('clears inherited routing activation for a $label launch', async ({ handle }) => {
  const args = ['--print', 'Synthetic task'];
  vi.stubEnv(ROUTING_ACTIVE_ENV, ROUTING_ACTIVE_VALUE);

  const exitCode = await runLaunch(handle, args);

  expect(exitCode).toBe(0);
  expect(mocks.launchClaude).toHaveBeenCalledTimes(1);
  expect(mocks.launchClaude).toHaveBeenCalledWith(expect.objectContaining({
    model: undefined,
    extraArgs: withProxyAnthropicOriginSettings(args),
  }));
  expect(mocks.launchClaude.mock.calls[0]?.[0].env).not.toHaveProperty(ROUTING_ACTIVE_ENV);
});

it.each([
  { label: 'separate model option', args: ['--model', 'another-model'] },
  { label: 'inline model option', args: ['--model=another-model'] },
])('rejects a user supplied $label when routing selects the visible model', async ({ args }) => {
  const exitCode = await runLaunch(activeHandle, args);

  expect(exitCode).not.toBe(0);
  expect(mocks.launchClaude).not.toHaveBeenCalled();
});
