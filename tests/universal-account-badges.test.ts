import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySelectBadge } from '../src/patch-select-badge.js';
import { buildDesiredPatchConfig, computePatchConfigHash } from '../src/patcher.js';
import { applyLeverframePatches } from '../src/patch-transforms.js';
import type { LocalProvider } from '../src/types.js';

const previousHome = process.env.LEVERFRAME_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-badges-'));
  process.env.LEVERFRAME_HOME = home;
  writeFileSync(join(home, 'config.json'), JSON.stringify({ favoriteModels: [] }));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function accountProvider(tag: string): LocalProvider {
  return {
    id: 'kimi', name: 'Kimi', apiKey: 'fixture-key', authType: 'api',
    models: [{
      id: 'fixture-model@personal', upstreamModelId: 'fixture-model', name: 'Fixture model [HOME]',
      family: 'fixture', brand: 'Fixture', modelFormat: 'openai', npm: '@ai-sdk/openai-compatible',
      accountId: 'personal', accountTag: tag, accountName: 'Personal',
    }],
  };
}

function pickerSource(): string {
  return [
    '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent.`)',
    'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
    'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
    'function nativeModelOptions(Ct,fo,w){let Ki=[];for(let[As,Ls,va]of[[fo.current,fo.value,"Current model"],[fo.sessionOverride===null?null:w,w===null?Qw:umt(Ct,w)??w,"Base model"]])if(As!==null&&!Ct.some((Bi)=>Bi.value===Ls)&&!Ki.some((Bi)=>Bi.value===As)&&Rr(As))Ki.push({value:As,label:WC(As),description:va});if(Ki.length===0)return Ct;let qi=Ct.findIndex((As)=>As.disabled===!0);if(qi===-1)return[...Ct,...Ki];return[...Ct.slice(0,qi),...Ki,...Ct.slice(qi)]}',
    'function nativeModelFocus(Fn,fo){return Fn.some((Ki)=>Ki.value===fo.value)?fo.value:Fn[0]?.value??void 0}',
    'function nativeSelectedValue(Ct,to,umt,Qw){let zt=to===null?Qw:umt(Ct,to)??to;return zt}',
    'function picker({initial:w,sessionModel:I,onSelect:ne,onSetDefault:me,onCancel:pe,isStandaloneCommand:be,showFastModeNotice:xe,headerText:Ae,options:Oe,skipSettingsWrite:He}){let[Io,So]=d(null);function choose(Ki,Ls){if(Ki===Qw){ne(null,Ls);return}ne(Ki,Ls)}let ta=r(o,{defaultValue:zt,selectedValue:zt,defaultFocusValue:Qo,options:Fn,onChange:(Ki)=>choose(Ki,Ls),onCancel:pe});return ta}',
    'var native=[{value:"sonnet",label:"Sonnet",description:"native"}];',
    'function nativeOptions(){return native.slice()}',
    'function savedOptions(){return void 0}',
    'var env={};',
    'function pickerOptions(a,b){let s=savedOptions(a),t=s??nativeOptions(b),c=env.ANTHROPIC_CUSTOM_MODEL_OPTION;if(c)t.push({value:c,label:c,description:"custom"});return t}',
  ].join('\n');
}

function badgeCell(): string {
  return 'e(s,{flexGrow:1,marginLeft:2,children:e(n,{wrap:"wrap",'
    + 'dimColor:me.option.descriptionColor===void 0&&(me.isOptionDisabled||me.option.dimDescription!==!1),'
    + 'color:me.isOptionDisabled?me.option.descriptionColor:me.isSelected?"success":me.isFocused?"suggestion":me.option.descriptionColor,'
    + 'children:e(ls,{children:me.option.description||" "})})})';
}

it('preserves account tags in patch configuration and changes its synchronization hash', () => {
  const homeConfig = buildDesiredPatchConfig([accountProvider('HOME')], {
    providerId: 'kimi', modelId: 'fixture-model@personal',
  }).config;
  const workConfig = buildDesiredPatchConfig([accountProvider('WORK')], {
    providerId: 'kimi', modelId: 'fixture-model@personal',
  }).config;
  const key = 'leverframe:kimi:fixture-model@personal';

  expect(homeConfig[key]).toMatchObject({ accountTag: 'HOME' });
  expect(workConfig[key]).toMatchObject({ accountTag: 'WORK' });
  expect(computePatchConfigHash(homeConfig)).not.toBe(computePatchConfigHash(workConfig));
});

it('generates a tagged orange picker option while keeping the account label', () => {
  const { config } = buildDesiredPatchConfig([accountProvider('HOME')], {
    providerId: 'kimi', modelId: 'fixture-model@personal',
  });
  const id = 'leverframe:kimi:fixture-model@personal';
  const patched = applyLeverframePatches(pickerSource(), config);
  const pickerFunction = /function pickerOptions\(a,b\)\{[\s\S]*?return t\}/.exec(patched.content)?.[0];
  expect(pickerFunction).toBeDefined();
  const options = runInNewContext([
    'var native=[{value:"sonnet",label:"Sonnet",description:"native"}];',
    'function nativeOptions(){return native.slice()}', 'function savedOptions(){return void 0}', 'var env={};',
    pickerFunction!, 'pickerOptions(0,0)',
  ].join('\n')) as Array<{
    value: string; label: string; badge?: string; badgeColor?: string;
  }>;
  const option = options.find(item => item.value === id);

  expect(option).toMatchObject({ badge: 'HOME', badgeColor: '#ff9f43' });
  expect(option?.label).toContain('[HOME]');
});

it('renders a model account badge with its configured orange color', () => {
  const patched = applySelectBadge(badgeCell());
  const element = (type: string, props: Record<string, unknown>) => ({ type, props });
  const rendered = runInNewContext(patched.content, {
    e: element, s: 'Box', n: 'Text', ls: 'Inline',
    me: { option: { description: 'Model ID: fixture-model', badge: 'HOME', badgeColor: '#ff9f43' },
      isOptionDisabled: false, isSelected: false, isFocused: false },
  }) as { props: { children: Array<{ props: { color: string; children: string[] } }> } };

  expect(rendered.props.children[0]?.props).toEqual({ color: '#ff9f43', children: ['HOME', ' '] });
});
