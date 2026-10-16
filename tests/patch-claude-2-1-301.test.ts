import { describe, expect, it } from 'vitest';
import { applyLeverframePatches } from '../src/patch-transforms.js';
import { applyRoutingNoticeTransform } from '../src/patch-transforms-routing-notice.js';
import { CLAUDE_AGENT_2_1_280 } from './fixtures/claude-agent-2.1.280.js';

const AGENT_SCHEMA = [
  'model:Nr(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent.`)',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"]',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
].join('\n');
const RESUME_SITE_301 = 'let y=pHr(m),k=!(o.has(qe(m))||CIe(m)||y!==void 0&&vHr(y)||Hn(m)===s)'
  + '?"unknown_family":!dS(m)&&!Kr(m)?"not_allowed":ote(m)?"retired":void 0;';

describe('Claude Code 2.1.301 session-restore model allowlist', () => {
  it('admits an allowlisted model past the guarded family check', () => {
    const result = applyLeverframePatches([AGENT_SCHEMA, RESUME_SITE_301].join('\n'), {
      'leverframe:openai-oauth:gpt-5.6-sol': { alias: 'sol' },
    });

    expect(result.content).toContain(
      '!(o.has(qe(m))||CIe(m)||y!==void 0&&vHr(y)||Hn(m)===s||/*ccpatch:resume-model*/Kr(m))?"unknown_family":',
    );
  });
});

const boundary = '\n//#__leverframe_claude_module__:';
const stateModule = boundary + '/state.js\n'
  + 'const defaultEffort={kind:"inherit"};'
  + 'function Za(e,n,{withHold:r=!0}={}){let o=e.sessionEffort??defaultEffort;switch(o.kind){case"level":return o.value;case"default":return;case"inherit":return e.effort}}'
  + 'function Xv(){}export{Za,Xv};';
const agent280 = CLAUDE_AGENT_2_1_280.slice(CLAUDE_AGENT_2_1_280.indexOf('async function go'));
const agentModule301 = boundary + '/agent.js\nimport{Xv}from"/state.js";' + agent280
  .replace('let ut=await wn(),ve=$t();G.spawnedSubagent=ve;', 'let ut=await wn();if(q!==void 0){ut()}let ve=$t();G.spawnedSubagent=ve;')
  .replace('onProgress:f})', 'onProgress:f,timing:_,enclosingToolUseId:T})');

describe('Claude Code 2.1.301 Agent signature with timing', () => {
  it('inserts the routing notice when the Agent signature carries timing', () => {
    const outcome = applyRoutingNoticeTransform(stateModule + agentModule301, {});

    expect(outcome.results.map(result => result.status)).toEqual(['OK', 'OK']);
    expect(outcome.content).toContain('G.spawnedSubagent=ve;/*ccpatch:routing-v3:start*/');
  });
});
