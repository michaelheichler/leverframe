import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { applyModelPickerOptions } from '../src/patch-model-picker-options.js';

const CURRENT_BUILD_PICKER = [
  'var native=[{value:"sonnet",label:"Sonnet",description:"native"}];',
  'function nativeOptions(){return native.slice()}',
  'function savedOptions(){return void 0}',
  'var env={};',
  'function pickerOptions(a,b){let s=savedOptions(a),'
    + 't=s??nativeOptions(b),c=env.ANTHROPIC_CUSTOM_MODEL_OPTION;'
    + 'if(c)t.push({value:c,label:c,description:"custom"});return t}',
].join('\n');

function pickerValues(source: string): string[] {
  const options = runInNewContext(source + ';pickerOptions(0,0)') as Array<{ value: string }>;
  return options.map(option => option.value);
}

describe('model picker options on current Claude Code builds', () => {
  it('adds configured models to the picker list without repeating a native entry', () => {
    const patched = applyModelPickerOptions(CURRENT_BUILD_PICKER, [
      { value: 'sonnet', label: 'Sonnet copy', description: 'configured' },
      { value: 'leverframe:openai:model-a', label: 'Model A', description: 'configured' },
    ]);

    expect(pickerValues(patched.content)).toEqual(['sonnet', 'leverframe:openai:model-a']);
  });
});
