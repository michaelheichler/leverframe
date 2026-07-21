import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  emptyRegistry,
  isValidProviderId,
  loadRegistry,
  materializeRegistry,
  saveRegistry,
  slugifyProviderId,
  type RegistryProvider,
} from '../src/registry/index.js';
import { buildGlobalFavoriteIndex } from '../src/favorites-picker.js';
import { buildHttpProxyRoutes } from '../src/http-proxy/routes.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

describe('provider id validation', () => {
  it('accepts stable slugs', () => {
    expect(isValidProviderId('groq')).toBe(true);
    expect(isValidProviderId('openai')).toBe(true);
    expect(isValidProviderId('custom-together-ai')).toBe(true);
    expect(isValidProviderId('go')).toBe(true);
  });

  it('rejects invalid ids', () => {
    expect(isValidProviderId('OpenAI')).toBe(false);
    expect(isValidProviderId('has space')).toBe(false);
    expect(isValidProviderId('bad:id')).toBe(false);
    expect(isValidProviderId('-leading')).toBe(false);
    expect(isValidProviderId('trailing-')).toBe(false);
  });

  it('slugifies display names', () => {
    expect(slugifyProviderId('Together AI')).toBe('together-ai');
    expect(slugifyProviderId('My vLLM Server')).toBe('my-vllm-server');
  });
});

describe('registry io', () => {
  let home: string;
  const prev = process.env.LEVERFRAME_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'leverframe-registry-'));
    process.env.LEVERFRAME_HOME = home;
    vi.mocked(readFileSync).mockClear();
    vi.mocked(renameSync).mockClear();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.LEVERFRAME_HOME;
    else process.env.LEVERFRAME_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  it('round-trips registry json', () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'groq',
      templateId: 'groq',
      name: 'Groq',
      enabled: true,
      authRef: 'keyring:provider:groq',
      api: { npm: '@ai-sdk/groq' },
      addedAt: '2026-06-09T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-06-09T00:00:00.000Z',
        models: [{
          id: 'llama-3.3-70b',
          name: 'Llama 3.3 70B',
          upstreamModelId: 'llama-3.3-70b',
          modelFormat: 'openai',
          npm: '@ai-sdk/groq',
        }],
      },
    });
    saveRegistry(registry);
    const loaded = loadRegistry();
    expect(loaded.providers).toHaveLength(1);
    expect(loaded.providers[0]?.id).toBe('groq');
    expect(loaded.providers[0]?.modelsCache?.models[0]?.npm).toBe('@ai-sdk/groq');
  });

  it('writes providers.json with restrictive permissions', () => {
    saveRegistry(emptyRegistry());
    const path = join(home, 'providers.json');
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('skips invalid provider entries on load', () => {
    const path = join(home, 'providers.json');
    const raw = {
      schemaVersion: 1,
      providers: [
        { id: 'BAD ID', templateId: 'x', name: 'X', enabled: true, authRef: 'k', api: {}, addedAt: 't' },
        {
          id: 'groq',
          templateId: 'groq',
          name: 'Groq',
          enabled: true,
          authRef: 'keyring:provider:groq',
          api: { npm: '@ai-sdk/groq' },
          addedAt: '2026-06-09T00:00:00.000Z',
        },
      ],
    };
    mkdirSync(home, { recursive: true });
    writeFileSync(path, JSON.stringify(raw));
    const loaded = loadRegistry(path);
    expect(loaded.providers).toHaveLength(1);
    expect(loaded.providers[0]?.id).toBe('groq');
  });

  it('distinguishes a missing file from corrupt JSON and quarantines the corrupt file', () => {
    const path = join(home, 'providers.json');
    mkdirSync(home, { recursive: true });
    const corrupt = '{ "providers": [ { broken';
    writeFileSync(path, corrupt, { mode: 0o600 });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loaded = loadRegistry(path);
    expect(loaded.providers).toEqual([]);

    // Original corrupt content was moved aside, not overwritten in place.
    expect(existsSync(path)).toBe(false);
    const quarantined = readdirSync(home).filter(name => name.startsWith('providers.json.corrupt-'));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(home, quarantined[0]!), 'utf8')).toBe(corrupt);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/providers registry at .* is corrupt/));
    warnSpy.mockRestore();
  });

  it('quarantines a top-level JSON non-object so an empty-array file does not read as fresh empty', () => {
    const path = join(home, 'providers.json');
    mkdirSync(home, { recursive: true });
    writeFileSync(path, '[]', { mode: 0o600 });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadRegistry(path);

    expect(existsSync(path)).toBe(false);
    const quarantined = readdirSync(home).filter(name => name.startsWith('providers.json.corrupt-'));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(home, quarantined[0]!), 'utf8')).toBe('[]');
    warnSpy.mockRestore();
  });

  it('treats a genuinely missing file as first-run (no quarantine, no warning)', () => {
    const path = join(home, 'providers.json');
    // No file written.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loaded = loadRegistry(path);
    expect(loaded.providers).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(readdirSync(home).filter(name => name.includes('corrupt'))).toEqual([]);
    warnSpy.mockRestore();
  });

  it.each(['EACCES', 'EIO'])('propagates a registry read failure with code %s', (code) => {
    const path = join(home, 'providers.json');
    const readError = Object.assign(new Error(`read failed: ${code}`), { code });
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw readError; });

    expect(() => loadRegistry(path)).toThrow(readError);
    expect(renameSync).not.toHaveBeenCalled();
  });

  it('blocks recovery when quarantine rename fails and preserves the original bytes', () => {
    const path = join(home, 'providers.json');
    const corrupt = '{"providers":[broken';
    writeFileSync(path, corrupt, { mode: 0o600 });
    const renameError = Object.assign(new Error('rename failed: EACCES'), { code: 'EACCES' });
    vi.mocked(renameSync).mockImplementationOnce(() => { throw renameError; });

    expect(() => loadRegistry(path)).toThrow(/could not be quarantined/);
    expect(readFileSync(path, 'utf8')).toBe(corrupt);
    expect(readdirSync(home).filter(name => name.startsWith('providers.json.corrupt-'))).toEqual([]);
    expect(() => saveRegistry(emptyRegistry(), path)).toThrow(/refusing to overwrite corrupt providers registry/);
    expect(readFileSync(path, 'utf8')).toBe(corrupt);
  });

});

