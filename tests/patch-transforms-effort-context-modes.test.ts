import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { applyLeverframePatches } from '../src/patch-transforms.js';

const CLAUDE_SOURCE = [
  '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent.`)',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
  'function RS(e,n){let r=FAc();if(r!==void 0)return r;if(EHi(e,n))return Dve;return $Ac(e,n)}',
  'function OI(e){if(SNr(e))return!1;let t=Ede(e,"effort");if(t!==void 0)return t;return!1}',
  'function IXe(e){if(SNr(e))return!1;let t=Ede(e,"xhigh_effort");if(t!==void 0)return t;return!1}',
  'function eqe(e){if(SNr(e))return!1;let t=Ede(e,"max_effort");if(t!==void 0)return t;return!1}',
  'function ait(e){return ww(lo(e))?.default_effort??"high"}',
].join('\n');

const CONFIG = {
  'leverframe:provider:extended': {
    alias: 'atlas',
    contextModes: { default: 272_000, maximum: 872_000 },
    effort: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'high' },
  },
  'leverframe:provider:standard': {
    alias: 'standard',
    effort: { levels: ['low', 'medium', 'high'], defaultLevel: 'high' },
  },
  'leverframe:provider:no-effort': { alias: 'plain' },
};

function readEffort(model: string, nativeCapability: boolean) {
  const patched = applyLeverframePatches(CLAUDE_SOURCE, CONFIG);
  const declarations = patched.content.split('\n')
    .filter(line => /^function (OI|IXe|eqe|ait)\(/.test(line)).join('\n');
  return runInNewContext(declarations + ';({effort:OI(model),xhigh:IXe(model),max:eqe(model),default:ait(model)})', {
    model,
    SNr: () => false,
    Ede: () => nativeCapability,
    lo: (value: string) => value,
    ww: () => ({ default_effort: 'medium' }),
  }) as { effort: boolean; xhigh: boolean; max: boolean; default: string };
}

describe.each(['[default]', '[maximum]'])('effort metadata with %s context mode', suffix => {
  it.each(['atlas', 'leverframe:provider:extended'])(
    'preserves the full effort ladder and projected default for %s',
    base => {
      expect(readEffort(base + suffix, false)).toEqual({
        effort: true, xhigh: true, max: true, default: 'high',
      });
    },
  );

  it.each(['standard', 'leverframe:provider:standard'])(
    'denies unsupported xhigh and max levels for %s',
    base => {
      expect(readEffort(base + suffix, true)).toEqual({
        effort: true, xhigh: false, max: false, default: 'high',
      });
    },
  );

  it.each(['plain', 'leverframe:provider:no-effort'])(
    'keeps all effort capabilities disabled for %s',
    base => {
      expect(readEffort(base + suffix, true)).toEqual({
        effort: false, xhigh: false, max: false, default: 'medium',
      });
    },
  );
});

describe('native effort fallback', () => {
  it.each(['fable', 'opus', 'sonnet', 'haiku'])('preserves native effort metadata for %s', model => {
    expect(readEffort(model, true)).toEqual({
      effort: true, xhigh: true, max: true, default: 'medium',
    });
    expect(readEffort(model, false)).toEqual({
      effort: false, xhigh: false, max: false, default: 'medium',
    });
  });
});
