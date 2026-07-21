import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  filterTemplates,
  getTemplateById,
  listAddableTemplates,
  listSupportedTemplates,
  listVisibleOAuthTemplates,
} from '../src/provider-templates.js';
import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';

describe('provider templates', () => {
  it('offers Kimi, Moonshot, and z.ai as distinct addable providers', () => {
    expect(listSupportedTemplates().map(t => t.id).sort()).toEqual(['kimi', 'moonshot', 'openai', 'zai']);
  });

  it('filters templates by search query', () => {
    const templates = listSupportedTemplates();
    // 'openai' matches the OpenAI template id and every npm package name.
    expect(filterTemplates(templates, 'openai').map(t => t.id).sort()).toEqual(['kimi', 'moonshot', 'openai', 'zai']);
    expect(filterTemplates(templates, 'kimi').map(t => t.id)).toEqual(['kimi']);
    expect(filterTemplates(templates, 'z.ai').map(t => t.id)).toEqual(['zai']);
    expect(filterTemplates(templates, 'moonshot').map(t => t.id)).toEqual(['moonshot']);
    expect(filterTemplates(templates, 'groq')).toEqual([]);
  });

  it('looks up template by id', () => {
    expect(getTemplateById('openai')?.npm).toBe('@ai-sdk/openai');
    expect(getTemplateById('openai-oauth')?.authType).toBe('oauth');
    expect(getTemplateById('kimi')?.npm).toBe('@ai-sdk/openai-compatible');
    expect(getTemplateById('moonshot')?.npm).toBe('@ai-sdk/openai-compatible');
    expect(getTemplateById('zai')?.npm).toBe('@ai-sdk/openai-compatible');
    expect(getTemplateById('groq')).toBeUndefined();
  });

  it('lists only the OpenAI OAuth template for discovery surfaces', () => {
    expect(listVisibleOAuthTemplates().map(t => t.id)).toEqual(['openai-oauth']);
    expect(listVisibleOAuthTemplates(['openai-oauth']).map(t => t.id)).not.toContain('openai-oauth');
  });

  it('excludes already-configured providers from addable list', () => {
    expect(listAddableTemplates(['openai', 'kimi', 'moonshot', 'zai']).map(t => t.id)).toEqual([]);
    expect(listAddableTemplates([]).map(t => t.id).sort()).toEqual(['kimi', 'moonshot', 'openai', 'zai']);
  });

  it('uses @ai-sdk/openai-compatible (never @ai-sdk/openai) for non-OpenAI templates', () => {
    for (const id of ['kimi', 'moonshot', 'zai'] as const) {
      const tpl = getTemplateById(id)!;
      expect(tpl.npm).toBe('@ai-sdk/openai-compatible');
      expect(tpl.authType).toBe('api');
      expect(tpl.supported).toBe(true);
    }
  });

  it('pins the documented base URLs for OpenAI-compatible templates', () => {
    expect(getTemplateById('kimi')?.defaultBaseUrl).toBe('https://api.kimi.com/coding/v1');
    expect(getTemplateById('moonshot')?.defaultBaseUrl).toBe('https://api.moonshot.ai/v1');
    expect(getTemplateById('zai')?.defaultBaseUrl).toBe('https://api.z.ai/api/coding/paas/v4');
  });

  it('seeds exact Kimi Coding Plan IDs with k3 at documented context', () => {
    const kimi = getTemplateById('kimi')!;
    expect(kimi.staticModels?.map(m => m.id)).toEqual([
      'k3',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ]);
    expect(kimi.staticModels?.find(m => m.id === 'k3')?.contextWindow).toBe(1_048_576);

    const moonshot = getTemplateById('moonshot')!;
    expect(moonshot.staticModels?.map(m => m.id)).toEqual([
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
    ]);
  });

  it('uses live z.ai listing with the documented models as an outage fallback', () => {
    const kimi = getTemplateById('kimi')!;
    const zai = getTemplateById('zai')!;
    const glm52 = zai.staticModels?.find(m => m.id === 'glm-5.2');
    expect(glm52).toBeDefined();
    expect(glm52?.contextWindow).toBe(1_000_000);

    expect(zai.skipKeyVerification).toBeFalsy();
    expect(zai.modelSource).toBe('api-list');
    // Kimi uses live /models, so its key is verifiable.
    expect(kimi.skipKeyVerification).toBeFalsy();
    expect(kimi.modelSource).toBe('api-list');
  });
});

describe('fetchTemplateModels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses OpenAI-style model list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
      }),
    }));

    const template = getTemplateById('openai')!;
    const result = await fetchTemplateModels(template, 'test-key');
    expect(result.error).toBeUndefined();
    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.id).toBe('gpt-5.6-sol');
    expect(result.models[0]?.modelFormat).toBe('openai');
  });

  it('returns helpful error on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid key',
    }));

    const template = getTemplateById('openai')!;
    const result = await fetchTemplateModels(template, 'bad-key');
    expect(result.models).toHaveLength(0);
    expect(result.error).toContain('rejected');
  });

  it('materializes the Kimi Coding Plan fallback with k3 at 1M context', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const template = getTemplateById('kimi')!;
    // Static seed is the fallback when api-list live fetch fails. Assert seed shape directly.
    const seedTemplate = { ...template, modelSource: 'static-seed' as const };
    const result = await fetchTemplateModels(seedTemplate, 'key');
    const k3 = result.models.find(m => m.id === 'k3');
    expect(k3?.contextWindow).toBe(1_048_576);
    expect(result.models.map(m => m.id)).toEqual(['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed']);
  });
});
