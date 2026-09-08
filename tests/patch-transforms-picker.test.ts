import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as typescript from 'typescript';
import { applyNativeContextPicker } from '../src/patch-transforms-picker.js';

const SANITIZED_PICKER_FIXTURE = readFileSync(
  join(import.meta.dirname, 'fixtures', 'claude-picker-2.1.263.js'),
  'utf8',
);

function pickerSource(): string {
  return [
    'function nativeModelOptions(Ct,fo,w){let Ki=[];for(let[As,Ls,va]of[[fo.current,fo.value,"Current model"],[fo.sessionOverride===null?null:w,w===null?Qw:umt(Ct,w)??w,"Base model"]])if(As!==null&&!Ct.some((Bi)=>Bi.value===Ls)&&!Ki.some((Bi)=>Bi.value===As)&&Rr(As))Ki.push({value:As,label:WC(As),description:va});let qi=Ct.findIndex((As)=>As.disabled===!0);if(qi===-1)return[...Ct,...Ki];return[...Ct.slice(0,qi),...Ki,...Ct.slice(qi)]}',
    'function nativeModelFocus(Fn,fo){return Fn.some((Ki)=>Ki.value===fo.value)?fo.value:Fn[0]?.value??void 0}',
    'function nativeSelectedValue(Ct,to,umt,Qw){let zt=to===null?Qw:umt(Ct,to)??to;return zt}',
    'function picker({initial:initialModel,sessionModel:session,onSelect:select,onSetDefault:setDefault,onCancel:cancel,isStandaloneCommand:standalone,showFastModeNotice:notice,headerText:header,options:options,skipSettingsWrite:skip}){',
    'let[state,setState]=useState(null);',
    'if(false){let Oe;let Zt;let Ct=V(()=>Oe??fdn(Zt),[Oe,Zt]);void Ct;}',
    'function choose(model,effort){if(model===null){select(null,effort);return}select(model,effort)}',
    'let result=createElement(Picker,{options:options,onChange:function(value){choose(value,"high")},onCancel:cancel});return result}',
  ].join('');
}

type PickerUseState = (initial: unknown) => [unknown, (value: unknown) => void];
type PickerCreateElement = (type: unknown, props: Record<string, unknown>) => { props: Record<string, unknown> };
type PickerFetch = () => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
type PickerHarness = {
  picker: (props: Record<string, unknown>) => { props: Record<string, unknown> };
  props: Record<string, unknown>;
  selected: unknown[][];
  baseCancelled: () => number;
};

