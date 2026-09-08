import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDesiredPatchConfig,
  computePatchConfigHash,
  reasoningEffortForPatch,
} from '../src/patcher.js';
import { applyLeverframePatches, formatPatchSiteLine, PatchApplyError, projectNativeEffort } from '../src/patch-transforms.js';
import type { CachedModel, RegistryProvider } from '../src/registry/types.js';
import type { LocalProvider } from '../src/types.js';

describe('projectNativeEffort', () => {
  it('accepts a full native-plus ladder and pins the default to high', () => {
    expect(projectNativeEffort({ levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'low' }))
      .toEqual({ levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'high' });
  });

  it('rejects a ladder missing the low/medium/high base', () => {
    expect(projectNativeEffort({ levels: ['high', 'xhigh'], defaultLevel: 'high' })).toBeUndefined();
  });

  it('rejects a default outside the projected native levels', () => {
    expect(projectNativeEffort({ levels: ['low', 'medium', 'high'], defaultLevel: 'max' })).toBeUndefined();
  });

  it('rejects undefined and malformed input', () => {
    expect(projectNativeEffort(undefined)).toBeUndefined();
    expect(projectNativeEffort({ levels: 'high' as unknown as string[], defaultLevel: 'high' })).toBeUndefined();
  });
});

describe('reasoningEffortForPatch', () => {
  const provider: RegistryProvider = {
    id: 'openai-oauth',
    templateId: 'openai',
    name: 'OpenAI (ChatGPT)',
    enabled: true,
    authRef: 'oauth:openai',
    api: { npm: '@ai-sdk/openai' },
    addedAt: '2026-07-27T00:00:00.000Z',
  };
  const baseModel: CachedModel = {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    upstreamModelId: 'gpt-5.6-sol',
    modelFormat: 'openai',
    reasoning: true,
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'medium',
  };

  it('derives the same GPT-5.6 ladder the proxy-side wiring uses', () => {
    expect(reasoningEffortForPatch(provider, baseModel)).toEqual({
      levels: ['low', 'medium', 'high', 'xhigh'],
      defaultLevel: 'medium',
    });
  });

  it('returns undefined for a non-openai model format', () => {
    expect(reasoningEffortForPatch(provider, { ...baseModel, modelFormat: 'anthropic' })).toBeUndefined();
  });

  it('returns undefined when neither the model nor the provider declares an npm package', () => {
    expect(reasoningEffortForPatch({ ...provider, api: {} }, baseModel)).toBeUndefined();
  });

  it('strips a [1m] suffix before resolving reasoning capabilities', () => {
    expect(reasoningEffortForPatch(provider, { ...baseModel, id: 'gpt-5.6-sol[1m]', upstreamModelId: 'gpt-5.6-sol[1m]' }))
      .toEqual({ levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'medium' });
  });

  it('returns undefined for a model with no reasoning capability at all', () => {
    expect(reasoningEffortForPatch(provider, {
      ...baseModel,
      id: 'gpt-4o',
      upstreamModelId: 'gpt-4o',
      reasoning: undefined,
      supportedReasoningEfforts: undefined,
      defaultReasoningEffort: undefined,
    })).toBeUndefined();
  });
});

