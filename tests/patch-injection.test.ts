// tests/patch-injection.test.ts — marker classification used directly by the
// V2 patch transaction (src/patch-transaction.ts's defaultPatchRuntime.inspect
// and its fixture-runtime equivalents in tests/patch-v2.test.ts and
// tests/patch-lifecycle-fixture.test.ts).
import { describe, it, expect } from 'vitest';
import {
  addLeverframeInjectionMarker,
  classifyLeverframeInjectionByHash,
  LEVERFRAME_INJECTION_MARKER,
} from '../src/patch-injection.js';
import { applyLeverframePatches } from '../src/patch-transforms.js';

const BASELINE = [
  '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Defaults to inherit.`)',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
  'function opts(e,t,r){let n=cur(),o=(n==="opus")?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
  'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}',
].join('\n');
const CONFIG = { 'leverframe:openai:model': { alias: 'model', context: 272_000 } };

describe('classifyLeverframeInjectionByHash', () => {
  it('recognizes the versioned marker exactly once', () => {
    const out = addLeverframeInjectionMarker(applyLeverframePatches(BASELINE, CONFIG).content);
    expect(out.match(/\/\*leverframe:patch:[^*]*\*\//g)).toEqual([LEVERFRAME_INJECTION_MARKER]);
    expect(classifyLeverframeInjectionByHash(out, 'sha', undefined)).toEqual({
      state: 'present',
      evidence: 'marker-v1',
    });
  });

  it('recognizes a known patched hash for this exact target and the legacy ccpatch marker', () => {
    expect(classifyLeverframeInjectionByHash(BASELINE, 'patched-hash', 'patched-hash')).toEqual({
      state: 'present',
      evidence: 'manifest-hash',
    });
    expect(classifyLeverframeInjectionByHash(`${BASELINE}\n/*ccpatch:ctx*/`, 'different', undefined)).toEqual({
      state: 'present',
      evidence: 'ccpatch',
    });
  });

  it('does not credit a known patched hash that does not match this content\'s hash', () => {
    expect(classifyLeverframeInjectionByHash(BASELINE, 'actual-hash', 'a-different-known-hash')).toEqual({
      state: 'absent',
      evidence: 'none',
    });
  });

  it('treats an unknown versioned marker as ambiguous', () => {
    expect(classifyLeverframeInjectionByHash(`${BASELINE}\n/*leverframe:patch:v999*/`, 'sha', undefined)).toEqual({
      state: 'ambiguous',
      evidence: 'unknown-marker',
    });
    expect(classifyLeverframeInjectionByHash(
      `${BASELINE}\n${LEVERFRAME_INJECTION_MARKER}\n/*leverframe:patch:v999*/`,
      'sha',
      undefined,
    )).toEqual({
      state: 'ambiguous',
      evidence: 'unknown-marker',
    });
  });

  it('reports plain absence when no marker, no ccpatch text, and no known-hash match apply', () => {
    expect(classifyLeverframeInjectionByHash(BASELINE, 'sha', undefined)).toEqual({
      state: 'absent',
      evidence: 'none',
    });
  });
});

describe('addLeverframeInjectionMarker', () => {
  it('is idempotent: re-adding the marker to already-marked content is a no-op', () => {
    const once = addLeverframeInjectionMarker(BASELINE);
    expect(addLeverframeInjectionMarker(once)).toBe(once);
  });

  it('refuses to add a marker over an unrecognized/ambiguous existing marker', () => {
    expect(() => addLeverframeInjectionMarker(`${BASELINE}\n/*leverframe:patch:v999*/`)).toThrow(
      /unrecognized injection marker/,
    );
  });
});
