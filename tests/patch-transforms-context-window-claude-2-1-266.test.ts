import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { applyNativeContextWindow } from '../src/patch-transforms-context-window.js';

const CLAUDE_2_1_266_CONTEXT =
  'function jp(e,n){let r=HL();if(r!==void 0)return r;if(PHn(e,n))return t1;return $L(e,n)}';

const RENAMED_CONTEXT =
  'function jp($m,_o){let $r=HL();if($r!==void 0)return $r;if(PHn($m,_o))return t1;return $L($m,_o)}';

const CONTEXT_BY_KEY = {
  'leverframe:openai-oauth:gpt-current': 272_000,
  atlas: 272_000,
  'atlas[default]': 272_000,
  'atlas[maximum]': 1_203_017,
};

interface NativeContextOptions {
  constrain?: boolean;
  fallback?: number;
}

interface ContextRuntime {
  contextOverride?: number;
  __lfcContextWindows?: Record<string, unknown>;
}

function loadContextLookup(source: string, runtime: ContextRuntime = {}) {
  return runInNewContext(source + ';jp', {
    HL: () => runtime.contextOverride,
    PHn: (_model: string, options?: NativeContextOptions) => options?.constrain ?? false,
    t1: 200_000,
    $L: (model: string, options?: NativeContextOptions) =>
      options?.fallback ?? (model === 'fable' ? 1_000_000 : 200_000),
    ...runtime,
  }) as (model: string, options?: NativeContextOptions) => number;
}

describe.each([
  ['Claude Code 2.1.266', CLAUDE_2_1_266_CONTEXT],
  ['renamed minifier parameters', RENAMED_CONTEXT],
])('%s context window transform', (_version, source) => {
  it('returns the confirmed limit for canonical IDs, aliases, and context modes', () => {
    const patched = applyNativeContextWindow(source, CONTEXT_BY_KEY);

    expect(patched.result.status).toBe('OK');
    const lookup = loadContextLookup(patched.content);
    expect(lookup('leverframe:openai-oauth:gpt-current')).toBe(272_000);
    expect(lookup('  ATLAS  ')).toBe(272_000);
    expect(lookup('atlas[default]')).toBe(272_000);
    expect(lookup('atlas[maximum]')).toBe(1_203_017);
  });

  it('uses fresh runtime limits without repatching or restarting the resolver', () => {
    const patched = applyNativeContextWindow(source, CONTEXT_BY_KEY);
    const windows = { atlas: 413_579, 'new-model': 981_234 };
    const lookup = loadContextLookup(patched.content, { __lfcContextWindows: windows });

    expect(lookup('atlas')).toBe(413_579);
    expect(lookup('new-model')).toBe(981_234);
    windows.atlas = 1_203_017;
    expect(lookup('atlas')).toBe(1_203_017);
  });

  it('falls back to native limits when fresh metadata withdraws a context mode', () => {
    const patched = applyNativeContextWindow(source, CONTEXT_BY_KEY);
    const windows = { 'atlas[maximum]': 0 };
    const lookup = loadContextLookup(patched.content, { __lfcContextWindows: windows });

    expect(lookup('atlas[maximum]')).toBe(200_000);
    expect(lookup('atlas')).toBe(272_000);
    windows['atlas[maximum]'] = 1_500_000;
    expect(lookup('atlas[maximum]')).toBe(1_500_000);
  });

  it('preserves native model limits, constrained contexts, and environment overrides', () => {
    const patched = applyNativeContextWindow(source, CONTEXT_BY_KEY);
    const runtime: ContextRuntime = {};
    const lookup = loadContextLookup(patched.content, runtime);

    expect(lookup('fable')).toBe(1_000_000);
    expect(lookup('sonnet', { fallback: 300_000 })).toBe(300_000);
    expect(lookup('fable', { constrain: true })).toBe(200_000);
    runtime.contextOverride = 96_000;
    expect(lookup('fable')).toBe(96_000);
    expect(lookup('atlas')).toBe(272_000);
  });

  it('is unchanged when reapplied with the same metadata', () => {
    const first = applyNativeContextWindow(source, CONTEXT_BY_KEY);
    const second = applyNativeContextWindow(first.content, CONTEXT_BY_KEY);

    expect(first.result.status).toBe('OK');
    expect(second.result.status).toBe('SKIP');
    expect(second.content).toBe(first.content);
    expect(loadContextLookup(second.content)('atlas')).toBe(272_000);
  });

  it('refreshes limits and removes metadata that is no longer confirmed', () => {
    const first = applyNativeContextWindow(source, CONTEXT_BY_KEY);
    const second = applyNativeContextWindow(first.content, { atlas: 413_579 });

    expect(second.result.status).toBe('OK');
    const lookup = loadContextLookup(second.content);
    expect(lookup('atlas')).toBe(413_579);
    expect(lookup('atlas[maximum]')).toBe(200_000);
    expect(lookup('leverframe:openai-oauth:gpt-current')).toBe(200_000);
  });
});

describe('context window anchor validation', () => {
  it.each([
    ['missing native override', 'function jp(e,n){return $L(e,n)}'],
    ['mismatched override variable', 'function jp(e,n){let r=HL();if(q!==void 0)return q;if(PHn(e,n))return t1;return $L(e,n)}'],
    ['reversed fallback arguments', 'function jp(e,n){let r=HL();if(r!==void 0)return r;if(PHn(e,n))return t1;return $L(n,e)}'],
  ])('rejects a resolver with %s without changing its source', (_case, source) => {
    const patched = applyNativeContextWindow(source, CONTEXT_BY_KEY);

    expect(patched.result.status).toBe('FAIL');
    expect(patched.content).toBe(source);
  });

  it('rejects ambiguous native resolvers without changing either function', () => {
    const source = CLAUDE_2_1_266_CONTEXT
      + 'function kQ(e,n){let r=HL();if(r!==void 0)return r;if(PHn(e,n))return t1;return $L(e,n)}';
    const patched = applyNativeContextWindow(source, CONTEXT_BY_KEY);

    expect(patched.result.status).toBe('FAIL');
    expect(patched.result.extra).toContain('2');
    expect(patched.content).toBe(source);
  });

  it('rejects a truncated existing patch without changing its source', () => {
    const source = 'function jp(e,n){/*ccpatch:ctx*/var _ccw=void 0;return $L(e,n)}';
    const patched = applyNativeContextWindow(source, CONTEXT_BY_KEY);

    expect(patched.result.status).toBe('FAIL');
    expect(patched.content).toBe(source);
  });
});
