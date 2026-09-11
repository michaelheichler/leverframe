import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { applyNativeContextPicker } from '../src/patch-transforms-picker.js';

const PICKER_SOURCE = [
  '//#__leverframe_claude_module__:cli',
  'function Vee({initial:w,sessionModel:I,onSelect:ee,onSetDefault:ce,onCancel:ge,options:Ie}){',
  'let[Vt,mo]=d(null),wt=V(()=>Ie??ggn(Vt),[Ie,Vt]);',
  'function Ps(ni){let $a="high";if(ni===nC){ee(null,$a);return}ee(ni,$a)}',
  'function Pa(ni){if(ce)ce(ni===nC?null:ni);Ps(ni)}',
  'function xa(ni){if(ni==="escape")ge?.()}',
  'let rl=e(ve,{options:wt,onChange:(ni)=>{Pa(ni)},onCancel:()=>{xa("escape")}});return rl}',
].join('\n');

interface PickerOption {
  value: string;
  label: string;
}

interface RenderedPicker {
  props: {
    options: PickerOption[];
    onChange: (value: string) => void;
    onCancel: () => void;
  };
}

function createPicker(source: string) {
  let state: unknown = null;
  const selected: Array<[string | null, string]> = [];
  const fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ options: [
      { mode: 'default', contextWindow: 272_000, label: 'Default (272,000)' },
      { mode: 'maximum', contextWindow: 872_000, label: 'Maximum (872,000)' },
    ] }),
  }));
  const picker = runInNewContext(source + ';Vee', {
    d: (initial: unknown) => [state ?? initial, (value: unknown) => { state = value; }],
    e: (_component: unknown, props: RenderedPicker['props']) => ({ props }),
    V: (calculate: () => unknown) => calculate(),
    ggn: () => [],
    ve: {},
    nC: '__default__',
    URL,
    fetch,
    process: { env: {
      LEVERFRAME_CONTEXT_SELECTION_BASE_URL: 'http://127.0.0.1:17645',
      LEVERFRAME_CONTEXT_SELECTION_TOKEN: 'context-token',
    } },
  }) as (props: Record<string, unknown>) => RenderedPicker;
  const props = {
    initial: 'fable',
    sessionModel: 'fable',
    options: [{ value: 'leverframe:provider:model', label: 'Model' }],
    onSelect: (model: string | null, effort: string) => { selected.push([model, effort]); },
    onCancel: vi.fn(),
  };
  return { render: () => picker(props), selected, fetch, props };
}

describe('Claude Code 2.1.266 context picker', () => {
  it('discovers context modes when helper functions follow the selection callback', async () => {
    const patched = applyNativeContextPicker(PICKER_SOURCE, {
      'leverframe:provider:model': { default: 272_000, maximum: 872_000 },
    });
    expect(patched.result).toEqual({ status: 'OK', name: 'PATCH 12: context mode picker' });
    const harness = createPicker(patched.content);

    harness.render().props.onChange('leverframe:provider:model');
    expect(harness.render().props.options[0]?.label).toContain('Refreshing');
    await vi.waitFor(() => {
      expect(harness.render().props.options).toEqual([
        { value: 'default', label: 'Default (272,000)' },
        { value: 'maximum', label: 'Maximum (872,000)' },
      ]);
    });
    expect(harness.fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:17645/v1/leverframe/context-selection?model=leverframe%3Aprovider%3Amodel'),
      { headers: { Authorization: 'Bearer context-token' }, redirect: 'error' },
    );
    harness.render().props.onChange('maximum');
    expect(harness.selected).toEqual([['leverframe:provider:model[maximum]', 'high']]);
  });

  it('keeps native model selection and cancellation working after patch refresh', () => {
    const modes = { 'leverframe:provider:model': { default: 272_000, maximum: 872_000 } };
    const patched = applyNativeContextPicker(PICKER_SOURCE, modes);
    const refreshed = applyNativeContextPicker(patched.content, modes);
    expect(refreshed.result.status).toBe('OK');
    const harness = createPicker(refreshed.content);

    harness.render().props.onChange('fable');
    harness.render().props.onChange('__default__');
    expect(harness.selected).toEqual([['fable', 'high'], [null, 'high']]);
    expect(harness.fetch).not.toHaveBeenCalled();
    harness.render().props.onCancel();
    expect(harness.props.onCancel).toHaveBeenCalledOnce();
  });
});
