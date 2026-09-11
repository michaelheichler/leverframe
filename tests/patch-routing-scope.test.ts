import { describe, expect, it } from 'vitest';
import { applyModernRoutingNotice } from '../src/patch-transforms-routing-modern.js';
import { resolveRoutingBinding } from '../src/patch-routing-bindings.js';
import { CLAUDE_AGENT_2_1_266 } from './fixtures/claude-agent-2.1.266.js';

const START = '/*ccpatch:routing-v3:start*/';
const END = '/*ccpatch:routing-v3:end*/';
const model = 'vr=XH(yX(dt,Bn),Bn,F,Ie)';
const callback = CLAUDE_AGENT_2_1_266.match(/onModelRestricted:\(ls,si\)[^\n]+(?=};)/)![0];
const rejection = { results: [{ status: 'FAIL' }, { status: 'FAIL' }] };

describe('routing patch scope validation', () => {
  it('rejects a resolved model outside the Agent call', () => {
    const source = CLAUDE_AGENT_2_1_266.replace(model, 'vr=F') + '\nfunction decoy(){let ' + model + '}';
    expect(applyModernRoutingNotice(source, {})).toMatchObject({ content: source, ...rejection });
  });

  it('ignores resolved models in unrelated calls', () => {
    const source = 'function decoy(){let ' + model + '}\n' + CLAUDE_AGENT_2_1_266;
    expect(applyModernRoutingNotice(source, {})?.results.every(result => result.status === 'OK')).toBe(true);
  });

  it('rejects a notification callback outside the Agent call', () => {
    const source = CLAUDE_AGENT_2_1_266.replace(callback, '') + '\nconst decoy={' + callback + '};';
    expect(applyModernRoutingNotice(source, {})).toMatchObject({ content: source, ...rejection });
  });

  it('rejects a callback that does not use the Agent call notification parameter', () => {
    const source = CLAUDE_AGENT_2_1_266.replace('=>d?.({type:"notification"', '=>other?.({type:"notification"');
    expect(applyModernRoutingNotice(source, {})).toMatchObject({ content: source, ...rejection });
  });

  it.each([START, END])('rejects a stray marker on pristine source: %s', marker => {
    const source = CLAUDE_AGENT_2_1_266 + marker;
    expect(applyModernRoutingNotice(source, {})).toMatchObject({ content: source, ...rejection });
  });

  it.each([START, END])('rejects duplicate markers during refresh: %s', marker => {
    const first = applyModernRoutingNotice(CLAUDE_AGENT_2_1_266, {})!;
    expect(first.results.every(result => result.status === 'OK')).toBe(true);
    const source = first.content + marker;
    expect(applyModernRoutingNotice(source, {})).toMatchObject({ content: source, ...rejection });
  });

  it('rejects a detached routing block', () => {
    const first = applyModernRoutingNotice(CLAUDE_AGENT_2_1_266, {})!.content;
    const start = first.indexOf(START);
    const end = first.indexOf(END) + END.length;
    const source = first.slice(0, start) + first.slice(end) + first.slice(start, end);
    expect(applyModernRoutingNotice(source, {})).toMatchObject({ content: source, ...rejection });
  });

  it('requires launch acceptance inside the Agent call', () => {
    const anchor = 'let uf=await yn(),Lr=za();go.spawnedSubagent=Lr;';
    const source = CLAUDE_AGENT_2_1_266.replace(anchor, '') + '\nasync function decoy(){' + anchor + '}';
    expect(applyModernRoutingNotice(source, {})).toMatchObject({ content: source, ...rejection });
  });

  it('requires a pristine baseline to replace an older routing layout', () => {
    const source = CLAUDE_AGENT_2_1_266 + '/*ccpatch:routing-v2:start*//*ccpatch:routing-v2:end*/';
    expect(applyModernRoutingNotice(source, {})).toMatchObject({ content: source, ...rejection });
  });
});

describe('routing module bindings', () => {
  const boundary = '\n//#__leverframe_claude_module__:';
  const definition = /function (readEffort)\(context\)\{return context.effort\}/;

  it('resolves both export and import aliases across native chunks', () => {
    const source = boundary + 'effort.js\nfunction readEffort(context){return context.effort}export{readEffort as exported};'
      + boundary + 'agent.js\nimport{exported as localEffort}from"effort.js";async function*runner(){}';
    expect(resolveRoutingBinding(source, definition, source.indexOf('async function'))).toBe('localEffort');
  });

  it('rejects an import from a different module with the same export name', () => {
    const source = boundary + 'effort.js\nfunction readEffort(context){return context.effort}export{readEffort as exported};'
      + boundary + 'agent.js\nimport{exported as localEffort}from"other.js";async function*runner(){}';
    expect(resolveRoutingBinding(source, definition, source.indexOf('async function'))).toBeUndefined();
  });
});
