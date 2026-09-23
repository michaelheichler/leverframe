import { describe, expect, it } from 'vitest';
import { applyNativeContextPicker } from '../src/patch-transforms-picker.js';

const PICKER_SOURCE = [
  'function Vee({initial:w,sessionModel:I,onSelect:ee,onSetDefault:ce,onCancel:ge,options:Ie}){',
  'let[Vt,mo]=d(null),wt=V(()=>Ie??ggn(Vt),[Ie,Vt]);',
  'function Ps(ni){let $a="high";if(ni===nC){ee(null,$a);return}ee(ni,$a)}',
  'function Pa(ni){if(ce)ce(ni===nC?null:ni);Ps(ni)}',
  'function xa(ni){if(ni==="escape")ge?.()}',
  'let rl=e(ve,{options:wt,onChange:(ni)=>{Pa(ni)},onCancel:()=>{xa("escape")}});return rl}',
].join('');

describe('Claude Code 2.1.280 context picker', () => {
  it('patches the picker when unrelated functions reuse its minified callback name', () => {
    const unrelated = 'function unrelated(){ee(model,effort)}let outside=1;';
    const outcome = applyNativeContextPicker(unrelated + PICKER_SOURCE, {
      'leverframe:provider:model': { default: 272_000, maximum: 872_000 },
    });

    expect(outcome.result).toEqual({ status: 'OK', name: 'PATCH 12: context mode picker' });
    expect(outcome.content).toContain(unrelated);
    expect(outcome.content).toContain('if(__lfcBeginContext(ni,$a))return;');
  });
});
