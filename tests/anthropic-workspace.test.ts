import { randomUUID } from 'node:crypto';
import * as clack from '@clack/prompts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as env from '../src/env.js';
import { ANTHROPIC_API_PROVIDER_ID, getTemplateById } from '../src/provider-templates.js';
import { runProvidersAdd } from '../src/providers-command.js';
import { addProviderFromTemplate } from '../src/registry/add-template.js';
import { ANTHROPIC_MODELS_PAGE_LIMIT } from '../src/registry/anthropic-model-list.js';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';
import { refreshProviderModels } from '../src/registry/refresh-models.js';

const input = vi.hoisted(() => ({ select: vi.fn(), password: vi.fn(), text: vi.fn() }));
vi.mock('@clack/prompts', async importOriginal => ({
  ...await importOriginal<typeof import('@clack/prompts')>(),
  ...input,
  isCancel: (value: unknown): value is symbol => typeof value === 'symbol',
}));

function apiTemplate(id = ANTHROPIC_API_PROVIDER_ID) {
  const template = getTemplateById(id);
  if (!template?.defaultBaseUrl) throw new Error('The provider fixture requires an API template with a base URL.');
  return { ...template, defaultBaseUrl: template.defaultBaseUrl };
}

function discoveryResponse(url: string | URL | Request): Response {
  if (String(url).includes('/organizations/workspaces')) {
    return Response.json({ data: [], has_more: false, first_id: null, last_id: null });
  }
  if (String(url).includes('/models')) {
    return Response.json({ data: [{ id: 'claude-workspace-fixture', max_input_tokens: 240_000, max_tokens: 12_000 }] });
  }
  return new Response(null, { status: 503 });
}

function workspaceRequest(key: string) {
  return [
    expect.stringMatching(/\/v1\/organizations\/workspaces\?limit=[1-9]\d*$/),
    {
      method: 'GET',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', Accept: 'application/json' },
      redirect: 'manual', signal: expect.any(AbortSignal),
    },
  ];
}

function expectAnthropicDiscovery(key: string, headers: Record<string, string> = {}, preceding: unknown[][] = []) {
  expect(vi.mocked(fetch).mock.calls).toEqual([
    ...preceding,
    [
      `${apiTemplate().defaultBaseUrl}/v1/models?limit=${ANTHROPIC_MODELS_PAGE_LIMIT}`,
      {
        method: 'GET',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', Accept: 'application/json', ...headers },
        redirect: 'manual', signal: expect.any(AbortSignal),
      },
    ],
    [expect.stringMatching(/^https:\/\//), {
      signal: expect.any(AbortSignal), headers: { Accept: 'application/json' },
    }],
  ]);
}

let home: string;
let key: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-workspace-'));
  key = randomUUID();
  vi.stubEnv('LEVERFRAME_HOME', home);
  vi.spyOn(env, 'saveProviderCredential').mockResolvedValue(true);
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => discoveryResponse(url)));
  input.select.mockReset().mockResolvedValue(`api:${ANTHROPIC_API_PROVIDER_ID}`);
  input.password.mockReset().mockResolvedValue(key);
  input.text.mockReset();
});

