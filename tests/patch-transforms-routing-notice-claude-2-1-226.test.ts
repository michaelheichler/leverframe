import { describe, expect, it } from 'vitest';
import {
  AGENT_DESCRIPTION_MARKER,
  applyRoutingNoticeTransform,
  ROUTING_NOTICE_HANDOFF_MARKER,
  ROUTING_NOTICE_MARKER,
} from '../src/patch-transforms-routing-notice.js';

const CONFIG = {
  'leverframe:openai-oauth:gpt-5.6-sol': {
    alias: 'sol',
    display: 'GPT-5.6 Sol',
  },
};
// Verbatim excerpt of the Agent tool's `call()` method signature (2.1.226).
// Property-key literals come straight from the tool's zod schema, so they
// are stable across minifier renames of the local identifiers.
const AGENT_CALL_SIGNATURE =
  'async call({prompt:e,subagent_type:t,description:r,model:n,run_in_background:o,name:i,isolation:s,cwd:a},l,c,u,d){';
const AGENT_CALL =
  'let Y=eP(l),ne=fse(aZe(V,Y),Y,H?void 0:f,S);l.agentLifecycle.markTypeInvoked(V.agentType);';
const AGENT_CALLBACK =
  'let qe={onModelRestricted:(Je,rt)=>d?.({type:"notification",notification:{key:`agent-model-restricted-${V.agentType}-${Hbe(Je)}`,text:`${V.agentType} agent: ${XF(Je,rt)}`,priority:"medium",color:"warning",timeoutMs:1e4}})},tt=';
const AGENT_RUNNER =
  'async function*g5({agentDefinition:e,promptMessages:t,toolUseContext:r,canUseTool:n,onModelRestricted:V,requiresStructuredOutput:W})';
const CHILD_CONTEXT =
  'st=Q4o(r,{options:je,agentId:se,isBackgroundAgent:o,agentType:e.agentType,agentContext:d?.agentContext,spawnedByWorkflowRunId:M,teammateContext:j,messages:ue,readFileState:J,abortController:tr,getAppState:Ge,permissionLayers:yt,shareSetAppState:!o,shareFileHistory:d?.shareFileHistory,criticalSystemReminder_EXPERIMENTAL:e.criticalSystemReminder_EXPERIMENTAL,contentReplacementState:S});';

function agentLaunchFixture(): string {
  return [AGENT_CALL_SIGNATURE, AGENT_CALL, AGENT_CALLBACK, AGENT_RUNNER, CHILD_CONTEXT].join('\n');
}

describe('Claude Code 2.1.226 routing notice compatibility', () => {
  it('pins callback, runner, and effective-effort insertion', () => {
    const result = applyRoutingNoticeTransform(agentLaunchFixture(), CONFIG);

    expect(result.results).toEqual([
      { status: 'OK', name: 'PATCH 10a: routing notice callback' },
      { status: 'OK', name: 'PATCH 10b: routing notice signature' },
      { status: 'OK', name: 'PATCH 10c: routing notice handoff' },
      { status: 'OK', name: 'PATCH 10d: agent description indicator' },
    ]);
    expect(result.content.split(ROUTING_NOTICE_MARKER)).toHaveLength(2);
    expect(result.content.split(ROUTING_NOTICE_HANDOFF_MARKER)).toHaveLength(2);
    expect(result.content.split(AGENT_DESCRIPTION_MARKER)).toHaveLength(2);
    expect(result.content).toContain('/*ccpatch:routing-notice*/onRoutingNotice:d,ccRoutingModelId:ne');
    expect(result.content).toContain('requiresStructuredOutput:W,onRoutingNotice:ccRoutingNotice,ccRoutingModelId})');
    expect(result.content).toContain('key:`leverframe-routing-success-${se}`');
    expect(result.content).not.toContain('nS(');
    expect(result.content).not.toContain('sJe(');
    expect(result.content).not.toContain('qce(');
    expect(result.content).not.toContain('e.effort');
    expect(result.content).toContain('{text:_ccd,color:"suggestion",bold:!0}');
    expect(result.content).toContain('{text:_ccr,color:"success",bold:!0}');
    expect(result.content).toContain('d?.replHydration?.kind!=="resume"');
    expect(result.content).toContain('Object.assign(Object.create(null),{"leverframe:openai-oauth:gpt-5.6-sol":"GPT-5.6 Sol","leverframe:openai-oauth:gpt-5.6-sol[1m]":"GPT-5.6 Sol","sol":"GPT-5.6 Sol","sol[1m]":"GPT-5.6 Sol"})');
    // PATCH 10d: appends " · <display> · <effort>" to the description local
    // (`r`) captured from the call() signature, keyed off the call-site
    // model id (`ne`) captured from AGENT_CALL. The append is guarded by an
    // exact-suffix check against the freshly-computed display (`_ccad`),
    // not a bare middle-dot probe, so it never false-suppresses on a
    // user-written description that happens to contain " · " already.
    expect(result.content).toContain('String(ne||"").trim().toLowerCase()');
    expect(result.content).toContain('if(r.indexOf(" \\u00b7 "+_ccad)===-1){r=r+" \\u00b7 "+_ccad+(_ccae?" \\u00b7 "+_ccae:"");}}');
    expect(result.content).not.toMatch(/if\(!\/ [^"]*\/\.test\(r\)\)/);

    const reapplied = applyRoutingNoticeTransform(result.content, CONFIG);
    expect(reapplied.content).toBe(result.content);
    expect(reapplied.results).toEqual([
      { status: 'SKIP', name: 'PATCH 10: routing notice', extra: 'already patched' },
      { status: 'SKIP', name: 'PATCH 10d: agent description indicator', extra: 'already patched' },
    ]);
  });

  it('skips without changing source when the child-context anchor drifts', () => {
    const drifted = agentLaunchFixture().replace(CHILD_CONTEXT, '');
    const result = applyRoutingNoticeTransform(drifted, CONFIG);

    // The main routing-notice product SKIPs as a unit, but the independent
    // PATCH 10d description site is unaffected by the runner-context drift
    // (it only depends on the call-site and call-signature anchors) and
    // still applies.
    expect(result.results).toEqual([
      { status: 'SKIP', name: 'PATCH 10: routing notice', extra: 'runner anchor not recognized' },
      { status: 'OK', name: 'PATCH 10d: agent description indicator' },
    ]);
    expect(result.content).not.toBe(drifted);
    expect(result.content).toContain(AGENT_DESCRIPTION_MARKER);
  });

  it('SKIPs the description site cleanly when the call() signature anchor is absent', () => {
    const withoutSignature = [AGENT_CALL, AGENT_CALLBACK, AGENT_RUNNER, CHILD_CONTEXT].join('\n');
    const result = applyRoutingNoticeTransform(withoutSignature, CONFIG);

    expect(result.results).toEqual([
      { status: 'OK', name: 'PATCH 10a: routing notice callback' },
      { status: 'OK', name: 'PATCH 10b: routing notice signature' },
      { status: 'OK', name: 'PATCH 10c: routing notice handoff' },
      { status: 'SKIP', name: 'PATCH 10d: agent description indicator', extra: 'call signature anchor not recognized' },
    ]);
    expect(result.content).not.toContain(AGENT_DESCRIPTION_MARKER);
  });
});