function createPickerHarness(source: string, fetch: PickerFetch): PickerHarness {
  let state: unknown = null;
  const selected: unknown[][] = [];
  let cancelled = 0;
  const useState: PickerUseState = (initial: unknown): [unknown, (value: unknown) => void] => [
    state ?? initial,
    value => { state = value; },
  ];
  const createElement: PickerCreateElement = (_type: unknown, props: Record<string, unknown>) => ({ props });
  const fakeProcess = { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:17645', ANTHROPIC_API_KEY: 'token' } };
  const factory = new Function('useState', 'createElement', 'Picker', 'fetch', 'process', [
    source,
    ';return picker;',
  ].join('\n')) as (
    useState: PickerUseState,
    createElement: PickerCreateElement,
    Picker: object,
    fetch: PickerFetch,
    process: typeof fakeProcess,
  ) => PickerHarness['picker'];
  const picker = factory(useState, createElement, {}, fetch, fakeProcess);
  const props: Record<string, unknown> = {
    initial: 'base',
    sessionModel: 'base',
    onSelect: (...args: unknown[]) => selected.push(args),
    onSetDefault: undefined,
    onCancel: () => { cancelled++; },
    isStandaloneCommand: false,
    showFastModeNotice: false,
    headerText: undefined,
    options: [{ value: 'leverframe:provider:model', label: 'Model' }],
    skipSettingsWrite: false,
  };
  return { picker, props, selected, baseCancelled: () => cancelled };
}

describe('native context picker transform', () => {
  it('matches the sanitized Claude 2.1.263 picker structure', () => {
      const result = applyNativeContextPicker(SANITIZED_PICKER_FIXTURE, {
        'leverframe:provider:model': { default: 272_000, maximum: 872_000 },
      });
      expect(result.result).toEqual({ status: 'OK', name: 'PATCH 12: context mode picker' });
      expect(result.content).toContain(
        'Bi.value===Ls||(__lfcContextIdentity(Bi.value)===__lfcContextIdentity(Ls))',
      );
      expect(result.content).toContain(
        'Fn.find((Ki)=>Ki.value===fo.value||(__lfcContextIdentity(Ki.value)===__lfcContextIdentity(fo.value)))',
      );
      const pickerModule = result.content
        .split('\n//#__leverframe_claude_module__:')
        .find(module => module.includes('function RZ({initial:'));
      expect(pickerModule).toBeDefined();
      const pickerStart = pickerModule!.indexOf('function RZ({initial:');
      const parseableModule = pickerModule!
        .slice(pickerStart)
        .replace(/\nexport\{[\s\S]*$/, '')
        .replace(/\bimport\.meta\b/g, '({})');
      const parsed = typescript.transpileModule(parseableModule, {
        reportDiagnostics: true,
        compilerOptions: {
          module: typescript.ModuleKind.CommonJS,
          target: typescript.ScriptTarget.ES2022,
        },
      });
      expect(parsed.diagnostics ?? []).toHaveLength(0);
  });

  it('discovers renamed picker identifiers from the prop shape and switches modes at runtime', async () => {
    const source = pickerSource();
    const result = applyNativeContextPicker(source, {
      'leverframe:provider:model': { default: 272_000, maximum: 872_000 },
    });
    expect(result.result).toEqual({ status: 'OK', name: 'PATCH 12: context mode picker' });
    expect(result.content).toContain('__lfcBeginContext(model,effort)');
    expect(result.content).toContain('/v1/leverframe/context-selection');
    expect(result.content).not.toContain('272000');
    expect(result.content).not.toContain('872000');

    let state: unknown = null;
    const selected: unknown[][] = [];
    type PickerUseState = (initial: unknown) => [unknown, (value: unknown) => void];
    type PickerCreateElement = (type: unknown, props: Record<string, unknown>) => { props: Record<string, unknown> };
    type PickerFetch = () => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
    const useState: PickerUseState = (initial: unknown): [unknown, (value: unknown) => void] => [
      state ?? initial,
      value => { state = value; },
    ];
    const createElement: PickerCreateElement = (_type: unknown, props: Record<string, unknown>) => ({ props });
    const fetch: PickerFetch = async () => ({
      ok: true,
      json: async () => ({
        options: [
          { mode: 'default', contextWindow: 272_000, label: 'Default (272,000)' },
          { mode: 'maximum', contextWindow: 872_000, label: 'Maximum (872,000)' },
        ],
      }),
    });
    const fakeProcess = { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:17645', ANTHROPIC_API_KEY: 'token' } };
    const factory = new Function('useState', 'createElement', 'Picker', 'fetch', 'process', [
      result.content,
      ';return picker;',
    ].join('\n')) as (
      useState: PickerUseState,
      createElement: PickerCreateElement,
      Picker: object,
      fetch: PickerFetch,
      process: typeof fakeProcess,
    ) => (props: Record<string, unknown>) => { props: Record<string, unknown> };
    const picker = factory(useState, createElement, {}, fetch, fakeProcess);
    const props = {
      initial: 'base',
      sessionModel: 'base',
      onSelect: (...args: unknown[]) => selected.push(args),
      onSetDefault: undefined,
      onCancel: () => undefined,
      isStandaloneCommand: false,
      showFastModeNotice: false,
      headerText: undefined,
      options: [{ value: 'leverframe:provider:model', label: 'Model' }],
      skipSettingsWrite: false,
    };
    const first = picker(props);
    (first.props.onChange as (value: string) => void)('leverframe:provider:model');
    const loading = picker(props);
    expect((loading.props.options as Array<{ label: string }>)[0]!.label).toContain('Refreshing');
    await new Promise(resolve => setTimeout(resolve, 0));
    const ready = picker(props);
    expect(ready.props.options).toEqual([
      { value: 'default', label: 'Default (272,000)' },
      { value: 'maximum', label: 'Maximum (872,000)' },
    ]);
    (ready.props.onChange as (value: string) => void)('maximum');
    expect(selected).toEqual([['leverframe:provider:model[maximum]', 'high']]);
  });

  it('keeps a session context mode on the base picker row', () => {
    const result = applyNativeContextPicker(pickerSource(), {
      'leverframe:provider:model': { default: 272_000, maximum: 872_000 },
      atlas: { default: 272_000, maximum: 872_000 },
    }, {
      atlas: 'leverframe:provider:model',
    });
    expect(result.result).toEqual({ status: 'OK', name: 'PATCH 12: context mode picker' });
    expect(result.content).toContain(
      '!Ct.some((Bi)=>Bi.value===Ls||(__lfcContextIdentity(Bi.value)===__lfcContextIdentity(Ls)))',
    );
    expect(result.content).toContain(
      '!Ki.some((Bi)=>Bi.value===As||(__lfcContextIdentity(Bi.value)===__lfcContextIdentity(As)))',
    );
    expect(result.content).toContain(
      'Fn.find((Ki)=>Ki.value===fo.value||(__lfcContextIdentity(Ki.value)===__lfcContextIdentity(fo.value)))?.value??Fn[0]?.value??void 0',
    );
    expect(result.content).toContain(
      'zt=to===null?Qw:Ct.find((option)=>__lfcContextIdentity(option.value)===__lfcContextIdentity(umt(Ct,to)))?.value??Ct.find((option)=>__lfcContextIdentity(option.value)===__lfcContextIdentity(to))?.value??umt(Ct,to)??to;',
    );
    expect(result.content).toContain(
      'Ct=V(()=>__lfcNormalizeContextOptions(Oe??fdn(Zt)),[Oe,Zt])',
    );

    const factory = new Function('Qw', 'umt', 'Rr', 'WC', result.content + ';return {nativeModelOptions,nativeModelFocus,nativeSelectedValue,normalize:__lfcNormalizeContextOptions};') as (
      noPreference: string,
      mapModel: (options: Array<{ value: string }>, model: string) => string,
      isRoutable: (model: string) => boolean,
      displayModel: (model: string) => string,
    ) => {
      nativeModelOptions: (options: Array<{ value: string }>, state: Record<string, unknown>, base: string | null) => Array<{ value: string }>;
      nativeModelFocus: (options: Array<{ value: string }>, state: { value: string }) => string | undefined;
      nativeSelectedValue: (options: Array<{ value: string }>, model: string, resolveModel: (options: Array<{ value: string }>, model: string) => string | undefined, noPreference: string) => string;
      normalize: (options: Array<{ value: string }>) => Array<{ value: string }>;
    };
    const native = factory('__no_preference__', (_options, model) => model, () => true, model => model);
    expect(native.nativeModelOptions(
      [{ value: 'leverframe:provider:model' }],
      { current: 'leverframe:provider:model[maximum]', value: 'leverframe:provider:model[maximum]', sessionOverride: 'leverframe:provider:model[maximum]' },
      null,
    )).toEqual([{ value: 'leverframe:provider:model' }]);
    expect(native.nativeModelFocus(
      [{ value: 'leverframe:provider:model' }],
      { value: 'leverframe:provider:model[maximum]' },
    )).toBe('leverframe:provider:model');
    expect(native.nativeSelectedValue(
      [{ value: 'leverframe:provider:model' }],
      'leverframe:provider:model[maximum]',
      (_options, model) => model,
      '__no_preference__',
    )).toBe('leverframe:provider:model');
    expect(native.normalize([
      { value: 'leverframe:provider:model[maximum]' },
      { value: 'atlas' },
      { value: 'leverframe:provider:future[maximum]' },
      { value: 'native[maximum]' },
    ])).toEqual([
      { value: 'atlas' },
      { value: 'leverframe:provider:future[maximum]' },
      { value: 'native[maximum]' },
    ]);
  });

  it('uses the proxy control address without changing the Anthropic origin', async () => {
    const result = applyNativeContextPicker(pickerSource(), {
      'leverframe:provider:model': { default: 272_000, maximum: 872_000 },
    });
    const runtime = globalThis as typeof globalThis & {
      __lfcContextWindows?: Record<string, number>;
    };
    const previous = runtime.__lfcContextWindows;
    let state: unknown = null;
    let requestUrl: string | undefined;
    let requestInit: RequestInit | undefined;
    type PickerUseState = (initial: unknown) => [unknown, (value: unknown) => void];
    type PickerCreateElement = (type: unknown, props: Record<string, unknown>) => { props: Record<string, unknown> };
    const useState: PickerUseState = (initial: unknown): [unknown, (value: unknown) => void] => [
      state ?? initial,
      value => { state = value; },
    ];
    const createElement: PickerCreateElement = (_type: unknown, props: Record<string, unknown>) => ({ props });
    const fetch = async (input: unknown, init?: RequestInit): Promise<{ ok: boolean; json: () => Promise<unknown> }> => {
      requestUrl = String(input);
      requestInit = init;
      return {
        ok: true,
        json: async () => ({ options: [{ mode: 'default', contextWindow: 272_000, label: 'Default (272,000)' }] }),
      };
    };
    const fakeProcess = {
      env: {
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_API_KEY: 'sk-ant-api03-leverframe-http-proxy',
        LEVERFRAME_CONTEXT_SELECTION_BASE_URL: 'http://127.0.0.1:17645',
        LEVERFRAME_CONTEXT_SELECTION_TOKEN: 'per-run-control-token',
      },
    };
    const factory = new Function('useState', 'createElement', 'Picker', 'fetch', 'process', [
      result.content,
      ';return picker;',
    ].join('\n')) as (
      useState: PickerUseState,
      createElement: PickerCreateElement,
      Picker: object,
      fetch: (input: unknown, init?: RequestInit) => Promise<{ ok: boolean; json: () => Promise<unknown> }>,
      process: typeof fakeProcess,
    ) => (props: Record<string, unknown>) => { props: Record<string, unknown> };
    const picker = factory(useState, createElement, {}, fetch, fakeProcess);
    const props = {
      initial: 'base',
      sessionModel: 'base',
      onSelect: () => undefined,
      onSetDefault: undefined,
      onCancel: () => undefined,
      isStandaloneCommand: false,
      showFastModeNotice: false,
      headerText: undefined,
      options: [{ value: 'leverframe:provider:model', label: 'Model' }],
      skipSettingsWrite: false,
    };

    try {
      delete runtime.__lfcContextWindows;
      const first = picker(props);
      (first.props.onChange as (value: string) => void)('leverframe:provider:model');
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(requestUrl).toBe('http://127.0.0.1:17645/v1/leverframe/context-selection?model=leverframe%3Aprovider%3Amodel');
      const requestHeaders = requestInit?.headers;
      const authorization = requestHeaders && !Array.isArray(requestHeaders)
        ? (requestHeaders as Record<string, string>).Authorization
        : undefined;
      expect(authorization).toBe('Bearer per-run-control-token');
    } finally {
      if (previous === undefined) delete runtime.__lfcContextWindows;
      else runtime.__lfcContextWindows = previous;
    }
  });

  it('migrates a previous context picker helper to the proxy control environment', () => {
    const modes = { 'leverframe:provider:model': { default: 272_000, maximum: 872_000 } };
    const patched = applyNativeContextPicker(pickerSource(), modes);
    const currentEnvironment = [
      'const configuredBase=typeof process==="object"&&process&&process.env?process.env.LEVERFRAME_CONTEXT_SELECTION_BASE_URL:void 0;',
      'const configuredToken=typeof process==="object"&&process&&process.env?process.env.LEVERFRAME_CONTEXT_SELECTION_TOKEN:void 0;',
      'const baseValue=typeof configuredBase==="string"&&configuredBase.trim()!==""?configuredBase:typeof process==="object"&&process&&process.env?process.env.ANTHROPIC_BASE_URL:void 0;',
      'const base=typeof baseValue==="string"?baseValue.trim():void 0;',
      'const token=typeof configuredToken==="string"&&configuredToken.length>0?configuredToken:typeof process==="object"&&process&&process.env?process.env.ANTHROPIC_API_KEY:void 0;',
    ].join('');
    const legacyEnvironment = [
      'const base=typeof process==="object"&&process&&process.env?process.env.ANTHROPIC_BASE_URL:void 0;',
      'const token=typeof process==="object"&&process&&process.env?process.env.ANTHROPIC_API_KEY:void 0;',
    ].join('');
    const legacy = patched.content.replace(currentEnvironment, legacyEnvironment);
    expect(legacy).not.toContain('LEVERFRAME_CONTEXT_SELECTION_BASE_URL');

    const migrated = applyNativeContextPicker(legacy, modes);

    expect(migrated.result.status).toBe('OK');
    expect(migrated.content).toContain('LEVERFRAME_CONTEXT_SELECTION_BASE_URL');
    expect(migrated.content).toContain('LEVERFRAME_CONTEXT_SELECTION_TOKEN');
    expect(migrated.content).not.toContain(legacyEnvironment);
  });

  it('rejects a marker-bearing helper that cannot be upgraded in place', () => {
    const currentEnvironment = [
      'const configuredBase=typeof process==="object"&&process&&process.env?process.env.LEVERFRAME_CONTEXT_SELECTION_BASE_URL:void 0;',
      'const configuredToken=typeof process==="object"&&process&&process.env?process.env.LEVERFRAME_CONTEXT_SELECTION_TOKEN:void 0;',
      'const baseValue=typeof configuredBase==="string"&&configuredBase.trim()!==""?configuredBase:typeof process==="object"&&process&&process.env?process.env.ANTHROPIC_BASE_URL:void 0;',
      'const base=typeof baseValue==="string"?baseValue.trim():void 0;',
      'const token=typeof configuredToken==="string"&&configuredToken.length>0?configuredToken:typeof process==="object"&&process&&process.env?process.env.ANTHROPIC_API_KEY:void 0;',
    ].join('');
    const incomplete = '/*ccpatch:context-mode-picker*/var __lfcModels=JSON.parse("{}");'
      + currentEnvironment
      + pickerSource();
    const outcome = applyNativeContextPicker(incomplete, {
      'leverframe:provider:model': { default: 272_000, maximum: 872_000 },
    });
    expect(outcome.result).toEqual({
      status: 'FAIL',
      name: 'PATCH 12: context mode picker',
      extra: 'legacy context picker helper is incomplete; rebuild from a pristine Claude Code binary',
    });
  });

  it('keeps a fully migrated helper idempotent', () => {
    const modes = { 'leverframe:provider:model': { default: 272_000, maximum: 872_000 } };
    const first = applyNativeContextPicker(pickerSource(), modes);
    const second = applyNativeContextPicker(first.content, modes);
    expect(second.result).toEqual({ status: 'OK', name: 'PATCH 12: context mode picker' });
    expect(second.content).toBe(first.content);
  });

  it('freshly validates a default-only external model before selecting it', async () => {
    const result = applyNativeContextPicker(pickerSource(), {
      'leverframe:provider:model': { default: 301_000 },
    });
    expect(result.result).toEqual({ status: 'OK', name: 'PATCH 12: context mode picker' });
    const harness = createPickerHarness(result.content, async () => ({
      ok: true,
      json: async () => ({
        options: [{ mode: 'default', contextWindow: 301_000, label: 'Default (301,000)' }],
      }),
    }));
    const first = harness.picker(harness.props);
    (first.props.onChange as (value: string) => void)('leverframe:provider:model');
    const loading = harness.picker(harness.props);
    expect((loading.props.options as Array<{ label: string }>)[0]!.label).toContain('Refreshing');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(harness.selected).toEqual([['leverframe:provider:model', 'high']]);
    expect(harness.picker(harness.props).props.options).toEqual(harness.props.options);
  });

  it('updates the native runtime context map and invalidates a removed maximum', async () => {
    const result = applyNativeContextPicker(pickerSource(), {
      'leverframe:provider:model': { default: 272_000, maximum: 872_000 },
    });
    const runtime = globalThis as typeof globalThis & {
      __lfcContextWindows?: Record<string, number>;
    };
    const previous = runtime.__lfcContextWindows;
    let freshOptions: Array<{ mode: string; contextWindow: number; label: string }> = [
      { mode: 'default', contextWindow: 413_579, label: 'Default (413,579)' },
      { mode: 'maximum', contextWindow: 1_203_017, label: 'Maximum (1,203,017)' },
    ];
    try {
      delete runtime.__lfcContextWindows;
      const harness = createPickerHarness(result.content, async () => ({
        ok: true,
        json: async () => ({ options: freshOptions }),
      }));
      const first = harness.picker(harness.props);
      (first.props.onChange as (value: string) => void)('leverframe:provider:model');
      await new Promise(resolve => setTimeout(resolve, 0));
      const ready = harness.picker(harness.props);
      expect(runtime.__lfcContextWindows?.['leverframe:provider:model']).toBe(413_579);
      expect(runtime.__lfcContextWindows?.['leverframe:provider:model[maximum]']).toBe(1_203_017);
      (ready.props.onChange as (value: string) => void)('maximum');
      expect(runtime.__lfcContextWindows?.['leverframe:provider:model']).toBe(1_203_017);

      freshOptions = [
        { mode: 'default', contextWindow: 413_579, label: 'Default (413,579)' },
      ];
      const base = harness.picker(harness.props);
      (base.props.onChange as (value: string) => void)('leverframe:provider:model');
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(runtime.__lfcContextWindows?.['leverframe:provider:model']).toBe(413_579);
      expect(runtime.__lfcContextWindows?.['leverframe:provider:model[maximum]']).toBe(0);
    } finally {
      if (previous === undefined) delete runtime.__lfcContextWindows;
      else runtime.__lfcContextWindows = previous;
    }
  });

  it('normalizes legacy one-million model ids and invalidates them below the threshold', async () => {
    const result = applyNativeContextPicker(pickerSource(), {
      'leverframe:provider:model': { default: 272_000, maximum: 1_203_017 },
    });
    const runtime = globalThis as typeof globalThis & {
      __lfcContextWindows?: Record<string, number>;
    };
    const previous = runtime.__lfcContextWindows;
    let freshOptions: Array<{ mode: string; contextWindow: number; label: string }> = [
      { mode: 'default', contextWindow: 413_579, label: 'Default (413,579)' },
      { mode: 'maximum', contextWindow: 1_203_017, label: 'Maximum (1,203,017)' },
    ];
    try {
      delete runtime.__lfcContextWindows;
      const harness = createPickerHarness(result.content, async () => ({
        ok: true,
        json: async () => ({ options: freshOptions }),
      }));
      harness.props.options = [{ value: 'leverframe:provider:model[1m]', label: 'Model' }];
      const first = harness.picker(harness.props);
      (first.props.onChange as (value: string) => void)('leverframe:provider:model[1m]');
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(runtime.__lfcContextWindows?.['leverframe:provider:model[1m]']).toBe(1_203_017);
      const ready = harness.picker(harness.props);
      (ready.props.onChange as (value: string) => void)('maximum');
      expect(harness.selected).toEqual([['leverframe:provider:model[maximum]', 'high']]);

      freshOptions = [{ mode: 'default', contextWindow: 413_579, label: 'Default (413,579)' }];
      const second = harness.picker(harness.props);
      (second.props.onChange as (value: string) => void)('leverframe:provider:model[1m]');
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(runtime.__lfcContextWindows?.['leverframe:provider:model[1m]']).toBe(0);
      expect(harness.selected).toEqual([
        ['leverframe:provider:model[maximum]', 'high'],
        ['leverframe:provider:model', 'high'],
      ]);
    } finally {
      if (previous === undefined) delete runtime.__lfcContextWindows;
      else runtime.__lfcContextWindows = previous;
    }
  });

  it('fails closed for a default-only external model when fresh discovery fails', async () => {
    const result = applyNativeContextPicker(pickerSource(), {
      'leverframe:provider:model': { default: 301_000 },
    });
    const harness = createPickerHarness(result.content, async () => {
      throw new Error('offline');
    });
    const first = harness.picker(harness.props);
    (first.props.onChange as (value: string) => void)('leverframe:provider:model');
    const loading = harness.picker(harness.props);
    expect((loading.props.options as Array<{ label: string }>)[0]!.label).toContain('Refreshing');
    await new Promise(resolve => setTimeout(resolve, 0));
    const failed = harness.picker(harness.props);
    expect((failed.props.options as Array<{ label: string }>)[0]!.label).toContain('unavailable');
    expect(harness.selected).toEqual([]);
  });

  it('clears a failed fresh lookup without selecting a stale model', async () => {
    const result = applyNativeContextPicker(pickerSource(), {
      'leverframe:provider:model': { default: 272_000, maximum: 872_000 },
    });
    let state: unknown = null;
    const selected: unknown[][] = [];
    let baseCancelled = 0;
    type PickerUseState = (initial: unknown) => [unknown, (value: unknown) => void];
    type PickerCreateElement = (type: unknown, props: Record<string, unknown>) => { props: Record<string, unknown> };
    type PickerFetch = () => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
    const useState: PickerUseState = (initial: unknown) => [state ?? initial, value => { state = value; }];
    const createElement: PickerCreateElement = (_type, props) => ({ props });
    const fetch: PickerFetch = async () => { throw new Error('offline'); };
    const fakeProcess = { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:17645', ANTHROPIC_API_KEY: 'token' } };
    const factory = new Function('useState', 'createElement', 'Picker', 'fetch', 'process', [
      result.content,
      ';return picker;',
    ].join('\n')) as (
      useState: PickerUseState,
      createElement: PickerCreateElement,
      Picker: object,
      fetch: PickerFetch,
      process: typeof fakeProcess,
    ) => (props: Record<string, unknown>) => { props: Record<string, unknown> };
    const picker = factory(useState, createElement, {}, fetch, fakeProcess);
    const props = {
      initial: 'base',
      sessionModel: 'base',
      onSelect: (...args: unknown[]) => selected.push(args),
      onSetDefault: undefined,
      onCancel: () => { baseCancelled++; },
      isStandaloneCommand: false,
      showFastModeNotice: false,
      headerText: undefined,
      options: [{ value: 'leverframe:provider:model', label: 'Model' }],
      skipSettingsWrite: false,
    };
    const first = picker(props);
    (first.props.onChange as (value: string) => void)('leverframe:provider:model');
    await new Promise(resolve => setTimeout(resolve, 0));
    const failed = picker(props);
    expect((failed.props.options as Array<{ label: string }>)[0]!.label).toContain('unavailable');
    (failed.props.onCancel as () => void)();
    expect(state).toBeNull();
    expect(selected).toEqual([]);
    expect(baseCancelled).toBe(0);
    const basePicker = picker(props);
    expect(basePicker.props.options).toEqual(props.options);
    (basePicker.props.onCancel as () => void)();
    expect(baseCancelled).toBe(1);
  });

  it('shows an unavailable state when the loopback endpoint has an invalid port', () => {
    const result = applyNativeContextPicker(pickerSource(), {
      'leverframe:provider:model': { default: 272_000, maximum: 872_000 },
    });
    let state: unknown = null;
    let fetchCalls = 0;
    type PickerUseState = (initial: unknown) => [unknown, (value: unknown) => void];
    type PickerCreateElement = (type: unknown, props: Record<string, unknown>) => { props: Record<string, unknown> };
    type PickerFetch = () => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
    const useState: PickerUseState = (initial: unknown) => [state ?? initial, value => { state = value; }];
    const createElement: PickerCreateElement = (_type, props) => ({ props });
    const fetch: PickerFetch = async () => {
      fetchCalls++;
      throw new Error('fetch should not run for an invalid URL');
    };
    const fakeProcess = { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:999999', ANTHROPIC_API_KEY: 'token' } };
    const factory = new Function('useState', 'createElement', 'Picker', 'fetch', 'process', [
      result.content,
      ';return picker;',
    ].join('\n')) as (
      useState: PickerUseState,
      createElement: PickerCreateElement,
      Picker: object,
      fetch: PickerFetch,
      process: typeof fakeProcess,
    ) => (props: Record<string, unknown>) => { props: Record<string, unknown> };
    const picker = factory(useState, createElement, {}, fetch, fakeProcess);
    const props = {
      initial: 'base',
      sessionModel: 'base',
      onSelect: () => undefined,
      onSetDefault: undefined,
      onCancel: () => undefined,
      isStandaloneCommand: false,
      showFastModeNotice: false,
      headerText: undefined,
      options: [{ value: 'leverframe:provider:model', label: 'Model' }],
      skipSettingsWrite: false,
    };
    const first = picker(props);
    (first.props.onChange as (value: string) => void)('leverframe:provider:model');
    const failed = picker(props);
    expect((failed.props.options as Array<{ label: string }>)[0]!.label).toContain('unavailable');
    expect(fetchCalls).toBe(0);
  });

  it('ignores a fresh response that resolves after context cancellation', async () => {
    const result = applyNativeContextPicker(pickerSource(), {
      'leverframe:provider:model': { default: 272_000, maximum: 872_000 },
    });
    let state: unknown = null;
    let resolveFetch: ((value: { ok: boolean; json: () => Promise<unknown> }) => void) | undefined;
    const selected: unknown[][] = [];
    type PickerUseState = (initial: unknown) => [unknown, (value: unknown) => void];
    type PickerCreateElement = (type: unknown, props: Record<string, unknown>) => { props: Record<string, unknown> };
    type PickerFetch = () => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
    const useState: PickerUseState = (initial: unknown) => [state ?? initial, value => { state = value; }];
    const createElement: PickerCreateElement = (_type, props) => ({ props });
    const fetch: PickerFetch = () => new Promise(resolve => { resolveFetch = resolve; });
    const fakeProcess = { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:17645', ANTHROPIC_API_KEY: 'token' } };
    const factory = new Function('useState', 'createElement', 'Picker', 'fetch', 'process', [
      result.content,
      ';return picker;',
    ].join('\n')) as (
      useState: PickerUseState,
      createElement: PickerCreateElement,
      Picker: object,
      fetch: PickerFetch,
      process: typeof fakeProcess,
    ) => (props: Record<string, unknown>) => { props: Record<string, unknown> };
    const picker = factory(useState, createElement, {}, fetch, fakeProcess);
    const props = {
      initial: 'base',
      sessionModel: 'base',
      onSelect: (...args: unknown[]) => selected.push(args),
      onSetDefault: undefined,
      onCancel: () => undefined,
      isStandaloneCommand: false,
      showFastModeNotice: false,
      headerText: undefined,
      options: [{ value: 'leverframe:provider:model', label: 'Model' }],
      skipSettingsWrite: false,
    };
    const first = picker(props);
    (first.props.onChange as (value: string) => void)('leverframe:provider:model');
    const loading = picker(props);
    (loading.props.onCancel as () => void)();
    resolveFetch!({
      ok: true,
      json: async () => ({
        options: [
          { mode: 'default', contextWindow: 272_000, label: 'Default (272,000)' },
          { mode: 'maximum', contextWindow: 872_000, label: 'Maximum (872,000)' },
        ],
      }),
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    const basePicker = picker(props);
    expect(basePicker.props.options).toEqual(props.options);
    expect(selected).toEqual([]);
  });

  it('fails closed for a native module source without the structural picker anchor', () => {
    const result = applyNativeContextPicker(
      '//#__leverframe_claude_module__:chunk-picker.js\nfunction unrelated(){return 1}',
      { 'leverframe:provider:model': { default: 272_000, maximum: 872_000 } },
    );
    expect(result.result).toEqual({
      status: 'FAIL',
      name: 'PATCH 12: context mode picker',
      extra: 'picker prop shape anchor not found',
    });
  });

  it('refreshes the configured model gate without retaining old model rows', () => {
    const first = applyNativeContextPicker(pickerSource(), {
      'leverframe:provider:first': { default: 128_000, maximum: 384_000 },
    });
    const refreshed = applyNativeContextPicker(first.content, {
      'leverframe:provider:second': { default: 256_000, maximum: 768_000 },
    });
    expect(refreshed.result).toEqual({ status: 'OK', name: 'PATCH 12: context mode picker' });
    expect(refreshed.content).toContain('leverframe:provider:second');
    expect(refreshed.content).not.toContain('leverframe:provider:first');
  });
});