afterEach(async () => {
  await new Promise<void>(resolve => setImmediate(resolve));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('workspace headers when adding a provider', () => {
  it('uses the workspace during discovery and persists it with the verified provider', async () => {
    const headers = { 'anthropic-workspace-id': 'wrkspc_add_fixture' };

    const result = await addProviderFromTemplate(apiTemplate(), key, { headers });

    expect(result).toMatchObject({ added: true, keyVerified: true, hint: undefined });
    expect(result.provider?.api.headers).toEqual(headers);
    expect(loadRegistry().providers[0]?.api.headers).toEqual(headers);
    expect(env.saveProviderCredential).toHaveBeenCalledTimes(1);
    expect(env.saveProviderCredential).toHaveBeenCalledWith(`keyring:provider:${ANTHROPIC_API_PROVIDER_ID}`, key);
    expectAnthropicDiscovery(key, headers);
  });

  it.each([undefined, {}])('does not persist an empty headers field for %j', async headers => {
    const result = await addProviderFromTemplate(apiTemplate(), key, { headers });

    expect(result.added).toBe(true);
    expect(loadRegistry().providers[0]?.api).not.toHaveProperty('headers');
    expect(env.saveProviderCredential).toHaveBeenCalledTimes(1);
    expect(env.saveProviderCredential).toHaveBeenCalledWith(`keyring:provider:${ANTHROPIC_API_PROVIDER_ID}`, key);
    expectAnthropicDiscovery(key);
  });

  it('keeps the unverified-key warning when the template skips key verification', async () => {
    const template = { ...apiTemplate(), skipKeyVerification: true };

    const result = await addProviderFromTemplate(template, key);

    expect(result).toMatchObject({ added: true, keyVerified: false });
    expect(result.hint).toMatch(/did not verify.*first request/i);
    expect(env.saveProviderCredential).toHaveBeenCalledTimes(1);
    expect(env.saveProviderCredential).toHaveBeenCalledWith(`keyring:provider:${template.id}`, key);
    expectAnthropicDiscovery(key);
  });
});

describe('workspace headers during model refresh', () => {
  it('reuses the saved workspace and updates the cached model list', async () => {
    const template = apiTemplate();
    const headers = { 'anthropic-workspace-id': 'wrkspc_refresh_fixture' };
    const registry = emptyRegistry();
    registry.providers.push({
      id: template.id, templateId: template.id, name: template.name, enabled: true, authType: 'api',
      authRef: `keyring:provider:${template.id}`, addedAt: new Date().toISOString(),
      api: { npm: template.npm, url: template.defaultBaseUrl, headers },
    });
    saveRegistry(registry);

    const result = await refreshProviderModels(template.id, key);

    expect(result).toMatchObject({ ok: true, modelCount: 1 });
    expect(loadRegistry().providers[0]?.modelsCache?.models.map(model => model.id)).toEqual(['claude-workspace-fixture']);
    expect(loadRegistry().providers[0]?.api.headers).toEqual(headers);
    expect(env.saveProviderCredential).not.toHaveBeenCalled();
    expectAnthropicDiscovery(key, headers);
  });
});

describe('optional workspace prompt', () => {
  it('asks for the workspace and forwards the trimmed answer through provider setup', async () => {
    input.text.mockResolvedValue('  wrkspc_prompt_fixture  ');
    const headers = { 'anthropic-workspace-id': 'wrkspc_prompt_fixture' };

    const result = await runProvidersAdd();

    expect(result).toBe(0);
    expect(input.text).toHaveBeenCalledTimes(1);
    expect(input.text).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/workspace/i) }));
    expect(loadRegistry().providers[0]?.api.headers).toEqual(headers);
    expect(env.saveProviderCredential).toHaveBeenCalledTimes(1);
    expect(env.saveProviderCredential).toHaveBeenCalledWith(`keyring:provider:${ANTHROPIC_API_PROVIDER_ID}`, key);
    expectAnthropicDiscovery(key, headers, [workspaceRequest(key)]);
  });

  it('continues without workspace headers when the optional answer is blank', async () => {
    input.text.mockResolvedValue('   ');

    const result = await runProvidersAdd();

    expect(result).toBe(0);
    expect(input.text).toHaveBeenCalledTimes(1);
    expect(loadRegistry().providers[0]?.api).not.toHaveProperty('headers');
    expect(env.saveProviderCredential).toHaveBeenCalledTimes(1);
    expect(env.saveProviderCredential).toHaveBeenCalledWith(`keyring:provider:${ANTHROPIC_API_PROVIDER_ID}`, key);
    expectAnthropicDiscovery(key, {}, [workspaceRequest(key)]);
  });
});

describe('automatic workspace selection', () => {
  it('uses the only available workspace without another selection or text prompt', async () => {
    const workspace = { id: 'wrkspc_only_fixture', name: 'Only workspace' };
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ data: [workspace] }));

    const result = await runProvidersAdd();

    const headers = { 'anthropic-workspace-id': workspace.id };
    expect(result).toBe(0);
    expect(input.select).toHaveBeenCalledTimes(1);
    expect(input.text).not.toHaveBeenCalled();
    expect(loadRegistry().providers[0]?.api.headers).toEqual(headers);
    expectAnthropicDiscovery(key, headers, [workspaceRequest(key)]);
  });

  it('falls back to manual input after a workspace listing HTTP failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
    input.text.mockResolvedValue('wrkspc_manual_fixture');
    const info = vi.spyOn(clack.log, 'info').mockImplementation(() => {});

    const result = await runProvidersAdd();

    const headers = { 'anthropic-workspace-id': 'wrkspc_manual_fixture' };
    expect(result).toBe(0);
    expect(input.text).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
    expect(loadRegistry().providers[0]?.api.headers).toEqual(headers);
    expectAnthropicDiscovery(key, headers, [workspaceRequest(key)]);
  });
});

