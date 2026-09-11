import { describe, expect, it } from 'vitest';
import { applyLeverframePatches, PatchApplyError } from '../src/patch-transforms.js';

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

function runPatchScript(
  config: Parameters<typeof applyLeverframePatches>[1],
  source = CLAUDE_FIXTURE,
): string {
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

  it('grants base effort but denies xhigh/max for the standard identity', () => {
    const out = runCapabilityPatch();
    expect(executeCapability(out, 'OI', 'standard', false)).toBe(true);
    expect(executeCapability(out, 'IXe', 'standard', true)).toBe(false);
    expect(executeCapability(out, 'eqe', 'standard', true)).toBe(false);
  });

  it.each(CAPABILITY_GATES)('denies $name for a configured model with no effort ladder', ({ functionName }) => {
    const out = runCapabilityPatch();
    expect(executeCapability(out, functionName, 'disabled', true)).toBe(false);
    expect(executeCapability(out, functionName, 'leverframe:openai:no-effort', true)).toBe(false);
    expect(executeCapability(out, functionName, 'leverframe:openai:no-effort[1m]', true)).toBe(false);
  });

  it.each(CAPABILITY_GATES)('falls through to the native/provider check only for an unconfigured $name identity', ({ functionName }) => {
    const out = runCapabilityPatch();
    expect(executeCapability(out, functionName, 'unconfigured-model', false)).toBe(false);
    expect(executeCapability(out, functionName, 'unconfigured-model', true)).toBe(true);
  });

  it.each(CAPABILITY_GATES)('keeps the native denylist ahead of a configured $name verdict', ({ functionName }) => {
    const out = runCapabilityPatch();
    expect(executeCapability(out, functionName, 'extended', false, true)).toBe(false);
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
    'returns the projected native "high" default for configured key %s',
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

  it('aborts publication when a required PATCH 8/9 anchor is missing from the binary', () => {
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

  it('is idempotent when re-running the same effort-bearing patch', () => {
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

  it('refreshes the baked verdicts in place when the config removes an effort model', () => {
    const once = runCapabilityPatch();
    const { 'leverframe:openai-oauth:gpt-5.6-sol': _removed, ...withoutExtended } = capabilityConfig;
    const updated = applyLeverframePatches(once, withoutExtended).content;
    expect(executeCapability(updated, 'IXe', 'extended', true)).toBe(true);
    expect(executeCapability(updated, 'OI', 'standard', false)).toBe(true);
  });

  it('does not grant effort capabilities the supplier ladder does not declare', () => {
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
      'leverframe:openai:reasoning-model[default]': false,
      'leverframe:openai:reasoning-model[maximum]': false,
      'leverframe:openai:reasoning-model[1m]': false,
    });
    expect(JSON.parse(maxVerdicts!)).toEqual({
      'leverframe:openai:reasoning-model': false,
      'leverframe:openai:reasoning-model[default]': false,
      'leverframe:openai:reasoning-model[maximum]': false,
      'leverframe:openai:reasoning-model[1m]': false,
    });
  });
});
