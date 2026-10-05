import { describe, expect, it } from 'vitest';
import { applyRoutingNoticeTransform } from '../src/patch-transforms-routing-notice.js';
import { CLAUDE_AGENT_2_1_280 } from './fixtures/claude-agent-2.1.280.js';

const boundary = '\n//#__leverframe_claude_module__:';
const stateModule = boundary + '/state.js\n'
  + 'const defaultEffort={kind:"inherit"};'
  + 'function Za(e,n){let o=e.sessionEffort??defaultEffort;switch(o.kind){case"level":return o.value;case"default":return;case"inherit":return e.effort}}'
  + 'function Xv(){}export{Za,Xv};';
const launch280 = 'let ut=await wn(),ve=$t();G.spawnedSubagent=ve;';
const launch288 = 'let ut=await wn();if(q!==void 0){ut()}let ve=$t();G.spawnedSubagent=ve;';
const agent280 = CLAUDE_AGENT_2_1_280.slice(CLAUDE_AGENT_2_1_280.indexOf('async function go'));
const agentModule = boundary + '/agent.js\nimport{Xv}from"/state.js";' + agent280.replace(launch280, launch288);

describe('Claude Code 2.1.288 Agent launch anchor', () => {
  it('inserts the routing notice after the subagent id when the launch await is its own statement', () => {
    const outcome = applyRoutingNoticeTransform(stateModule + agentModule, {});

    expect(outcome.results.every(result => result.status === 'OK')).toBe(true);
    expect(outcome.content).toContain('G.spawnedSubagent=ve;/*ccpatch:routing-v3:start*/');
    expect(applyRoutingNoticeTransform(outcome.content, {}).content).toBe(outcome.content);
  });

  it('fails when the subagent id is never stored', () => {
    const missing = agentModule.replace('G.spawnedSubagent=ve;', 'G.spawned=ve;');
    const outcome = applyRoutingNoticeTransform(stateModule + missing, {});

    expect(outcome.results.every(result => result.status === 'FAIL')).toBe(true);
    expect(outcome.content).not.toContain('/*ccpatch:routing-v3:start*/');
  });
});
