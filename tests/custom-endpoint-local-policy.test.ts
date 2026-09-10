import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addCustomEndpointProvider } from '../src/registry/custom-endpoint.js';
import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';

vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  saveProviderCredential: vi.fn().mockResolvedValue(true),
  deleteProviderCredential: vi.fn().mockResolvedValue(true),
}));

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-local-policy-'));
  vi.stubEnv('LEVERFRAME_HOME', home);
  vi.stubEnv('LEVERFRAME_TRACE', '0');
  saveRegistry(emptyRegistry());
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ data: [{ id: 'fixture-model' }] })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('custom endpoint local HTTP approval', () => {
  it.each(['', 'fixture-key'])('preserves explicit approval with key %j', async apiKey => {
    const result = await addCustomEndpointProvider({
      displayName: 'Local fixture',
      baseUrl: 'http://127.0.0.1:12345/v1',
      apiKey,
      kind: 'openai',
      allowInsecureLocal: true,
    });
    expect(result).toMatchObject({ added: true, modelCount: 1 });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:12345/v1/models', expect.objectContaining({ redirect: 'manual' }));
    expect(loadRegistry().providers).toHaveLength(1);
  });

  it.each([undefined, false])('rejects local HTTP without approval %j before discovery', async allowInsecureLocal => {
    const result = await addCustomEndpointProvider({
      displayName: 'Local fixture', baseUrl: 'http://127.0.0.1:12345/v1',
      apiKey: '', kind: 'openai', allowInsecureLocal,
    });
    expect(result.added).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(loadRegistry().providers).toHaveLength(0);
  });

  it('does not approve remote plain HTTP', async () => {
    const result = await addCustomEndpointProvider({
      displayName: 'Remote fixture', baseUrl: 'http://8.8.8.8/v1',
      apiKey: '', kind: 'openai', allowInsecureLocal: true,
    });
    expect(result.added).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows explicit rejection to override a local template default', async () => {
    const result = await fetchTemplateModels({
      id: 'local', name: 'Local', npm: '@ai-sdk/openai-compatible', authType: 'none',
      modelSource: 'api-list', supported: true, apiKeyOptional: true,
    }, '', 'http://127.0.0.1:12345/v1', undefined, { allowInsecureLocal: false });
    expect(result.error).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
