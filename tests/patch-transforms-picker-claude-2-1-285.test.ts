import { describe, expect, it } from 'vitest';
import { applyNativeContextPicker } from '../src/patch-transforms-picker.js';

const PICKER_SOURCE = [
  'function cIe({initial:h,sessionModel:E,onSelect:D,onSetDefault:N,onCancel:X,options:De}){',
  'let[lt]=g(false),mt=Y(()=>De??X0r(lt),[De,lt]),[Ft,Dt,eo]=yl(h);',
  'function ir(Bn){let Ds="high";if(Bn===bh){D(null,Ds);return}D(Bn,Ds)}',
  'let Vr=mo(X);function jr(Bn){if(N)N(Bn===bh?null:Bn);ir(Bn)}',
  'let Ms=e(Fe,{options:mt,onChange:jr,onCancel:()=>X?.()});return Ms}',
].join('');

describe('Claude Code 2.1.285 context picker', () => {
  it('uses the writable state hook when the picker returns a third getter', () => {
    const outcome = applyNativeContextPicker(PICKER_SOURCE, {
      'leverframe:provider:model': { default: 272_000, maximum: 872_000 },
    });

    expect(outcome.result).toEqual({ status: 'OK', name: 'PATCH 12: context mode picker' });
    expect(outcome.content).toContain('let[__lfcPending,__lfcSetPending]=yl(null);');
    expect(outcome.content).toContain('if(__lfcBeginContext(Bn,Ds))return;');
    expect(outcome.content).toContain('[Ft,Dt,eo]=yl(h)');
  });
});