describe('buildDesiredPatchConfig', () => {
  let home: string;
  const previousHome = process.env['LEVERFRAME_HOME'];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'leverframe-desired-patch-'));
    process.env['LEVERFRAME_HOME'] = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
    else process.env['LEVERFRAME_HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeInputs(model: Record<string, unknown>): void {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ favoriteModels: [{ providerId: 'openai-oauth', modelId: model['id'] }] }),
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
  }

  it('wires the projected effort ladder end to end for a favorited GPT-5.6 model', () => {
    writeInputs({
      id: 'gpt-5.6-sol',
      upstreamModelId: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      contextWindow: 272_000,
      modelFormat: 'openai',
      reasoning: true,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      defaultReasoningEffort: 'high',
    });

    const desired = buildDesiredPatchConfig();

    expect(desired.config['leverframe:openai-oauth:gpt-5.6-sol']?.effort).toEqual({
      levels: ['low', 'medium', 'high', 'xhigh'],
      defaultLevel: 'high',
    });
  });

  it('omits effort for a favorited model with no reasoning capability', () => {
    writeInputs({
      id: 'gpt-4o',
      upstreamModelId: 'gpt-4o',
      name: 'GPT-4o',
      contextWindow: 128_000,
      modelFormat: 'openai',
    });

    const desired = buildDesiredPatchConfig();

    expect(desired.config['leverframe:openai-oauth:gpt-4o']?.effort).toBeUndefined();
  });

  it('bakes a provider-confirmed context window and marks it confirmed', () => {
    writeInputs({
      id: 'gpt-5.6-sol',
      upstreamModelId: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      contextWindow: 272_000,
      modelFormat: 'openai',
    });

    const desired = buildDesiredPatchConfig();

    expect(desired.config['leverframe:openai-oauth:gpt-5.6-sol']?.context).toBe(272_000);
    expect(desired.unknownWindows).toEqual([]);
    expect(desired.provenance['leverframe:openai-oauth:gpt-5.6-sol']).toBe('confirmed');
  });

  it('withholds an unconfirmed context window instead of baking a guess, and does not call it "missing"', () => {
    writeInputs({
      id: 'gpt-5.6-sol',
      upstreamModelId: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      contextWindow: 272_000,
      contextWindowUnconfirmed: true,
      modelFormat: 'openai',
    });

    const desired = buildDesiredPatchConfig();

    expect(desired.config['leverframe:openai-oauth:gpt-5.6-sol']).not.toHaveProperty('context');
    expect(desired.unknownWindows).toEqual([]);
    expect(desired.provenance['leverframe:openai-oauth:gpt-5.6-sol']).toBe('unconfirmed');
  });

  it('reports a genuinely missing context window in unknownWindows with no context key', () => {
    writeInputs({
      id: 'gpt-4o',
      upstreamModelId: 'gpt-4o',
      name: 'GPT-4o',
      modelFormat: 'openai',
    });

    const desired = buildDesiredPatchConfig();

    expect(desired.config['leverframe:openai-oauth:gpt-4o']).not.toHaveProperty('context');
    expect(desired.unknownWindows).toEqual(['leverframe:openai-oauth:gpt-4o']);
    expect(desired.provenance['leverframe:openai-oauth:gpt-4o']).toBe('missing');
  });

  it('adds a fresh selected external model even when it is not favorited', () => {
    writeInputs({
      id: 'gpt-6-astra',
      upstreamModelId: 'gpt-6-astra',
      name: 'GPT-6 Astra',
      modelFormat: 'openai',
      contextWindow: 413_579,
      maxContextWindow: 1_203_017,
    });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ favoriteModels: [] }));

    const freshProviders: LocalProvider[] = [{
      id: 'openai-oauth',
      name: 'OpenAI (ChatGPT)',
      apiKey: 'provider-key',
      authType: 'oauth',
      models: [{
        id: 'gpt-6-astra',
        name: 'GPT-6 Astra',
        family: 'gpt',
        brand: 'OpenAI',
        modelFormat: 'openai',
        upstreamModelId: 'gpt-6-astra',
        contextWindow: 413_579,
        maxContextWindow: 1_203_017,
      }],
    }];

    const desired = buildDesiredPatchConfig(freshProviders, {
      providerId: 'openai-oauth',
      modelId: 'gpt-6-astra',
    });

    expect(desired.config['leverframe:openai-oauth:gpt-6-astra']).toMatchObject({
      context: 413_579,
      contextModes: { default: 413_579, maximum: 1_203_017 },
    });
    expect(Object.keys(desired.config)).toEqual(['leverframe:openai-oauth:gpt-6-astra']);
  });

  it('materializes every fresh external model when proxy launch has no boot selection', () => {
    writeInputs({
      id: 'gpt-6-astra',
      upstreamModelId: 'gpt-6-astra',
      name: 'GPT-6 Astra',
      modelFormat: 'openai',
      contextWindow: 272_000,
      maxContextWindow: 872_000,
    });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ favoriteModels: [] }));

    const freshProviders: LocalProvider[] = [{
      id: 'openai-oauth',
      name: 'OpenAI (ChatGPT)',
      apiKey: 'provider-key',
      authType: 'oauth',
      models: [
        {
          id: 'gpt-6-astra',
          name: 'GPT-6 Astra',
          family: 'gpt',
          brand: 'OpenAI',
          modelFormat: 'openai',
          upstreamModelId: 'gpt-6-astra',
          contextWindow: 272_000,
          maxContextWindow: 872_000,
        },
        {
          id: 'gpt-6-luna',
          name: 'GPT-6 Luna',
          family: 'gpt',
          brand: 'OpenAI',
          modelFormat: 'openai',
          upstreamModelId: 'gpt-6-luna',
          contextWindow: 300_000,
        },
      ],
    }];

    const desired = buildDesiredPatchConfig(freshProviders);

    expect(Object.keys(desired.config).sort()).toEqual([
      'leverframe:openai-oauth:gpt-6-astra',
      'leverframe:openai-oauth:gpt-6-luna',
    ]);
    expect(desired.config['leverframe:openai-oauth:gpt-6-astra']?.contextModes)
      .toEqual({ default: 272_000, maximum: 872_000 });
    expect(desired.config['leverframe:openai-oauth:gpt-6-luna']?.contextModes)
      .toEqual({ default: 300_000 });
  });

  it('puts configured favorites first while retaining every fresh external model', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      favoriteModels: [
        { providerId: 'zai', modelId: 'favorite-z' },
        { providerId: 'openai-oauth', modelId: 'favorite-openai' },
      ],
    }));

    const model = (id: string, name: string): LocalProvider['models'][number] => ({
      id,
      name,
      family: 'test',
      brand: 'Test',
      modelFormat: 'openai',
      upstreamModelId: id,
      contextWindow: 272_000,
    });
    const freshProviders: LocalProvider[] = [
      {
        id: 'openai-oauth',
        name: 'OpenAI (ChatGPT)',
        apiKey: 'openai-key',
        models: [model('other-openai', 'Other OpenAI'), model('favorite-openai', 'Favorite OpenAI')],
      },
      {
        id: 'zai',
        name: 'Z.ai',
        apiKey: 'zai-key',
        models: [model('other-z', 'Other Z'), model('favorite-z', 'Favorite Z')],
      },
    ];

    const desired = buildDesiredPatchConfig(freshProviders);

    expect(Object.keys(desired.config)).toEqual([
      'leverframe:zai:favorite-z',
      'leverframe:openai-oauth:favorite-openai',
      'leverframe:openai-oauth:other-openai',
      'leverframe:zai:other-z',
    ]);
  });

});

