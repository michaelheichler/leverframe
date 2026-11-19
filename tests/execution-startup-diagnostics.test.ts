import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { expect, it, vi } from 'vitest';
import { getExecutionsRoot } from '../src/checkpoint-store.js';
import { beginExecutionTracking } from '../src/execution-tracking.js';
import { startProxyCatalog } from '../src/proxy.js';
import { createModelCatalog } from '../src/server/models.js';
import { startServer } from '../src/server/router.js';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, readdirSync: vi.fn(fs.readdirSync) };
});

function startProxy(debug: boolean, logPath: string) {
  const route = {
    aliasId: 'fixture',
    realModelId: 'fixture',
    displayName: 'Fixture',
    upstreamUrl: 'http://127.0.0.1:1',
    apiKey: 'fixture',
    modelFormat: 'anthropic' as const,
  };
  return startProxyCatalog([route], route.aliasId, debug, undefined, logPath);
}

function startGateway(debug: boolean, logPath: string) {
  return startServer({
    host: '127.0.0.1',
    port: 0,
    apiKey: 'fixture',
    serverPassword: null,
    catalog: createModelCatalog([]),
    ...(debug ? { debugLogPath: logPath } : {}),
  });
}

function seedUnconfirmedToolCall(): void {
  const execution = beginExecutionTracking({
    sessionKey: 'startup-diagnostics-fixture',
    requestId: 'fixture-request',
    provider: 'anthropic',
    model: 'fixture',
    route: 'passthrough',
    messages: [{ role: 'user', content: 'Fixture prompt' }],
  });
  execution.observeNonStreamAnthropic({
    content: [{ type: 'tool_use', id: 'fixture-call', name: 'fixture_tool', input: {} }],
  });
}

const startCases = [
  { mode: 'proxy', start: startProxy },
  { mode: 'gateway', start: startGateway },
];

function fixturePaths() {
  const appHome = process.env.LEVERFRAME_TEST_HOME!;
  expect(process.env.LEVERFRAME_HOME).toBe(appHome);
  expect(appHome).toBe(join(process.env.HOME!, 'leverframe'));
  const executionRoot = getExecutionsRoot();
  const relativeRoot = relative(appHome, executionRoot);
  expect(isAbsolute(relativeRoot)).toBe(false);
  expect(relativeRoot).not.toBe('..');
  expect(relativeRoot.startsWith(`..${sep}`)).toBe(false);
  return { executionRoot, logPath: join(appHome, 'startup-diagnostics.log') };
}

it.each(startCases)('starts the $mode without reading execution history in ordinary mode', async ({ start }) => {
  const { executionRoot, logPath } = fixturePaths();
  seedUnconfirmedToolCall();
  const directoryReads = vi.mocked(readdirSync);
  directoryReads.mockClear();

  const handle = await start(false, logPath);
  try {
    expect(directoryReads.mock.calls.filter(([path]) => path === executionRoot)).toEqual([]);
  } finally {
    await handle.close();
  }
});

it.each(startCases)('reports unconfirmed executions at $mode startup with debug enabled', async ({ start }) => {
  const { logPath } = fixturePaths();
  seedUnconfirmedToolCall();

  const handle = await start(true, logPath);
  try {
    expect(readFileSync(logPath, 'utf8')).toMatch(/execution reconciliation: \d+ execution\(s\)/);
  } finally {
    await handle.close();
  }
});
