import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDesiredPatchConfig,
  buildPatchModelConfig,
  computePatchConfigHash,
  reasoningEffortForPatch,
} from '../src/patcher.js';
import { applyLeverframePatches, formatPatchSiteLine, PatchApplyError, PATCH_TRANSFORMS_VERSION, projectNativeEffort } from '../src/patch-transforms.js';
import type { CachedModel, RegistryProvider } from '../src/registry/types.js';

describe('buildPatchModelConfig', () => {
  const favorites = [
    { providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    { providerId: 'openai-oauth', modelId: 'gpt-5.6-luna' },
    { providerId: 'openai', modelId: 'mystery-model' },
  ];
  const aliases = [
    { name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
  ];
  const meta = new Map([
    ['openai-oauth:gpt-5.6-sol', { contextWindow: 272_000, displayName: 'GPT-5.6 Sol (OpenAI (ChatGPT))' }],
    ['openai-oauth:gpt-5.6-luna', { contextWindow: 272_000, displayName: 'GPT-5.6 Luna (OpenAI (ChatGPT))' }],
  ]);

  it('builds leverframe-prefixed entries with aliases, context windows, and display labels', () => {
    const { config, unknownWindows } = buildPatchModelConfig(
      favorites,
      aliases,
      (providerId, modelId) => meta.get(`${providerId}:${modelId}`),
    );

    expect(config['leverframe:openai-oauth:gpt-5.6-sol']).toEqual({
      alias: 'sol',
      context: 272_000,
      display: 'GPT-5.6 Sol (OpenAI (ChatGPT))',
    });
    expect(config['leverframe:openai-oauth:gpt-5.6-luna']).toEqual({
      context: 272_000,
      display: 'GPT-5.6 Luna (OpenAI (ChatGPT))',
    });
    expect(config['leverframe:openai:mystery-model']).toEqual({});
    expect(unknownWindows).toEqual(['leverframe:openai:mystery-model']);
  });

  it('omits context when the window equals the 200k default', () => {
    const { config, unknownWindows } = buildPatchModelConfig(
      [{ providerId: 'openai', modelId: 'davinci-002' }],
      [],
      () => ({ contextWindow: 200_000 }),
    );
    expect(config['leverframe:openai:davinci-002']).toEqual({});
    expect(unknownWindows).toEqual([]);
  });

  it('omits a blank display label rather than baking an empty string', () => {
    const { config } = buildPatchModelConfig(
      [{ providerId: 'openai', modelId: 'davinci-002' }],
      [],
      () => ({ contextWindow: 272_000, displayName: '   ' }),
    );
    expect(config['leverframe:openai:davinci-002']).toEqual({ context: 272_000 });
  });

  it('bakes the Kimi Coding Plan alias and k3 context under the same model identity', () => {
    const { config, unknownWindows } = buildPatchModelConfig(
      [{ providerId: 'kimi', modelId: 'k3' }],
      [{ name: 'kimi3', providerId: 'kimi', modelId: 'k3' }],
      () => ({ contextWindow: 1_048_576, displayName: 'Kimi 3 (Kimi (Coding Plan))' }),
    );

    expect(config['leverframe:kimi:k3']).toEqual({
      alias: 'kimi3',
      context: 1_048_576,
      display: 'Kimi 3 (Kimi (Coding Plan))',
    });
    expect(unknownWindows).toEqual([]);
  });

  it('projects a GPT-5.6-shaped effort ladder onto the native picker with a high default', () => {
    const { config } = buildPatchModelConfig(
      [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
      [{ name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
      () => ({
        contextWindow: 272_000,
        displayName: 'GPT-5.6 Sol (OpenAI (ChatGPT))',
        effort: { levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'medium' },
      }),
    );
    expect(config['leverframe:openai-oauth:gpt-5.6-sol']?.effort).toEqual({
      levels: ['low', 'medium', 'high', 'xhigh'],
      defaultLevel: 'high',
    });
  });

  it.each([
    { name: 'an incomplete base (no low/medium)', levels: ['high', 'xhigh'], defaultLevel: 'high' },
    { name: 'a default outside the native ladder', levels: ['none', 'low', 'medium', 'high'], defaultLevel: 'none' },
  ])('silently omits client effort metadata for $name rather than throwing', ({ levels, defaultLevel }) => {
    const { config } = buildPatchModelConfig(
      [{ providerId: 'openai', modelId: 'reasoning-model' }],
      [],
      () => ({ contextWindow: 200_000, effort: { levels, defaultLevel } }),
    );
    expect(config['leverframe:openai:reasoning-model']).toEqual({});
  });
});

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
    expect(reasoningEffortForPatch(provider, { ...baseModel, id: 'gpt-4o', upstreamModelId: 'gpt-4o' })).toBeUndefined();
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
});

describe('buildPatchModelConfig context provenance', () => {
  it('marks a confirmed context window with provenance "confirmed" and bakes it', () => {
    const { config, unknownWindows, provenance } = buildPatchModelConfig(
      [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
      [],
      () => ({ contextWindow: 272_000 }),
    );
    expect(config['leverframe:openai-oauth:gpt-5.6-sol']?.context).toBe(272_000);
    expect(unknownWindows).toEqual([]);
    expect(provenance['leverframe:openai-oauth:gpt-5.6-sol']).toBe('confirmed');
  });

  it('marks an unconfirmed context window with provenance "unconfirmed", omits context, and skips unknownWindows', () => {
    const { config, unknownWindows, provenance } = buildPatchModelConfig(
      [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
      [],
      () => ({ contextWindow: undefined, contextWindowUnconfirmed: true }),
    );
    expect(config['leverframe:openai-oauth:gpt-5.6-sol']).not.toHaveProperty('context');
    expect(unknownWindows).toEqual([]);
    expect(provenance['leverframe:openai-oauth:gpt-5.6-sol']).toBe('unconfirmed');
  });

  it('marks a genuinely missing context window with provenance "missing" and pushes it to unknownWindows', () => {
    const { config, unknownWindows, provenance } = buildPatchModelConfig(
      [{ providerId: 'openai', modelId: 'davinci-002' }],
      [],
      () => ({ contextWindow: undefined }),
    );
    expect(config['leverframe:openai:davinci-002']).not.toHaveProperty('context');
    expect(unknownWindows).toEqual(['leverframe:openai:davinci-002']);
    expect(provenance['leverframe:openai:davinci-002']).toBe('missing');
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

type CapabilityFunctionName = 'OI' | 'IXe' | 'eqe';

function executeCapability(
  source: string,
  functionName: CapabilityFunctionName,
  modelId: string,
  nativeFallback: boolean,
  denied = false,
): boolean {
  const declaration = source.split('\n').find(line => line.startsWith(`function ${functionName}(`));
  expect(declaration).toBeDefined();
  const capability = Function(
    'SNr',
    'Ede',
    `${declaration};return ${functionName};`,
  )(
    () => denied,
    () => (nativeFallback ? true : undefined),
  ) as (id: string) => boolean;
  return capability(modelId);
}

function executeDefaultEffort(source: string, modelId: string, nativeDefault: string): string {
  const declaration = source.split('\n').find(line => line.startsWith('function ait('));
  expect(declaration).toBeDefined();
  const defaultEffort = Function(
    'lo',
    'ww',
    `${declaration};return ait;`,
  )(
    (id: string) => id,
    () => ({ default_effort: nativeDefault }),
  ) as (id: string) => string;
  return defaultEffort(modelId);
}

const CAPABILITY_GATES: Array<{ name: string; functionName: CapabilityFunctionName }> = [
  { name: 'base effort', functionName: 'OI' },
  { name: 'xhigh effort', functionName: 'IXe' },
  { name: 'max effort', functionName: 'eqe' },
];

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
    expect(out).toContain('{value:"sol",label:"Sol",description:"GPT-5.6 Sol (OpenAI (ChatGPT))"}');
    expect(out).not.toContain('Custom model (');
    expect(out).toContain('Additional custom models: sol = GPT-5.6 Sol (OpenAI (ChatGPT)); '
      + 'leverframe:openai:mystery = Mystery (OpenAI).');
  });

  it('falls back to the old "Custom model (id)" description when no label is known', () => {
    const out = runPatchScript({ 'leverframe:openai-oauth:gpt-5.6-sol': { alias: 'sol', context: 272_000 } });
    expect(out).toContain('{value:"sol",label:"Sol",description:"Custom model (leverframe:openai-oauth:gpt-5.6-sol)"}');
    expect(out).toContain('Additional custom models: sol.');
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

describe('PATCH 8/9 effort capability gates', () => {
  const capabilityConfig = {
    'leverframe:openai:gpt-5.5': {
      alias: 'standard',
      effort: { levels: ['low', 'medium', 'high'], defaultLevel: 'high' },
    },
    'leverframe:openai-oauth:gpt-5.6-sol': {
      alias: 'extended',
      effort: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'medium' },
    },
    'leverframe:openai:no-effort': {
      alias: 'disabled',
    },
  };

  function runCapabilityPatch(): string {
    return runPatchScript(capabilityConfig);
  }

  it('injects all four effort markers and bakes the projected high default for GPT-5.6', () => {
    const out = runCapabilityPatch();
    expect(out).toContain('/*ccpatch:effort*/');
    expect(out).toContain('/*ccpatch:xhigh-effort*/');
    expect(out).toContain('/*ccpatch:max-effort*/');
    expect(out).toContain('/*ccpatch:default-effort*/');
    expect(out).toContain('"extended":"high"');
  });

  it.each(CAPABILITY_GATES)('grants configured $name to the extended (GPT-5.6) identity, bare and [1m]', ({ functionName }) => {
    const out = runCapabilityPatch();
    expect(executeCapability(out, functionName, 'extended', false)).toBe(true);
    expect(executeCapability(out, functionName, 'extended[1m]', false)).toBe(true);
  });

  it('grants base effort but denies xhigh/max for the standard (GPT-5.5-shaped) identity', () => {
    const out = runCapabilityPatch();
    expect(executeCapability(out, 'OI', 'standard', false)).toBe(true);
    expect(executeCapability(out, 'IXe', 'standard', true)).toBe(false);
    expect(executeCapability(out, 'eqe', 'standard', true)).toBe(false);
  });

  it.each(CAPABILITY_GATES)('denies $name for a configured model with no effort ladder (explicit false, not fallthrough)', ({ functionName }) => {
    const out = runCapabilityPatch();
    expect(executeCapability(out, functionName, 'disabled', true)).toBe(false);
    expect(executeCapability(out, functionName, 'leverframe:openai:no-effort', true)).toBe(false);
    expect(executeCapability(out, functionName, 'leverframe:openai:no-effort[1m]', true)).toBe(false);
  });

  it.each(CAPABILITY_GATES)('falls through to the native/provider check only for a genuinely unconfigured $name identity', ({ functionName }) => {
    const out = runCapabilityPatch();
    expect(executeCapability(out, functionName, 'unconfigured-model', false)).toBe(false);
    expect(executeCapability(out, functionName, 'unconfigured-model', true)).toBe(true);
  });

  it.each(CAPABILITY_GATES)('keeps the native denylist ahead of a configured $name verdict', ({ functionName }) => {
    const out = runCapabilityPatch();
    expect(executeCapability(out, functionName, 'extended', false, /* denied */ true)).toBe(false);
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'treats prototype-name identity %s as unconfigured (Object.create(null) safety)',
    modelId => {
      const out = runCapabilityPatch();
      for (const { functionName } of CAPABILITY_GATES) {
        expect(executeCapability(out, functionName, modelId, false)).toBe(false);
        expect(executeCapability(out, functionName, modelId, true)).toBe(true);
      }
      expect(executeDefaultEffort(out, modelId, 'medium')).toBe('medium');
    },
  );

  it.each(['extended', 'extended[1m]', 'leverframe:openai-oauth:gpt-5.6-sol', 'leverframe:openai-oauth:gpt-5.6-sol[1m]'])(
    'returns the projected native "high" default for configured key %s, overriding a native medium',
    modelId => {
      expect(executeDefaultEffort(runCapabilityPatch(), modelId, 'medium')).toBe('high');
    },
  );

  it('falls through to the native default for an unconfigured identity', () => {
    expect(executeDefaultEffort(runCapabilityPatch(), 'unconfigured-model', 'medium')).toBe('medium');
  });

  it('rejects a custom alias that shadows a reserved built-in identity', () => {
    expect(() => applyLeverframePatches(CLAUDE_FIXTURE, {
      'leverframe:openai:model': { alias: 'opus' },
    })).toThrow(/reserved alias/);
  });

  it.each([
    { levels: ['low', 'high'], defaultLevel: 'high' },
    { levels: ['low', 'medium', 'high'], defaultLevel: 'max' },
  ])('rejects effort metadata that cannot project onto the native ladder', effort => {
    expect(() => applyLeverframePatches(CLAUDE_FIXTURE, {
      'leverframe:openai:model': { effort },
    })).toThrow(/must declare at least low\/medium\/high with a declared default level/);
  });

  it('skips PATCH 8/9 entirely when no configured model declares an effort ladder', () => {
    const fresh = applyLeverframePatches(CLAUDE_FIXTURE, {
      'leverframe:openai:model': { alias: 'plain' },
    });
    expect(fresh.results.some(r => r.name.startsWith('PATCH 8') || r.name.startsWith('PATCH 9'))).toBe(false);
    expect(fresh.content).not.toContain('ccpatch:effort');
    expect(fresh.content).not.toContain('ccpatch:default-effort');
  });

  it('aborts publication (throws) when a required PATCH 8/9 anchor is missing from the binary', () => {
    const brokenFixture = CLAUDE_FIXTURE.split('\n').filter(line => !line.startsWith('function OI(')).join('\n');
    let caught: unknown;
    try {
      applyLeverframePatches(brokenFixture, capabilityConfig);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PatchApplyError);
    expect((caught as Error).message).toContain('required patch failed: PATCH 8a: effort capability');
    const results = (caught as PatchApplyError).results;
    expect(results.find(r => r.name === 'PATCH 8a: effort capability')).toEqual({
      status: 'FAIL',
      name: 'PATCH 8a: effort capability',
      extra: 'anchor not found',
    });
  });

  it('is idempotent when re-running the same effort-bearing patch (refresh path)', () => {
    const once = runCapabilityPatch();
    const rerun = applyLeverframePatches(once, capabilityConfig);
    expect(rerun.results.filter(r => r.name.startsWith('PATCH 8') || r.name.startsWith('PATCH 9')))
      .toEqual([
        { status: 'SKIP', name: 'PATCH 8a: effort capability (refresh)', extra: 'already patched' },
        { status: 'SKIP', name: 'PATCH 8b: xhigh effort capability (refresh)', extra: 'already patched' },
        { status: 'SKIP', name: 'PATCH 8c: max effort capability (refresh)', extra: 'already patched' },
        { status: 'SKIP', name: 'PATCH 9: default effort (refresh)', extra: 'already patched' },
      ]);
    expect(rerun.content).toBe(once);
  });

  it('refreshes the baked verdicts in place when the config changes (removal takes effect)', () => {
    const once = runCapabilityPatch();
    const { 'leverframe:openai-oauth:gpt-5.6-sol': _removed, ...withoutExtended } = capabilityConfig;
    const updated = applyLeverframePatches(once, withoutExtended).content;
    expect(executeCapability(updated, 'IXe', 'extended', true)).toBe(true); // no longer configured -> native fallback
    expect(executeCapability(updated, 'OI', 'standard', false)).toBe(true); // untouched entry still wins
  });

  it('does not grant effort capabilities the supplier ladder does not declare (base-only levels)', () => {
    const out = runPatchScript({
      'leverframe:openai:reasoning-model': {
        effort: { levels: ['low', 'medium', 'high'], defaultLevel: 'high' },
      },
    });
    const xhighVerdicts = out.match(
      /\/\*ccpatch:xhigh-effort\*\/var _ccv=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/,
    )?.[1];
    const maxVerdicts = out.match(
      /\/\*ccpatch:max-effort\*\/var _ccv=Object\.assign\(Object\.create\(null\),(\{[^{}]*\})\)/,
    )?.[1];
    expect(JSON.parse(xhighVerdicts!)).toEqual({
      'leverframe:openai:reasoning-model': false,
      'leverframe:openai:reasoning-model[1m]': false,
    });
    expect(JSON.parse(maxVerdicts!)).toEqual({
      'leverframe:openai:reasoning-model': false,
      'leverframe:openai:reasoning-model[1m]': false,
    });
  });
});

describe('PATCH_TRANSFORMS_VERSION', () => {
  it('is bumped for the agent description indicator (PATCH 10d)', () => {
    expect(PATCH_TRANSFORMS_VERSION).toBe(7);
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
