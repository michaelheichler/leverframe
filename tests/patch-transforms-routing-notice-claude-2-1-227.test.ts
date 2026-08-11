import { describe, expect, it } from 'vitest';
import {
  applyRoutingNoticeTransform,
  ROUTING_NOTICE_HANDOFF_MARKER,
  ROUTING_NOTICE_MARKER,
} from '../src/patch-transforms-routing-notice.js';

// Fixture strings are verbatim excerpts grepped from the installed
// /Users/michael/.local/share/claude/versions/2.1.227 binary (see the
// per-release verification step documented in the file header of
// src/patch-transforms-routing-notice.ts). Note the ne/se role swap versus
// 2.1.226: here the call-site model variable is `se` and the runner-context
// agentId variable is `ne` (2.1.226 fixture has it the other way around).
const CONFIG = {
  'leverframe:openai-oauth:gpt-5.6-sol': {
    alias: 'sol',
    display: 'GPT-5.6 Sol',
  },
};
const AGENT_CALL =
  'let Z=XP(l),se=nle(_tt(G,Z),Z,M?void 0:f,T);l.agentLifecycle.markTypeInvoked(G.agentType);';
const AGENT_CALLBACK =
  'let qe={onMcpServersBlocked:(ct,mt)=>d?.({type:"notification",notification:{key:`agent-mcp-blocked-${Ie}`,text:`${G.agentType} agent MCP ${xt(ct.length,"server")} blocked by ${mt}: ${ct.join(", ")}`,priority:"medium",color:"warning",timeoutMs:1e4}}),onModelRestricted:(ct,mt)=>d?.({type:"notification",notification:{key:`agent-model-restricted-${G.agentType}-${gTe(ct)}`,text:`${G.agentType} agent: ${iB(ct,mt)}`,priority:"medium",color:"warning",timeoutMs:1e4}})},ze=';
const AGENT_RUNNER =
  'async function*M6({agentDefinition:e,promptMessages:t,toolUseContext:r,canUseTool:n,isAsync:o,canShowPermissionPrompts:i,forkContextMessages:s,querySource:a,forkOrigin:l,spawnedBySkill:c,spawnedByForkedSkill:u,override:d,model:p,maxTurns:f,preserveToolUseResults:m,availableTools:h,allowedTools:g,onCacheSafeParams:y,contentReplacementState:T,stickyBetas:S,useExactTools:b,worktreePath:w,worktreeBranch:C,cwd:A,session:k,spawnMode:R,description:P,name:O,toolUseId:M,transcriptSubdir:H,spawnedByWorkflowRunId:D,onQueryProgress:$,onMcpServersBlocked:G,onModelRestricted:J,isTeammate:Y=!1,teammateContext:z,recordedUuids:B,extraMetadata:q,requiresStructuredOutput:V})';
const CHILD_CONTEXT =
  'It=S4o(r,{options:ar,session:j,agentId:ne,isBackgroundAgent:o,agentType:e.agentType,agentContext:d?.agentContext,requireCanUseTool:d?.requireCanUseTool,spawnedByWorkflowRunId:D,teammateContext:z,messages:K,readFileState:ce,abortController:cr,getAppState:Je,permissionLayers:We,shareSetAppState:!o,shareFileHistory:d?.shareFileHistory,criticalSystemReminder_EXPERIMENTAL:e.criticalSystemReminder_EXPERIMENTAL,contentReplacementState:T});';

function agentLaunchFixture(): string {
  return [AGENT_CALL, AGENT_CALLBACK, AGENT_RUNNER, CHILD_CONTEXT].join('\n');
}

describe('Claude Code 2.1.227 routing notice compatibility', () => {
  it('pins callback and runner sites despite the ne/se role swap', () => {
    const result = applyRoutingNoticeTransform(agentLaunchFixture(), CONFIG);

    expect(result.results).toEqual([
      { status: 'OK', name: 'PATCH 10a: routing notice callback' },
      { status: 'OK', name: 'PATCH 10b: routing notice signature' },
      { status: 'OK', name: 'PATCH 10c: routing notice handoff' },
    ]);
    expect(result.content.split(ROUTING_NOTICE_MARKER)).toHaveLength(2);
    expect(result.content.split(ROUTING_NOTICE_HANDOFF_MARKER)).toHaveLength(2);
    expect(result.content).toContain('/*ccpatch:routing-notice*/onRoutingNotice:d,ccRoutingModelId:se');
    expect(result.content).toContain('requiresStructuredOutput:V,onRoutingNotice:ccRoutingNotice,ccRoutingModelId})');
    // Model id threads from the call site (se) across the function boundary;
    // the notification key uses the runner's own agentId variable (ne).
    expect(result.content).toContain('key:`leverframe-routing-success-${ne}`');
    expect(result.content).not.toContain('nS(');
    expect(result.content).not.toContain('sJe(');
    expect(result.content).not.toContain('qce(');
    expect(result.content).not.toContain('e.effort');

    const reapplied = applyRoutingNoticeTransform(result.content, CONFIG);
    expect(reapplied.content).toBe(result.content);
    expect(reapplied.results).toEqual([
      { status: 'SKIP', name: 'PATCH 10: routing notice', extra: 'already patched' },
    ]);
  });

  it('emits a styled notification for a fresh, non-resumed agent', () => {
    const result = applyRoutingNoticeTransform(agentLaunchFixture(), CONFIG);

    expect(result.content).toContain('{text:_ccd,color:"suggestion",bold:!0}');
    expect(result.content).toContain('{text:_ccr,color:"success",bold:!0}');
    expect(result.content).toContain('d?.replHydration?.kind!=="resume"');
    expect(result.content).toContain('Object.assign(Object.create(null),{"leverframe:openai-oauth:gpt-5.6-sol":"GPT-5.6 Sol","leverframe:openai-oauth:gpt-5.6-sol[1m]":"GPT-5.6 Sol","sol":"GPT-5.6 Sol","sol[1m]":"GPT-5.6 Sol"})');
  });

  it('resolves effort from the transform config table instead of version-specific CC internals', () => {
    const withEffort = {
      'leverframe:openai-oauth:gpt-5.6-sol': {
        alias: 'sol',
        display: 'GPT-5.6 Sol',
        effort: { levels: ['low', 'medium', 'high'], defaultLevel: 'medium' },
      },
    };
    const result = applyRoutingNoticeTransform(agentLaunchFixture(), withEffort);

    expect(result.content).toContain('"sol":"medium"');
  });

  it('skips without changing source when the child-context anchor drifts', () => {
    const drifted = agentLaunchFixture().replace(CHILD_CONTEXT, '');
    const result = applyRoutingNoticeTransform(drifted, CONFIG);

    expect(result).toEqual({
      content: drifted,
      results: [{ status: 'SKIP', name: 'PATCH 10: routing notice', extra: 'runner anchor not recognized' }],
    });
  });
});
