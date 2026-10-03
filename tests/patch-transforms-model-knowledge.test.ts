import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { applyNativeModelKnowledge } from '../src/patch-transforms-model-knowledge.js';
import { applyLeverframePatches, PATCH_TRANSFORMS_VERSION } from '../src/patch-transforms.js';

const MODEL_KNOWLEDGE_SOURCE = [
  'function FL(){return["claude-known"]}',
  'var Ere=new Set(FL());',
  'function Xt(e){return String(e).toLowerCase()}',
  'function Qa(e){return e==="claude-known"?{}:void 0}',
  'var hBe="default";',
  'function Wme(e){let t=Xt(e);return Qa(t)!==void 0||Ere.has(t)||t===hBe}',
].join('');

const CONFIG = {
  'leverframe:openai-oauth:current': {
    alias: 'atlas',
    context: 272_000,
    contextModes: { default: 272_000, maximum: 872_000 },
  },
};

const CONTEXT_LOOKUP_SOURCE = [
  '.enum(["sonnet","opus","haiku","fable"]).optional().describe(' + String.fromCharCode(96) + 'Optional model override for this agent.' + String.fromCharCode(96) + ')',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
  'function opts(e,t,r){let n=cur(),o=(n==="opus")?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
  'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}',
].join('\n');

const CONTEXT_LOOKUP_STUBS = 'const FAc=()=>undefined,EHi=()=>false,Dve=200000,$Ac=()=>200000;';

const patchedModules = mkdtempSync(join(tmpdir(), 'leverframe-model-knowledge-'));
let patchedModuleCount = 0;
afterAll(() => rmSync(patchedModules, { recursive: true, force: true }));

async function loadPatchedExport<T>(source: string, name: string): Promise<T> {
  const path = join(patchedModules, `patched-${patchedModuleCount++}.mjs`);
  writeFileSync(path, `${source}\nexport { ${name} };\n`);
  const loaded = await import(pathToFileURL(path).href) as Record<string, T>;
  return loaded[name] as T;
}

const loadIsKnown = (source: string) => loadPatchedExport<(model: string) => boolean>(source, 'Wme');

async function loadContextLookup(source: string): Promise<(modelId: string) => number> {
  const declaration = source.split('\n').find(line => line.startsWith('function RS('));
  expect(declaration).toBeDefined();
  const resolveContext = await loadPatchedExport<(id: string, ignored: unknown) => number>(CONTEXT_LOOKUP_STUBS + declaration, 'RS');
  return modelId => resolveContext(modelId, undefined);
}

describe('native model knowledge transform', () => {
  it('registers only configured metadata identities, aliases, and context modes', async () => {
    const result = applyNativeModelKnowledge(MODEL_KNOWLEDGE_SOURCE, CONFIG);
    expect(result.result).toEqual({ status: 'OK', name: 'PATCH 13: native model knowledge' });

    const isKnown = await loadIsKnown(result.content);
    expect(isKnown('leverframe:openai-oauth:current')).toBe(true);
    expect(isKnown('atlas')).toBe(true);
    expect(isKnown('atlas[maximum]')).toBe(true);
    expect(isKnown('atlas[1m]')).toBe(false);
    expect(isKnown('provider:unconfirmed:model')).toBe(false);
  });

  it('uses the normalized native identity for uppercase model requests', async () => {
    const result = applyNativeModelKnowledge(MODEL_KNOWLEDGE_SOURCE, {
      'leverframe:provider:uppercase-model': { context: 272_000 },
    });
    expect(result.content).toContain('__lfcIsKnownModel(t)');
    const isKnown = await loadIsKnown(result.content);
    expect(isKnown('LEVERFRAME:PROVIDER:UPPERCASE-MODEL')).toBe(true);
  });

  it('refreshes the registered identities without retaining stale metadata', async () => {
    const first = applyNativeModelKnowledge(MODEL_KNOWLEDGE_SOURCE, CONFIG);
    const second = applyNativeModelKnowledge(first.content, {
      'leverframe:openai-oauth:replacement': { context: 400_000 },
    });
    expect(second.result).toEqual({ status: 'OK', name: 'PATCH 13: native model knowledge' });
    const isKnown = await loadIsKnown(second.content);
    expect(isKnown('leverframe:openai-oauth:replacement')).toBe(true);
    expect(isKnown('atlas')).toBe(false);
    expect(second.content.match(/ccpatch:model-knowledge/g)).toHaveLength(1);
  });
});

