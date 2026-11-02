import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProvidersAdd } from '../src/providers-command-crud.js';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';
import type { RegistryProvider } from '../src/registry/types.js';

const selectMock = vi.hoisted(() => vi.fn());

vi.mock('@clack/prompts', async importOriginal => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return { ...actual, select: selectMock };
});

const previousHome = process.env.LEVERFRAME_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-add-provider-account-'));
  process.env.LEVERFRAME_HOME = home;
  selectMock.mockReset();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function provider(id: string, templateId: string, name: string, authType: 'api' | 'oauth' | 'none', accountId: string): RegistryProvider {
  return {
    id, templateId, name, enabled: true, authType,
    authRef: authType === 'none' ? 'none:anonymous' : `keyring:provider:${id}`,
    api: { npm: '@ai-sdk/openai' },
    addedAt: new Date().toISOString(),
    accounts: [{ id: accountId, authRef: authType === 'none' ? 'none:anonymous' : `keyring:provider:${id}:${accountId}`, enabled: true }],
  };
}

describe('adding accounts to configured providers', () => {
  it('offers additional account choices while keeping unrelated providers available', async () => {
    const registry = emptyRegistry();
    registry.providers.push(
      provider('anthropic-api', 'anthropic-api', 'Billing API', 'api', 'work'),
      provider('openai-oauth', 'openai', 'ChatGPT OAuth', 'oauth', 'chat'),
    );
    saveRegistry(registry);
    selectMock.mockResolvedValue('noop');

    await runProvidersAdd();

    const options = selectMock.mock.calls[0]?.[0].options.map((option: { value: string }) => option.value);
    expect(options).toContain('account:anthropic-api');
    expect(options).toContain('account:openai-oauth');
    expect(options).toContain('api:openai');
  });

  it('opens account management for an existing provider', async () => {
    const registry = emptyRegistry();
    registry.providers.push(provider('anthropic-api', 'anthropic-api', 'Billing API', 'api', 'work'));
    saveRegistry(registry);
    selectMock.mockResolvedValueOnce('account:anthropic-api').mockResolvedValueOnce('back');

    await runProvidersAdd();

    expect(selectMock.mock.calls.map(call => call[0]?.message)).toContain('Manage accounts');
    expect(loadRegistry().providers).toEqual(registry.providers);
  });

  it('offers account management for a named provider with anonymous authentication', async () => {
    const registry = emptyRegistry();
    registry.providers.push(provider('custom-local', 'custom-openai', 'Local endpoint', 'none', 'local'));
    saveRegistry(registry);
    selectMock.mockResolvedValue('noop');

    await runProvidersAdd();

    const options = selectMock.mock.calls[0]?.[0].options.map((option: { value: string }) => option.value);
    expect(options).toContain('account:custom-local');
  });

  it('offers account choices for every configured provider type', async () => {
    const registry = emptyRegistry();
    registry.providers.push(
      provider('anthropic-api', 'anthropic-api', 'Billing API', 'api', 'work'),
      provider('openai-oauth', 'openai', 'ChatGPT OAuth', 'oauth', 'chat'),
      provider('kimi', 'kimi', 'Kimi', 'api', 'main'),
      provider('opencode-go', 'opencode-go', 'OpenCode Go', 'api', 'main'),
      provider('github-copilot', 'github-copilot', 'GitHub Copilot', 'oauth', 'main'),
      provider('antigravity', 'antigravity', 'Antigravity', 'oauth', 'main'),
      provider('custom-local', 'custom-openai', 'Local endpoint', 'none', 'local'),
    );
    saveRegistry(registry);
    selectMock.mockResolvedValue('noop');

    await runProvidersAdd();

    const options = selectMock.mock.calls[0]?.[0].options.map((option: { value: string }) => option.value);
    expect(options).toEqual(expect.arrayContaining([
      'account:anthropic-api', 'account:openai-oauth', 'account:kimi', 'account:opencode-go',
      'account:github-copilot', 'account:antigravity', 'account:custom-local',
    ]));
  });
});
