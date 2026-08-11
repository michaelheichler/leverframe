import { describe, expect, it } from 'vitest';
import {
  applyRoutingNoticeTransform,
  buildRoutingDisplayTable,
  ROUTING_NOTICE_HANDOFF_MARKER,
} from '../src/patch-transforms-routing-notice.js';
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
  return [AGENT_CALL, G5_SIGNATURE, G5_CONTEXT].join('\n');
}
function handoff(content: string): string {
  return content.slice(content.indexOf(ROUTING_NOTICE_HANDOFF_MARKER));
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
    it('injects the callback and handoff sites', () => {
      const result = applyRoutingNoticeTransform(fixture(), CONFIG);

      expect(result.results.map(item => item.status)).toEqual(['OK', 'OK', 'OK']);
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
      expect(second.results).toEqual([{ status: 'SKIP', name: 'PATCH 10: routing notice', extra: 'already patched' }]);
      expect(skipped.content).toBe(drifted);
      expect(skipped.results).toEqual([{ status: 'SKIP', name: 'PATCH 10: routing notice', extra: 'generated block could not be refreshed' }]);
    });

    it('refreshes changed display data without duplicating blocks', () => {
      const first = applyRoutingNoticeTransform(fixture(), CONFIG);
      const second = applyRoutingNoticeTransform(first.content, {
        'leverframe:openai-oauth:gpt-5.6-sol': { alias: 'sol', display: 'GPT Updated /*ccpatch:routing-notice*/onRoutingNotice:d' },
      });

      expect(second.results).toEqual([{ status: 'OK', name: 'PATCH 10: routing notice (refresh)' }]);
      expect(second.content.split('/*ccpatch:routing-notice*/onRoutingNotice:d')).toHaveLength(2);
      expect(second.content.split('/*ccpatch:routing-notice-handoff*/if(d?.replHydration?.kind!=="resume"){')).toHaveLength(2);
      expect(second.content).toContain('GPT Updated \\u002f*ccpatch:routing-notice*/onRoutingNotice:d');
      expect(second.content).not.toContain('GPT Sol');
    });
  });
}

function defineAnchorTests(): void {
  describe('routing notice anchors', () => {
    it('skips as a unit when one required side is absent', () => {
      const withoutRunner = applyRoutingNoticeTransform(AGENT_CALL, CONFIG);
      const withoutCallSite = applyRoutingNoticeTransform([G5_SIGNATURE, G5_CONTEXT].join('\n'), CONFIG);

      expect(withoutRunner).toEqual({ content: AGENT_CALL, results: [{ status: 'SKIP', name: 'PATCH 10: routing notice', extra: 'runner anchor not recognized' }] });
      expect(withoutCallSite.results).toEqual([{ status: 'SKIP', name: 'PATCH 10: routing notice', extra: 'Agent call-site anchor not recognized' }]);
    });

    it('does not duplicate a structurally orphaned callback marker', () => {
      const orphaned = fixture().replace('}})},tt=', '}}),/*ccpatch:routing-notice*/onRoutingNotice:drifted},tt=');
      const result = applyRoutingNoticeTransform(orphaned, CONFIG);

      expect(result).toEqual({
        content: orphaned,
        results: [{ status: 'SKIP', name: 'PATCH 10: routing notice', extra: 'partial or ambiguous patch markers found' }],
      });
    });
  });
}

defineDisplayTableTests();
defineInjectionTests();
defineLifecycleTests();
defineAnchorTests();
