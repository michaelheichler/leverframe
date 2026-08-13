import { describe, expect, it } from 'vitest';
import {
  AGENT_DESCRIPTION_MARKER,
  applyRoutingNoticeTransform,
  buildRoutingDisplayTable,
  ROUTING_NOTICE_HANDOFF_MARKER,
} from '../src/patch-transforms-routing-notice.js';
const AGENT_CALL_SIGNATURE =
  'async call({prompt:e,subagent_type:t,description:r,model:n,run_in_background:o,name:i,isolation:s,cwd:a},l,c,u,d){';
const AGENT_CALL = [
  'let Y=eP(l),ne=fse(aZe(V,Y),Y,H?void 0:f,S);l.agentLifecycle.markTypeInvoked(V.agentType);',
  'let qe={onModelRestricted:(Je,rt)=>d?.({type:"notification",notification:{key:`agent-model-restricted-${V.agentType}-${Hbe(Je)}`,text:`${V.agentType} agent: ${XF(Je,rt)}`,priority:"medium",color:"warning",timeoutMs:1e4}})},tt=',
].join('\n');
const G5_SIGNATURE = 'async function*g5({agentDefinition:e,promptMessages:t,toolUseContext:r,canUseTool:n,onModelRestricted:V,requiresStructuredOutput:W})';
const G5_CONTEXT = 'st=Q4o(r,{options:je,agentId:se,isBackgroundAgent:o,agentType:e.agentType,agentContext:d?.agentContext,spawnedByWorkflowRunId:M,teammateContext:j,messages:ue,readFileState:J,abortController:tr,getAppState:Ge,permissionLayers:yt,shareSetAppState:!o,shareFileHistory:d?.shareFileHistory,criticalSystemReminder_EXPERIMENTAL:e.criticalSystemReminder_EXPERIMENTAL,contentReplacementState:S});';
const CONFIG = {
  'leverframe:openai-oauth:gpt-5.6-sol': { alias: 'sol', display: ' GPT  Sol\n' },
};
function fixture(): string {
  return [AGENT_CALL_SIGNATURE, AGENT_CALL, G5_SIGNATURE, G5_CONTEXT].join('\n');
}
function handoff(content: string): string {
  return content.slice(content.indexOf(ROUTING_NOTICE_HANDOFF_MARKER));
}
// Extracts the generated PATCH 10d block (marker through the closing
// `if(...)...}}` pair) for structural inspection of the guard logic.
function descriptionBlock(content: string): string {
  const match = content.match(/\/\*ccpatch:agent-description\*\/\{[\s\S]*?\+\(_ccae\?" \\u00b7 "\+_ccae:""\);\}\}/);
  if (!match) throw new Error('description block not found');
  return match[0];
}
function defineDisplayTableTests(): void {
  describe('routing notice display table', () => {
    it('builds normalized canonical, alias, and [1m] display keys', () => {
      expect(buildRoutingDisplayTable(CONFIG)).toEqual({
        'leverframe:openai-oauth:gpt-5.6-sol': 'GPT Sol',
        'leverframe:openai-oauth:gpt-5.6-sol[1m]': 'GPT Sol',
        sol: 'GPT Sol',
        'sol[1m]': 'GPT Sol',
      });
    });
  });
}
function defineInjectionTests(): void {
  describe('routing notice injection', () => {
    it('injects the callback, handoff, and description sites', () => {
      const result = applyRoutingNoticeTransform(fixture(), CONFIG);

      expect(result.results.map(item => item.status)).toEqual(['OK', 'OK', 'OK', 'OK']);
      expect(result.content.match(/ccpatch:routing-notice\*\//g)).toHaveLength(1);
      expect(result.content.match(/ccpatch:routing-notice-handoff\*\//g)).toHaveLength(1);
      expect(result.content).toContain('/*ccpatch:routing-notice*/onRoutingNotice:d');
      expect(result.content).toContain('requiresStructuredOutput:W,onRoutingNotice:ccRoutingNotice,ccRoutingModelId})');
      expect(result.content).toContain('ccRoutingModelId:ne');
    });

    it('resolves model display from the config table, falling back to the raw model id', () => {
      const injected = handoff(applyRoutingNoticeTransform(fixture(), CONFIG).content);

      expect(injected).toContain('String(ccRoutingModelId||"").trim().toLowerCase()');
      expect(injected).toContain('_ccd=_ccm!==void 0?_ccm:String(ccRoutingModelId||"")');
      expect(injected).not.toContain('e.effort');
      expect(injected).not.toContain('nS(');
      expect(injected).not.toContain('sJe(');
      expect(injected).not.toContain('qce(');
    });

    it('emits a styled, output-safe notification with normalized values', () => {
      const injected = handoff(applyRoutingNoticeTransform(fixture(), CONFIG).content);

      expect(injected).toContain('key:`leverframe-routing-success-${se}`');
      expect(injected).toContain('text:`Routing successful. Model ${_ccd} with Reasoning ${_ccr}`');
      expect(injected).toContain('{text:_ccd,color:"suggestion",bold:!0}');
      expect(injected).toContain('{text:_ccr,color:"success",bold:!0}');
      expect(injected).toContain('_ccd=String(_ccd).trim().replace(/\\s+/g," ")');
      expect(injected).toContain('_ccr=String(_ccr).trim().replace(/\\s+/g," ")');
      expect(injected).toContain('priority:"high",timeoutMs:1e4');
      expect(injected).not.toMatch(/console\.log|process\.(stdout|stderr)\.write/);
    });
  });
}
function defineLifecycleTests(): void {
  describe('routing notice lifecycle', () => {
    it('does not emit for resumed agents', () => {
      const injected = handoff(applyRoutingNoticeTransform(fixture(), CONFIG).content);

      expect(injected).toContain('if(d?.replHydration?.kind!=="resume"){');
      expect(injected).toContain('ccRoutingNotice?.({type:"notification"');
    });
    it('skips unchanged and drifted generated blocks', () => {
      const first = applyRoutingNoticeTransform(fixture(), CONFIG);
      const second = applyRoutingNoticeTransform(first.content, CONFIG);
      const drifted = first.content.replace('requiresStructuredOutput:W,onRoutingNotice:ccRoutingNotice,ccRoutingModelId})', 'requiresStructuredOutput:W,onRoutingNotice:drifted})');
      const skipped = applyRoutingNoticeTransform(drifted, CONFIG);

      expect(second.content).toBe(first.content);
      expect(second.results).toEqual([
        { status: 'SKIP', name: 'PATCH 10: routing notice', extra: 'already patched' },
        { status: 'SKIP', name: 'PATCH 10d: agent description indicator', extra: 'already patched' },
      ]);
      expect(skipped.content).toBe(drifted);
      expect(skipped.results).toEqual([
        { status: 'SKIP', name: 'PATCH 10: routing notice', extra: 'generated block could not be refreshed' },
        { status: 'SKIP', name: 'PATCH 10d: agent description indicator', extra: 'already patched' },
      ]);
    });

    it('refreshes changed display data without duplicating blocks', () => {
      const first = applyRoutingNoticeTransform(fixture(), CONFIG);
      const second = applyRoutingNoticeTransform(first.content, {
        'leverframe:openai-oauth:gpt-5.6-sol': { alias: 'sol', display: 'GPT Updated /*ccpatch:routing-notice*/onRoutingNotice:d' },
      });

      expect(second.results).toEqual([
        { status: 'OK', name: 'PATCH 10: routing notice (refresh)' },
        { status: 'OK', name: 'PATCH 10d: agent description indicator (refresh)' },
      ]);
      expect(second.content.split('/*ccpatch:routing-notice*/onRoutingNotice:d')).toHaveLength(2);
      expect(second.content.split('/*ccpatch:routing-notice-handoff*/if(d?.replHydration?.kind!=="resume"){')).toHaveLength(2);
      expect(second.content).toContain('GPT Updated \\u002f*ccpatch:routing-notice*/onRoutingNotice:d');
      expect(second.content).not.toContain('GPT Sol');
      expect(second.content.match(new RegExp(AGENT_DESCRIPTION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
    });

    it('refreshes a literal UTF-8 separator block to ASCII-safe source', () => {
      const current = applyRoutingNoticeTransform(fixture(), CONFIG).content;
      const legacy = current.replaceAll('\\u00b7', '·');
      const refreshed = applyRoutingNoticeTransform(legacy, CONFIG);

      expect(refreshed.results).toContainEqual({ status: 'OK', name: 'PATCH 10d: agent description indicator (refresh)' });
      expect(refreshed.content).toContain('" \\u00b7 "');
      expect(refreshed.content).not.toContain('" · "');
    });
  });
}

function defineAgentDescriptionTests(): void {
  describe('agent description indicator', () => {
    it('appends the resolved display and effort to the description local, once', () => {
      const withEffort = {
        'leverframe:openai-oauth:gpt-5.6-sol': { alias: 'sol', display: 'GPT Sol', effort: { levels: ['low', 'high'], defaultLevel: 'high' } },
      };
      const result = applyRoutingNoticeTransform(fixture(), withEffort);

      expect(result.results).toContainEqual({ status: 'OK', name: 'PATCH 10d: agent description indicator' });
      expect(result.content).toContain(`${AGENT_DESCRIPTION_MARKER}{let _ccat=Object.assign(Object.create(null),`);
      expect(result.content).toContain('if(r.indexOf(" \\u00b7 "+_ccad)===-1){r=r+" \\u00b7 "+_ccad+(_ccae?" \\u00b7 "+_ccae:"");}}');
      expect(result.content).not.toContain('" · "');
      expect(result.content).toContain('"sol":"high"');
      const appendIndicator = new Function('r', 'ne', `${descriptionBlock(result.content)};return r;`) as (description: string, modelId: string) => string;
      expect(appendIndicator('Implement Task 12 Redis cache', 'leverframe:openai-oauth:gpt-5.6-sol'))
        .toBe('Implement Task 12 Redis cache · GPT Sol · high');
    });

    it('falls back to the raw model id and omits effort when the model is absent from the config table', () => {
      const result = applyRoutingNoticeTransform(fixture(), {});

      expect(result.content).toContain('_ccad=_ccat!==void 0?_ccat:String(ne||"")');
      expect(result.content).toContain('if(r.indexOf(" \\u00b7 "+_ccad)===-1){r=r+" \\u00b7 "+_ccad+(_ccae?" \\u00b7 "+_ccae:"");}}');
    });

    it('guards the append with the exact resolved display suffix, not a bare middle-dot check, so a user description already containing " · " for unrelated reasons still gets the indicator appended', () => {
      const result = applyRoutingNoticeTransform(fixture(), CONFIG);
      const block = descriptionBlock(result.content);

      // The guard tests for the freshly-computed `_ccad` value as an exact
      // suffix candidate (`" · "+_ccad`), not a bare `/ · /` probe against the
      // description — so "check A · B" (which contains " · " but not the
      // computed display text) does not false-suppress the append.
      expect(block).toMatch(/if\(r\.indexOf\(" \\u00b7 "\+_ccad\)===-1\)\{/);
      expect(block).not.toMatch(/if\(!\/ [^"]*\/\.test\(r\)\)/);
      // _ccad/_ccae are computed unconditionally, before the guard.
      expect(block.indexOf('_ccad=_ccat!==void 0')).toBeLessThan(block.indexOf('if(r.indexOf('));
      // Both declarations stay scoped inside the wrapping block so nothing
      // leaks into the rest of call() when the guard is false.
      expect(block.startsWith(`${AGENT_DESCRIPTION_MARKER}{let _ccat=`)).toBe(true);
      expect(block.endsWith('}}')).toBe(true);
    });

    it('is idempotent on re-apply and SKIPs cleanly when the call signature anchor is absent', () => {
      const first = applyRoutingNoticeTransform(fixture(), CONFIG);
      const second = applyRoutingNoticeTransform(first.content, CONFIG);
      expect(second.content).toBe(first.content);
      expect(second.results).toContainEqual({ status: 'SKIP', name: 'PATCH 10d: agent description indicator', extra: 'already patched' });

      const withoutSignature = applyRoutingNoticeTransform([AGENT_CALL, G5_SIGNATURE, G5_CONTEXT].join('\n'), CONFIG);
      expect(withoutSignature.results).toContainEqual({ status: 'SKIP', name: 'PATCH 10d: agent description indicator', extra: 'call signature anchor not recognized' });
      expect(withoutSignature.content).not.toContain(AGENT_DESCRIPTION_MARKER);
    });

    it('never blocks or fails PATCH 10a-10c when its own anchor drifts', () => {
      const noSignature = [AGENT_CALL, G5_SIGNATURE, G5_CONTEXT].join('\n');
      const result = applyRoutingNoticeTransform(noSignature, CONFIG);

      expect(result.results[0]).toEqual({ status: 'OK', name: 'PATCH 10a: routing notice callback' });
      expect(result.results.every(item => item.status !== 'FAIL')).toBe(true);
    });
  });
}

function defineAnchorTests(): void {
  describe('routing notice anchors', () => {
    it('skips as a unit when one required side is absent', () => {
      const withoutRunner = applyRoutingNoticeTransform(AGENT_CALL, CONFIG);
      const withoutCallSite = applyRoutingNoticeTransform([G5_SIGNATURE, G5_CONTEXT].join('\n'), CONFIG);

      expect(withoutRunner).toEqual({
        content: AGENT_CALL,
        results: [
          { status: 'SKIP', name: 'PATCH 10: routing notice', extra: 'runner anchor not recognized' },
          { status: 'SKIP', name: 'PATCH 10d: agent description indicator', extra: 'call signature anchor not recognized' },
        ],
      });
      expect(withoutCallSite.results).toEqual([
        { status: 'SKIP', name: 'PATCH 10: routing notice', extra: 'Agent call-site anchor not recognized' },
        { status: 'SKIP', name: 'PATCH 10d: agent description indicator', extra: 'call-site anchor not recognized' },
      ]);
    });

    it('does not duplicate a structurally orphaned callback marker', () => {
      const orphaned = fixture().replace('}})},tt=', '}}),/*ccpatch:routing-notice*/onRoutingNotice:drifted},tt=');
      const result = applyRoutingNoticeTransform(orphaned, CONFIG);

      // PATCH 10a-10c stay blocked by the orphaned marker, but the
      // independent, optional description site is unaffected and still
      // applies — it must never be blocked by the other sites' partial state.
      expect(result.results).toEqual([
        { status: 'SKIP', name: 'PATCH 10: routing notice', extra: 'partial or ambiguous patch markers found' },
        { status: 'OK', name: 'PATCH 10d: agent description indicator' },
      ]);
      expect(result.content).not.toBe(orphaned);
      expect(result.content).toContain(AGENT_DESCRIPTION_MARKER);
    });
  });
}

defineDisplayTableTests();
defineInjectionTests();
defineLifecycleTests();
defineAgentDescriptionTests();
defineAnchorTests();