describe('native model knowledge context modes', () => {
  it('leaves unknown models unknown when no confirmed context metadata exists', () => {
    const result = applyNativeModelKnowledge(MODEL_KNOWLEDGE_SOURCE, {
      'leverframe:openai-oauth:unknown': {},
    });
    expect(result.result).toEqual({
      status: 'SKIP',
      name: 'PATCH 13: native model knowledge',
      extra: 'no confirmed model metadata',
    });
    expect(result.content).toBe(MODEL_KNOWLEDGE_SOURCE);
  });

  it('does not register a maximum mode without confirmed maximum metadata', async () => {
    const result = applyNativeModelKnowledge(MODEL_KNOWLEDGE_SOURCE, {
      'leverframe:provider:default-only': { context: 272_000 },
    });
    const isKnown = await loadIsKnown(result.content);
    expect(isKnown('leverframe:provider:default-only')).toBe(true);
    expect(isKnown('leverframe:provider:default-only[maximum]')).toBe(false);
  });

  it('registers the legacy one-million variant only for a reported one-million window', async () => {
    const result = applyNativeModelKnowledge(MODEL_KNOWLEDGE_SOURCE, {
      'leverframe:provider:large': { context: 1_048_576 },
    });
    const isKnown = await loadIsKnown(result.content);
    expect(isKnown('leverframe:provider:large[1m]')).toBe(true);
    expect(isKnown('leverframe:provider:large[maximum]')).toBe(false);
  });
});

describe('runtime native model knowledge', () => {
  it('honors fresh runtime tombstones without overriding native model knowledge', async () => {
    const result = applyNativeModelKnowledge(MODEL_KNOWLEDGE_SOURCE, {
      'leverframe:provider:large': {
        alias: 'atlas',
        contextModes: { default: 1_048_576, maximum: 1_500_000 },
      },
    });
    const isKnown = await loadIsKnown(result.content);
    const runtime = globalThis as typeof globalThis & {
      __lfcContextWindows?: Record<string, number>;
    };
    const previous = runtime.__lfcContextWindows;
    try {
      delete runtime.__lfcContextWindows;
      expect(isKnown('atlas[maximum]')).toBe(true);
      expect(isKnown('atlas[1m]')).toBe(true);
      runtime.__lfcContextWindows = Object.assign(Object.create(null), {
        'atlas[maximum]': 0,
        'atlas[1m]': 0,
      });
      expect(isKnown('atlas[maximum]')).toBe(false);
      expect(isKnown('atlas[1m]')).toBe(false);
      runtime.__lfcContextWindows = Object.assign(Object.create(null), {
        'claude-known': 0,
      });
      expect(isKnown('claude-known')).toBe(true);
    } finally {
      if (previous === undefined) delete runtime.__lfcContextWindows;
      else runtime.__lfcContextWindows = previous;
    }
  });

  it('fails closed when a native module graph lacks the model knowledge anchor', () => {
    const result = applyNativeModelKnowledge(
      '\n//#__leverframe_claude_module__:cli\nfunction unrelated(){return 1}',
      CONFIG,
    );
    expect(result.result).toEqual({
      status: 'FAIL',
      name: 'PATCH 13: native model knowledge',
      extra: 'native model knowledge anchor not found',
    });
  });
});