describe('computePatchConfigHash', () => {
  it('is stable across key ordering and sensitive to changes', () => {
    const a = { 'leverframe:p:m1': { alias: 'x', context: 1000 }, 'leverframe:p:m2': {} };
    const b = { 'leverframe:p:m2': {}, 'leverframe:p:m1': { alias: 'x', context: 1000 } };
    expect(computePatchConfigHash(a)).toBe(computePatchConfigHash(b));
    expect(computePatchConfigHash(a)).not.toBe(
      computePatchConfigHash({ ...a, 'leverframe:p:m1': { alias: 'y', context: 1000 } }),
    );
    expect(computePatchConfigHash(a)).not.toBe(
      computePatchConfigHash({ ...a, 'leverframe:p:m1': { alias: 'x', context: 2000 } }),
    );
  });

  it('changes when the patch transform implementation version changes', () => {
    const config = { 'leverframe:p:m1': { alias: 'x', context: 1000 } };
    expect(computePatchConfigHash(config, 1)).not.toBe(computePatchConfigHash(config, 2));
  });

  it('changes when only the display label changes (so an old patch reads as stale)', () => {
    const base = { 'leverframe:p:m1': { alias: 'x', context: 1000 } };
    expect(computePatchConfigHash(base)).not.toBe(
      computePatchConfigHash({ 'leverframe:p:m1': { alias: 'x', context: 1000, display: 'M One (P)' } }),
    );
    expect(computePatchConfigHash({ 'leverframe:p:m1': { alias: 'x', context: 1000, display: 'M One (P)' } })).not.toBe(
      computePatchConfigHash({ 'leverframe:p:m1': { alias: 'x', context: 1000, display: 'M One (Q)' } }),
    );
  });

  it('changes when only the effort levels change', () => {
    const base = { 'leverframe:p:m1': { effort: { levels: ['low', 'medium', 'high'], defaultLevel: 'high' } } };
    expect(computePatchConfigHash(base)).not.toBe(
      computePatchConfigHash({
        'leverframe:p:m1': { effort: { levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'high' } },
      }),
    );
  });

  it('changes when only the effort default level changes', () => {
    const base = { 'leverframe:p:m1': { effort: { levels: ['low', 'medium', 'high'], defaultLevel: 'high' } } };
    expect(computePatchConfigHash(base)).not.toBe(
      computePatchConfigHash({
        'leverframe:p:m1': { effort: { levels: ['low', 'medium', 'high'], defaultLevel: 'medium' } },
      }),
    );
  });

  it('is unaffected by adding effort: undefined explicitly', () => {
    const withoutKey = { 'leverframe:p:m1': { alias: 'x' } };
    const withUndefined = { 'leverframe:p:m1': { alias: 'x', effort: undefined } };
    expect(computePatchConfigHash(withoutKey)).toBe(computePatchConfigHash(withUndefined));
  });
});