describe('multiple workspace selection', () => {
  it.each([
    { choice: 'wrkspc_second_fixture', expectedHeaders: { 'anthropic-workspace-id': 'wrkspc_second_fixture' } },
    { choice: '', expectedHeaders: undefined },
  ])('persists only the workspace selected by the choice "$choice"', async ({ choice, expectedHeaders }) => {
    const workspaces = [
      { id: 'wrkspc_first_fixture', name: 'First workspace' },
      { id: 'wrkspc_second_fixture', name: 'Second workspace' },
    ];
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ data: workspaces }));
    input.select.mockResolvedValueOnce(`api:${ANTHROPIC_API_PROVIDER_ID}`).mockResolvedValueOnce(choice);

    const result = await runProvidersAdd();

    expect(result).toBe(0);
    expect(input.select).toHaveBeenCalledTimes(2);
    expect(input.select).toHaveBeenNthCalledWith(2, {
      message: expect.stringMatching(/workspace/i),
      options: [
        { value: workspaces[0]?.id, label: workspaces[0]?.name, hint: workspaces[0]?.id },
        { value: workspaces[1]?.id, label: workspaces[1]?.name, hint: workspaces[1]?.id },
        { value: '', label: expect.stringMatching(/no workspace/i), hint: expect.any(String) },
      ],
    });
    expect(input.text).not.toHaveBeenCalled();
    expect(loadRegistry().providers[0]?.api.headers).toEqual(expectedHeaders);
    expectAnthropicDiscovery(key, expectedHeaders, [workspaceRequest(key)]);
  });
});

describe('workspace-required setup guidance', () => {
  it('shows workspace creation and regular-key guidance when discovery requires a workspace header', async () => {
    const upstreamMessage = 'Include anthropic-workspace-id to use this organization key.';
    input.text.mockResolvedValue('');
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ data: [], has_more: false, first_id: null, last_id: null }))
      .mockResolvedValueOnce(Response.json({ error: { message: upstreamMessage } }, { status: 400 }));
    const info = vi.spyOn(clack.log, 'info').mockImplementation(() => {});

    const result = await runProvidersAdd();

    expect(result).toBe(1);
    expect(info.mock.calls.map(([message]) => message)).toEqual([
      expect.stringMatching(/no workspaces/i),
      upstreamMessage,
      expect.stringMatching(/https:\/\/platform\.claude\.com\/settings\/workspaces.*sk-ant-api03/),
    ]);
    expect(loadRegistry().providers).toEqual([]);
    expect(env.saveProviderCredential).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls).toEqual([
      workspaceRequest(key),
      [
        `${apiTemplate().defaultBaseUrl}/v1/models?limit=${ANTHROPIC_MODELS_PAGE_LIMIT}`,
        {
          method: 'GET',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', Accept: 'application/json' },
          redirect: 'manual', signal: expect.any(AbortSignal),
        },
      ],
    ]);
  });
});

describe('workspace prompt boundaries', () => {
  it('cancels after workspace discovery without listing models or persisting a provider', async () => {
    input.text.mockResolvedValue(Symbol('cancel'));

    const result = await runProvidersAdd();

    expect(result).toBe(0);
    expect(input.text).toHaveBeenCalledTimes(1);
    expect(loadRegistry().providers).toEqual([]);
    expect(env.saveProviderCredential).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls).toEqual([workspaceRequest(key)]);
  });

  it('does not ask for a workspace when the selected template has no workspace header', async () => {
    const template = apiTemplate('openai');
    input.select.mockResolvedValue(`api:${template.id}`);

    const result = await runProvidersAdd();

    expect(result).toBe(0);
    expect(input.text).not.toHaveBeenCalled();
    expect(loadRegistry().providers[0]?.id).toBe(template.id);
    expect(loadRegistry().providers[0]?.api).not.toHaveProperty('headers');
    expect(env.saveProviderCredential).toHaveBeenCalledTimes(1);
    expect(env.saveProviderCredential).toHaveBeenCalledWith(`keyring:provider:${template.id}`, key);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, `${template.defaultBaseUrl}/models`, {
      method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
      redirect: 'manual', signal: expect.any(AbortSignal),
    });
    expect(fetch).toHaveBeenNthCalledWith(2, expect.stringMatching(/^https:\/\//), {
      signal: expect.any(AbortSignal), headers: { Accept: 'application/json' },
    });
  });
});