describe('materializeRegistry', () => {
  it('materializes enabled providers with credentials and models', () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'openai',
      templateId: 'openai',
      name: 'OpenAI',
      enabled: true,
      authRef: 'keyring:provider:openai',
      authType: 'oauth',
      api: { npm: '@ai-sdk/openai' },
      addedAt: '2026-06-09T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-06-09T00:00:00.000Z',
        models: [{
          id: 'gpt-5.5-fast',
          name: 'GPT-5.5 Fast',
          upstreamModelId: 'gpt-5.5',
          modelFormat: 'openai',
          npm: '@ai-sdk/openai',
        }],
      },
    });
    const locals = materializeRegistry(registry, () => 'sk-test');
    expect(locals).toHaveLength(1);
    expect(locals[0]?.models[0]?.upstreamModelId).toBe('gpt-5.5');
    expect(locals[0]?.apiKey).toBe('sk-test');
    expect(locals[0]?.authType).toBe('oauth');
  });

  it('returns empty when credential missing', () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'groq',
      templateId: 'groq',
      name: 'Groq',
      enabled: true,
      authRef: 'keyring:provider:groq',
      api: { npm: '@ai-sdk/groq' },
      addedAt: '2026-06-09T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-06-09T00:00:00.000Z',
        models: [{
          id: 'llama',
          name: 'Llama',
          upstreamModelId: 'llama',
          modelFormat: 'openai',
          npm: '@ai-sdk/groq',
        }],
      },
    });
    expect(materializeRegistry(registry, () => null)).toHaveLength(0);
  });

  it('marks NVIDIA imported models as free provider access', () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'nvidia',
      templateId: 'nvidia',
      name: 'NVIDIA NIM',
      enabled: true,
      authRef: 'keyring:provider:nvidia',
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://integrate.api.nvidia.com/v1' },
      addedAt: '2026-07-06T00:00:00.000Z',
      modelsCache: {
        fetchedAt: '2026-07-06T00:00:00.000Z',
        models: [{
          id: 'nvidia/llama-3.1-nemotron',
          name: 'NVIDIA Nemotron',
          upstreamModelId: 'nvidia/llama-3.1-nemotron',
          modelFormat: 'openai',
          npm: '@ai-sdk/openai-compatible',
        }],
      },
    });

    const locals = materializeRegistry(registry, () => 'nvapi-test');

    expect(locals[0]?.models[0]).toMatchObject({
      isFree: true,
      freeStatus: 'free_provider',
    });
  });

  it('prefers cached apiUrl when cached, persisted, and template URLs all exist', () => {
    const registry = emptyRegistry();
    const provider = compatibleTemplateEntry('zai', 'z.ai (Coding Plan)', 'glm-5.2');
    provider.api.url = 'https://persisted.example/v1';
    provider.modelsCache!.models[0]!.apiUrl = 'https://override.example/v1';
    registry.providers.push(provider);

    const locals = materializeRegistry(registry, () => 'key');

    expect(locals[0]?.models[0]?.apiBaseUrl).toBe('https://override.example/v1');
    expect(locals[0]?.models[0]?.completionsUrl).toBe('https://override.example/v1/chat/completions');
  });

  it.each([
    {
      providerId: 'kimi',
      providerName: 'Kimi (Coding Plan)',
      modelId: 'k3',
      contextWindow: 1_048_576,
      apiBaseUrl: 'https://api.kimi.com/coding/v1',
      aliasId: 'leverframe:kimi:k3[1m]',
    },
    {
      providerId: 'moonshot',
      providerName: 'Moonshot (Pay-as-you-go)',
      modelId: 'kimi-k3',
      contextWindow: 1_048_576,
      apiBaseUrl: 'https://api.moonshot.ai/v1',
      aliasId: 'leverframe:moonshot:kimi-k3[1m]',
    },
    {
      providerId: 'zai',
      providerName: 'z.ai (Coding Plan)',
      modelId: 'glm-5.2',
      contextWindow: 1_000_000,
      apiBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
      aliasId: 'leverframe:zai:glm-5.2[1m]',
    },
  ])(
    'routes materialized $providerId favorites using the template endpoint and context',
    ({ providerId, providerName, modelId, contextWindow, apiBaseUrl, aliasId }) => {
      const registry = emptyRegistry();
      registry.providers.push(compatibleTemplateEntry(providerId, providerName, modelId, contextWindow));

      const locals = materializeRegistry(registry, () => 'provider-key');
      const completionsUrl = `${apiBaseUrl}/chat/completions`;

      expect(locals).toHaveLength(1);
      expect(locals[0]?.models).toHaveLength(1);
      expect(locals[0]?.models[0]).toMatchObject({
        id: modelId,
        npm: '@ai-sdk/openai-compatible',
        contextWindow,
        apiBaseUrl,
        completionsUrl,
      });

      expect(buildGlobalFavoriteIndex(locals)).toEqual([
        expect.objectContaining({
          providerId,
          model: expect.objectContaining({ id: modelId, contextWindow }),
        }),
      ]);

      const routes = buildHttpProxyRoutes(locals, [{ providerId, modelId }]);
      expect(routes.unavailable).toEqual([]);
      expect(routes.unsupported).toEqual([]);
      expect(routes.routes).toEqual([
        expect.objectContaining({
          aliasId,
          realModelId: modelId,
          upstreamUrl: completionsUrl,
          baseURL: apiBaseUrl,
          contextWindow,
          npm: '@ai-sdk/openai-compatible',
        }),
      ]);
    });

  it('prefers a persisted provider URL to the built-in template default', () => {
    const registry = emptyRegistry();
    const provider = compatibleTemplateEntry('zai', 'z.ai (Coding Plan)', 'glm-5.2');
    provider.api.url = 'https://persisted.example/v1';
    registry.providers.push(provider);

    const locals = materializeRegistry(registry, () => 'zai-key');

    expect(locals[0]?.models[0]).toMatchObject({
      apiBaseUrl: 'https://persisted.example/v1',
      completionsUrl: 'https://persisted.example/v1/chat/completions',
    });
  });

});

function compatibleTemplateEntry(
  id: string,
  name: string,
  modelId: string,
  contextWindow?: number,
): RegistryProvider {
  return {
    id,
    templateId: id,
    name,
    enabled: true,
    authRef: `keyring:provider:${id}`,
    api: { npm: '@ai-sdk/openai-compatible' },
    addedAt: '2026-07-21T00:00:00.000Z',
    modelsCache: {
      fetchedAt: '2026-07-21T00:00:00.000Z',
      models: [{
        id: modelId,
        name: modelId,
        upstreamModelId: modelId,
        modelFormat: 'openai',
        contextWindow,
      }],
    },
  };
}
