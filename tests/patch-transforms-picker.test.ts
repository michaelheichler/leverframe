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
    'function picker({initial:initialModel,sessionModel:session,onSelect:select,onSetDefault:setDefault,onCancel:cancel,isStandaloneCommand:standalone,showFastModeNotice:notice,headerText:header,options:options,skipSettingsWrite:skip}){',
    'let[state,setState]=useState(null);',
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
