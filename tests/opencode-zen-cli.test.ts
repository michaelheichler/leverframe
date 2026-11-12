import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';
import { tmpdir } from 'node:os';

const selectMock = vi.hoisted(() => vi.fn());
const passwordMock = vi.hoisted(() => vi.fn());

vi.mock('@clack/prompts', async importOriginal => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return { ...actual, select: selectMock, password: passwordMock };
});

import { runProvidersAdd } from '../src/providers-command.js';
import { loadRegistry } from '../src/registry/io.js';
import { getProvidersPath } from '../src/paths.js';

const previousLeverframeHome = process.env['LEVERFRAME_HOME'];
let fixtureHome: string;

beforeEach(() => {
  fixtureHome = mkdtempSync(join(tmpdir(), 'leverframe-zen-cli-'));
  process.env['LEVERFRAME_HOME'] = fixtureHome;
  selectMock.mockReset();
  passwordMock.mockReset();
});

afterEach(() => {
  if (previousLeverframeHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousLeverframeHome;
  rmSync(fixtureHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it('adds Zen free access without requesting or saving a key', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [{
    id: 'free-fixture',
    name: 'Free fixture',
    type: 'chat',
    family: 'fixture',
    cost: { text: { input: { price: 0, cache: { read: 0, write: 0 } }, output: { price: 0 } } },
    api: { 'chat-completions': { base_url: 'https://opencode.ai/inference/openai/v1' } },
  }] }));
  selectMock.mockResolvedValueOnce('api:opencode-zen').mockResolvedValueOnce('noop');
  const relativeRegistryPath = relative(resolve(fixtureHome), resolve(getProvidersPath()));
  expect(isAbsolute(relativeRegistryPath) || relativeRegistryPath === '..'
    || relativeRegistryPath.startsWith(`..${sep}`)).toBe(false);

  const result = await runProvidersAdd();

  expect(result).toBe(0);
  expect(passwordMock).not.toHaveBeenCalled();
  expect(loadRegistry().providers.find(provider => provider.id === 'opencode-zen')).toMatchObject({
    authType: 'none',
    authRef: 'none:anonymous',
    subscriptionFilter: 'free',
  });
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://opencode.ai/inference/v1/models');
});
