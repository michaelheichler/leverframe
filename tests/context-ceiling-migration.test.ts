import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPreferences } from '../src/config.js';
import { buildDesiredPatchConfig, buildPatchModelConfig } from '../src/patcher.js';
import { contextModeModelId } from '../src/context-model-id.js';
import { lookupRoute, type ProxyRoute } from '../src/proxy-request.js';

describe('context ceiling preference migration', () => {
  let home: string;
  const previousHome = process.env['LEVERFRAME_HOME'];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'leverframe-context-ceiling-'));
    process.env['LEVERFRAME_HOME'] = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
    else process.env['LEVERFRAME_HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('ignores a saved global maximum at startup while an explicit switch uses fresh limits', () => {
    const model = {
      id: 'gpt-5.6-sol',
      upstreamModelId: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      contextWindow: 301_000,
      maxContextWindow: 1_101_000,
      modelFormat: 'openai',
    };
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        favoriteModels: [{ providerId: 'openai-oauth', modelId: model.id }],
        contextCeilingOverrides: [model.id],
      }),
    );
    writeFileSync(
      join(home, 'providers.json'),
      JSON.stringify({
        schemaVersion: 1,
        providers: [{
          id: 'openai-oauth',
          templateId: 'openai',
          name: 'OpenAI (ChatGPT)',
          enabled: true,
          authRef: 'oauth:openai',
          api: { npm: '@ai-sdk/openai' },
          modelsCache: { fetchedAt: '2026-07-27T00:00:00.000Z', models: [model] },
          addedAt: '2026-07-27T00:00:00.000Z',
        }],
      }),
    );

    expect(loadPreferences().contextCeilingOverrides).toEqual([model.id]);
    const desired = buildDesiredPatchConfig();
    const key = 'leverframe:openai-oauth:gpt-5.6-sol';
    expect(desired.config[key]).toMatchObject({
      context: 301_000,
      contextModes: { default: 301_000, maximum: 1_101_000 },
    });
    expect(desired.provenance[key]).toBe('confirmed');

    const route: ProxyRoute = {
      aliasId: key,
      realModelId: model.upstreamModelId,
      displayName: model.name,
      upstreamUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      modelFormat: 'openai',
      contextWindow: 301_000,
      maxContextWindow: 1_101_000,
    };
    const routes = new Map([[route.aliasId, route]]);
    expect(lookupRoute(routes, route.aliasId)?.contextWindow).toBe(301_000);
    expect(lookupRoute(routes, contextModeModelId(route.aliasId, 'maximum'))).toMatchObject({
      contextWindow: 1_101_000,
      realModelId: model.upstreamModelId,
    });
  });

  it('keeps a single default mode when the reported maximum equals the default', () => {
    const { config } = buildPatchModelConfig(
      [{ providerId: 'openai', modelId: 'equal-limit' }],
      [],
      () => ({ contextWindow: 301_000, maxContextWindow: 301_000, modelFormat: 'openai' }),
    );
    expect(config['leverframe:openai:equal-limit']).toMatchObject({
      context: 301_000,
      contextModes: { default: 301_000 },
    });
    expect(config['leverframe:openai:equal-limit']?.contextModes).not.toHaveProperty('maximum');
  });

  it('excludes stale cached favorites when fresh discovery returns no providers', () => {
    const model = {
      id: 'stale-model',
      upstreamModelId: 'stale-model',
      name: 'Stale model',
      contextWindow: 301_000,
      modelFormat: 'openai',
    };
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ favoriteModels: [{ providerId: 'openai-oauth', modelId: model.id }] }),
    );
    writeFileSync(
      join(home, 'providers.json'),
      JSON.stringify({
        schemaVersion: 1,
        providers: [{
          id: 'openai-oauth',
          templateId: 'openai',
          name: 'OpenAI (ChatGPT)',
          enabled: true,
          authRef: 'oauth:openai',
          api: { npm: '@ai-sdk/openai' },
          modelsCache: { fetchedAt: '2026-07-27T00:00:00.000Z', models: [model] },
          addedAt: '2026-07-27T00:00:00.000Z',
        }],
      }),
    );

    const desired = buildDesiredPatchConfig([]);
    expect(desired.config).toEqual({});
    expect(desired.provenance).toEqual({});
  });
});