describe('applyLeverframePatches input validation', () => {
  it('rejects an empty model config', () => {
    expect(() => applyLeverframePatches('var x = 1;', {})).toThrow(/MODEL_CONFIG is empty/);
  });

  it('rejects unsafe aliases', () => {
    expect(() => applyLeverframePatches('var x = 1;', {
      'leverframe:openai:model': { alias: 'Bad Alias!' },
    })).toThrow(/not a safe lowercase alias/);
  });

  it('rejects an explicit context on a [1m]-suffixed id (the suffix already forces 1M)', () => {
    expect(() => applyLeverframePatches('var x = 1;', {
      'leverframe:openai:model[1m]': { context: 1_000_000 },
    })).toThrow(/keeps the \[1m\] suffix/);
  });

  it('throws PatchApplyError carrying per-site results when a required anchor is missing', () => {
    let caught: unknown;
    try {
      applyLeverframePatches('var x = 1;', { 'leverframe:openai:model': { alias: 'mm' } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PatchApplyError);
    expect((caught as Error).message).toContain('required patch failed: PATCH 1');
    expect((caught as PatchApplyError).results).toEqual([
      { status: 'FAIL', name: 'PATCH 1: Agent tool model enum', extra: 'anchor not found' },
    ]);
  });
});

const CLAUDE_FIXTURE = [
  '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Defaults to inherit.`)',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
  'function opts(e,t,r){let n=cur(),o=(n==="opus")?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
  'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}',
  'function OI(e){if(SNr(e))return!1;let t=Ede(e,"effort");if(t!==void 0)return t;return!1}',
  'function IXe(e){if(SNr(e))return!1;let t=Ede(e,"xhigh_effort");if(t!==void 0)return t;return!1}',
  'function eqe(e){if(SNr(e))return!1;let t=Ede(e,"max_effort");if(t!==void 0)return t;return!1}',
  'function ait(e){return ww(lo(e))?.default_effort??"high"}',
].join('\n');

function runPatchScript(config: Parameters<typeof applyLeverframePatches>[1], source = CLAUDE_FIXTURE): string {
  return applyLeverframePatches(source, config).content;
}

function readModelPickerOptions(source: string): Array<{ value: string; label: string; description: string }> {
  const encoded = source.match(
    /\/\*ccpatch:model-picker-options\*\/var __lfcModelPickerOptions=JSON\.parse\(("(?:[^"\\]|\\.)*")\)/,
  )?.[1];
  expect(encoded).toBeDefined();
  return JSON.parse(JSON.parse(encoded!)) as Array<{ value: string; label: string; description: string }>;
}

describe('patch script identity naming', () => {
  const config = {
    'leverframe:openai-oauth:gpt-5.6-sol': {
      alias: 'sol',
      context: 272_000,
      display: 'GPT-5.6 Sol (OpenAI (ChatGPT))',
    },
    'leverframe:openai:mystery': { context: 128_000, display: 'Mystery (OpenAI)' },
  };

  it('injects the alias, not the canonical id, as the model identity', () => {
    const out = runPatchScript(config);

    expect(String(out)).toContain('.enum(["sonnet","opus","haiku","fable","sol","leverframe:openai:mystery"]).optional().describe(');
    expect(out).toContain('["sonnet","opus","haiku","fable","opusplan","sol","leverframe:openai:mystery"]');
    expect(out).not.toMatch(/\.enum\(\[[^\]]*gpt-5\.6-sol/);
    expect(out).not.toMatch(/KNOWN=\[[^\]]*gpt-5\.6-sol/);
  });

  it('resolves an alias to ITSELF so the sent name and the context-map key stay identical', () => {
    const out = runPatchScript(config);
    expect(out).toContain('case"sol":return "sol";');
    expect(out).not.toContain('case"sol":return "leverframe:openai-oauth:gpt-5.6-sol"');
  });

  it('keys the context-window table by the alias (and still by the canonical id)', () => {
    const out = runPatchScript(config);
    const table = out.match(/\/\*ccpatch:ctx\*\/var _ccw=Object\.assign\(Object\.create\(null\),JSON\.parse\(("(?:[^"\\]|\\.)*")\)\)/)?.[1];
    expect(table).toBeTruthy();
    const parsed = JSON.parse(JSON.parse(table!)) as Record<string, number>;
    expect(parsed['sol']).toBe(272_000);
    expect(parsed['leverframe:openai-oauth:gpt-5.6-sol']).toBe(272_000);
    expect(parsed['leverframe:openai:mystery']).toBe(128_000);
  });

  it('falls back to the canonical id as the identity when a model has no alias', () => {
    const out = runPatchScript({ 'leverframe:openai:mystery': { context: 128_000 } });
    expect(out).toContain('.enum(["sonnet","opus","haiku","fable","leverframe:openai:mystery"])');
    expect(out).toContain('"leverframe:openai:mystery"');
    expect(out).not.toContain('case"leverframe:openai:mystery":return');
    expect(out).not.toContain('value:"leverframe:openai:mystery"');
  });

  it('uses the real display label in the /model picker and the Agent tool description', () => {
    const out = runPatchScript(config);
    expect(readModelPickerOptions(out)).toContainEqual({
      value: 'sol',
      label: 'Sol',
      description: 'GPT-5.6 Sol (OpenAI (ChatGPT))',
    });
    expect(readModelPickerOptions(out)).toContainEqual({
      value: 'leverframe:openai:mystery',
      label: 'Mystery (OpenAI)',
      description: 'Model ID: leverframe:openai:mystery',
    });
    expect(out).not.toContain('Custom model (');
    expect(out).toContain('Additional custom models: sol = GPT-5.6 Sol (OpenAI (ChatGPT)); '
      + 'leverframe:openai:mystery = Mystery (OpenAI).');
  });

  it('falls back to the old "Custom model (id)" description when no label is known', () => {
    const out = runPatchScript({
      'leverframe:openai-oauth:gpt-5.6-sol': { alias: 'sol', context: 272_000 },
      'leverframe:openai-oauth:unknown': { context: 272_000 },
    });
    expect(readModelPickerOptions(out)).toContainEqual({
      value: 'sol',
      label: 'Sol',
      description: 'Custom model (leverframe:openai-oauth:gpt-5.6-sol)',
    });
    expect(readModelPickerOptions(out)).toContainEqual({
      value: 'leverframe:openai-oauth:unknown',
      label: 'leverframe:openai-oauth:unknown',
      description: 'Custom model (leverframe:openai-oauth:unknown)',
    });
    expect(out).toContain('Additional custom models: sol; leverframe:openai-oauth:unknown.');
  });

  it('adds each direct model identity once when no alias is configured', () => {
    const out = runPatchScript({
      'leverframe:openai:model-a': { context: 272_000, display: 'Model A (OpenAI)' },
      'leverframe:openai:model-b': { context: 128_000, display: 'Model B (OpenAI)' },
    });
    const options = readModelPickerOptions(out);
    expect(options.map(option => option.value)).toEqual([
      'leverframe:openai:model-a',
      'leverframe:openai:model-b',
    ]);
    expect(options[0]).toMatchObject({
      label: 'Model A (OpenAI)',
      description: 'Model ID: leverframe:openai:model-a',
    });
  });

  it('is idempotent when re-running the same patch', () => {
    const once = runPatchScript(config);
    expect(String(runPatchScript(config, once))).toBe(once);
  });

  it('reports OK per site on a fresh run and SKIP/refresh on a re-run', () => {
    const fresh = applyLeverframePatches(CLAUDE_FIXTURE, config);
    expect(fresh.results.map(r => [r.name, r.status])).toEqual([
      ['PATCH 1: Agent tool model enum', 'OK'],
      ['PATCH 3: known-alias validator list', 'OK'],
      ['PATCH 11: session-restore model family allowlist', 'SKIP'],
      ['PATCH 6: alias resolver switch', 'OK'],
      ['PATCH 5: model picker options', 'OK'],
      ['PATCH 4: Agent tool model description', 'OK'],
      ['PATCH 7: per-model context window', 'OK'],
      ['PATCH 10: routing notice', 'SKIP'],
      ['PATCH 10d: agent description indicator', 'SKIP'],
    ]);
    const rerun = applyLeverframePatches(fresh.content, config);
    expect(rerun.results.map(r => [r.name, r.status])).toEqual([
      ['PATCH 1: Agent tool model enum', 'SKIP'],
      ['PATCH 3: known-alias validator list', 'SKIP'],
      ['PATCH 11: session-restore model family allowlist', 'SKIP'],
      ['PATCH 6: alias resolver switch', 'SKIP'],
      ['PATCH 5: model picker options', 'SKIP'],
      ['PATCH 4: Agent tool model description', 'SKIP'],
      ['PATCH 7: per-model context window (refresh)', 'SKIP'],
      ['PATCH 10: routing notice', 'SKIP'],
      ['PATCH 10d: agent description indicator', 'SKIP'],
    ]);
  });

  it('refreshes the baked context table in place when only the window changes', () => {
    const once = runPatchScript(config);
    const updated = runPatchScript(
      { ...config, 'leverframe:openai:mystery': { context: 131_072, display: 'Mystery (OpenAI)' } },
      once,
    );
    expect(updated).not.toBe(once);
    const table = updated.match(/\/\*ccpatch:ctx\*\/var _ccw=Object\.assign\(Object\.create\(null\),JSON\.parse\(("(?:[^"\\]|\\.)*")\)\)/)?.[1];
    const parsed = JSON.parse(JSON.parse(table!)) as Record<string, number>;
    expect(parsed['leverframe:openai:mystery']).toBe(131_072);
    expect(parsed['sol']).toBe(272_000);
  });
});

describe('formatPatchSiteLine', () => {
  it('formats an OK result with no extra detail', () => {
    expect(formatPatchSiteLine({ status: 'OK', name: 'PATCH 1: example' })).toBe('  OK   PATCH 1: example');
  });

  it('formats a SKIP result with extra detail text appended after a colon', () => {
    expect(formatPatchSiteLine({ status: 'SKIP', name: 'PATCH 2: example', extra: 'anchor not recognized' }))
      .toBe('  SKIP PATCH 2: example: anchor not recognized');
  });

  it('formats a FAIL result with extra detail text appended after a colon', () => {
    expect(formatPatchSiteLine({ status: 'FAIL', name: 'PATCH 3: example', extra: 'could not be patched' }))
      .toBe('  FAIL PATCH 3: example: could not be patched');
  });
});
