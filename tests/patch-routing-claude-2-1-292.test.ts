import { describe, expect, it } from 'vitest';
import { applyRoutingNoticeTransform } from '../src/patch-transforms-routing-notice.js';
import { CLAUDE_AGENT_2_1_280 } from './fixtures/claude-agent-2.1.280.js';

const boundary = '\n//#__leverframe_claude_module__:';
const stateModule = (reader: string) => boundary + '/state.js\n'
  + 'const defaultEffort={kind:"inherit"};'
  + 'function Za(' + reader + '){let o=e.sessionEffort??defaultEffort;switch(o.kind){case"level":return o.value;case"default":return;case"inherit":return e.effort}}'
  + 'function Xv(){}export{Za,Xv};';
const reader280 = 'e,n';
const reader292 = 'e,n,{withHold:r=!0}={}';
const launch280 = 'let ut=await wn(),ve=$t();G.spawnedSubagent=ve;';
const launch288 = 'let ut=await wn();if(q!==void 0){ut()}let ve=$t();G.spawnedSubagent=ve;';
const signature280 = 'async function go({agentInput:n,toolUseContext:e,canUseTool:h,assistantMessage:g,onProgress:f})';
const signature292 = 'async function go({agentInput:n,toolUseContext:e,canUseTool:h,assistantMessage:g,onProgress:f,enclosingToolUseId:T})';
const agent280 = CLAUDE_AGENT_2_1_280.slice(CLAUDE_AGENT_2_1_280.indexOf('async function go'));
const agentModule = (signature: string) => boundary + '/agent.js\nimport{Xv}from"/state.js";'
  + agent280.replace(launch280, launch288).replace(signature280, signature);
const bundle292 = () => stateModule(reader292) + agentModule(signature292);

describe('Claude Code 2.1.292 Agent signature and effort reader', () => {
  it('inserts the routing notice after the subagent id and reads session effort with two arguments', () => {
    const outcome = applyRoutingNoticeTransform(bundle292(), {});

    expect(outcome.results.every(result => result.status === 'OK')).toBe(true);
    expect(outcome.content).toContain('G.spawnedSubagent=ve;/*ccpatch:routing-v3:start*/');
    expect(outcome.content).toMatch(/Za\([\w$]+\.getAppState\(\),__lfcModel\)/);
  });

  it('leaves an already patched 2.1.292 bundle unchanged', () => {
    const patched = applyRoutingNoticeTransform(bundle292(), {}).content;

    const reapplied = applyRoutingNoticeTransform(patched, {}).content;

    expect(reapplied).toContain('/*ccpatch:routing-v3:start*/');
    expect(reapplied).toBe(patched);
  });

  it('still patches the five-parameter Agent signature with the two-parameter effort reader', () => {
    const outcome = applyRoutingNoticeTransform(stateModule(reader280) + agentModule(signature280), {});

    expect(outcome.results.every(result => result.status === 'OK')).toBe(true);
  });
});