describe('native context lookup integration', () => {
  it('bakes confirmed mode limits and consumes the selected fresh runtime limit', async () => {
    const result = applyLeverframePatches(CONTEXT_LOOKUP_SOURCE, {
      'leverframe:provider:reported': {
        alias: 'atlas',
        context: 272_000,
        contextModes: { default: 272_000, maximum: 872_000 },
      },
    });
    const cleared = applyLeverframePatches(result.content, {
      'leverframe:provider:reported': { alias: 'atlas' },
    });
    const large = applyLeverframePatches(CONTEXT_LOOKUP_SOURCE, {
      'leverframe:provider:large': {
        alias: 'large',
        contextModes: { default: 1_048_576, maximum: 1_500_000 },
      },
    });
    const [lookup, clearedLookup, largeLookup] = await Promise.all(
      [result, cleared, large].map(patched => loadContextLookup(patched.content)),
    );
    const runtime = globalThis as typeof globalThis & {
      __lfcContextWindows?: Record<string, number>;
    };
    const previous = runtime.__lfcContextWindows;
    try {
      delete runtime.__lfcContextWindows;
      expect(lookup!('atlas')).toBe(272_000);
      expect(lookup!('atlas[maximum]')).toBe(872_000);
      runtime.__lfcContextWindows = Object.assign(Object.create(null), {
        atlas: 1_203_017,
        'atlas[maximum]': 1_203_017,
      });
      expect(lookup!('atlas')).toBe(1_203_017);
      runtime.__lfcContextWindows = Object.assign(Object.create(null), {
        atlas: 413_579,
        'atlas[default]': 413_579,
      });
      expect(lookup!('atlas')).toBe(413_579);
      delete runtime.__lfcContextWindows;
      expect(clearedLookup!('atlas')).toBe(200_000);
      expect(largeLookup!('large[1m]')).toBe(1_048_576);
    } finally {
      if (previous === undefined) delete runtime.__lfcContextWindows;
      else runtime.__lfcContextWindows = previous;
    }
  });

});

describe('reported native context metadata', () => {
  it('keeps every external known key backed by a reported or fresh context window', async () => {
    const config = {
      'leverframe:provider:default-only': { alias: 'default-only', context: 272_000 },
      'leverframe:provider:large': { alias: 'large', context: 1_048_576 },
      'leverframe:provider:modes': {
        alias: 'modes',
        contextModes: { default: 272_000, maximum: 872_000 },
      },
    };
    const knowledge = applyNativeModelKnowledge(MODEL_KNOWLEDGE_SOURCE, config);
    const isKnown = await loadIsKnown(knowledge.content);
    const lookup = await loadContextLookup(applyLeverframePatches(CONTEXT_LOOKUP_SOURCE, config).content);
    const staticRows: Array<[string, number]> = [
      ['default-only', 272_000],
      ['default-only[default]', 272_000],
      ['large', 1_048_576],
      ['large[default]', 1_048_576],
      ['large[1m]', 1_048_576],
      ['modes', 272_000],
      ['modes[default]', 272_000],
      ['modes[maximum]', 872_000],
    ];
    const runtime = globalThis as typeof globalThis & {
      __lfcContextWindows?: Record<string, number>;
    };
    const previous = runtime.__lfcContextWindows;
    try {
      delete runtime.__lfcContextWindows;
      for (const [model, contextWindow] of staticRows) {
        expect(isKnown(model)).toBe(true);
        expect(lookup(model)).toBe(contextWindow);
      }
      expect(isKnown('default-only[maximum]')).toBe(false);
      expect(isKnown('modes[1m]')).toBe(false);

      runtime.__lfcContextWindows = Object.assign(Object.create(null), {
        'default-only[maximum]': 901_234,
        'large[1m]': 0,
      });
      expect(isKnown('default-only[maximum]')).toBe(true);
      expect(lookup('default-only[maximum]')).toBe(901_234);
      expect(isKnown('large[1m]')).toBe(false);
      expect(lookup('large[1m]')).toBe(200_000);
    } finally {
      if (previous === undefined) delete runtime.__lfcContextWindows;
      else runtime.__lfcContextWindows = previous;
    }
  });
});

describe('patch transform version', () => {
  it('keeps the transform version ahead of older static context patches', () => {
    expect(PATCH_TRANSFORMS_VERSION).toBe(21);
  });
});
