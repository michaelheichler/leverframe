import { describe, expect, it } from 'vitest';
import { applyLeverframePatches } from '../src/patch-transforms.js';

const CLAUDE_FIXTURE = [
  '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent.`)',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
  'function opts(e,t,r){let n=cur(),o=(n==="opus")?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
  'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}',
].join('\n');

function executeContextLookup(source: string, modelId: string, fallback: number): number {
  const declaration = source.split('\n').find(line => line.startsWith('function RS('));
  expect(declaration).toBeDefined();
  const resolveContext = Function(
    'FAc',
    'EHi',
    'Dve',
    '$Ac',
    `${declaration};return RS;`,
  )(
    () => undefined,
    () => false,
    fallback,
    () => fallback,
  ) as (id: string, ignored: unknown) => number;
  return resolveContext(modelId, undefined);
}

describe('prototype-name custom model identities', () => {
  it('keeps display fallbacks and context windows for constructor and __proto__', () => {
    const config = Object.assign(Object.create(null), {
      'leverframe:demo:constructor': { alias: 'constructor', context: 310_000 },
      ['__proto__']: { context: 320_000 },
    });
    const output = applyLeverframePatches(CLAUDE_FIXTURE, config).content;

    expect(output).toContain(
      '{value:"constructor",label:"Constructor",description:"Custom model (leverframe:demo:constructor)"}',
    );
    expect(output).toContain('Additional custom models: constructor; __proto__.');
    expect(executeContextLookup(output, 'constructor', 200_000)).toBe(310_000);
    expect(executeContextLookup(output, '__proto__', 200_000)).toBe(320_000);
  });

  it('falls back to native context when constructor and __proto__ have no configured window', () => {
    const config = Object.assign(Object.create(null), {
      'leverframe:demo:sol': { alias: 'sol', context: 310_000 },
      'leverframe:demo:constructor': { alias: 'constructor' },
      ['__proto__']: {},
    });
    const output = applyLeverframePatches(CLAUDE_FIXTURE, config).content;

    expect(executeContextLookup(output, 'sol', 200_000)).toBe(310_000);
    expect(executeContextLookup(output, 'constructor', 200_000)).toBe(200_000);
    expect(executeContextLookup(output, '__proto__', 200_000)).toBe(200_000);
  });

  it('refreshes a legacy normal-object context table', () => {
    const config = { 'leverframe:demo:sol': { alias: 'sol', context: 310_000 } };
    const patched = applyLeverframePatches(CLAUDE_FIXTURE, config).content;
    const legacy = patched.replace(
      /\/\*ccpatch:ctx\*\/var _ccw=Object\.assign\(Object\.create\(null\),JSON\.parse\(("(?:[^"\\]|\\.)*")\)\)(\[String\(e\|\|""\)\.trim\(\)\.toLowerCase\(\)\];if\(_ccw!==void 0\)return;)/,
      (_match, table, lookup) => '/*ccpatch:ctx*/var _ccw=(' + JSON.parse(table) + ')' + lookup,
    );
    const refreshed = applyLeverframePatches(
      legacy,
      { 'leverframe:demo:sol': { alias: 'sol', context: 320_000 } },
    ).content;

    expect(executeContextLookup(refreshed, 'sol', 200_000)).toBe(320_000);
  });
});
