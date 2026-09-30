import { describe, expect, it } from 'vitest';
import { applyRoutingNoticeTransform } from '../src/patch-transforms-routing-notice.js';
import { CLAUDE_AGENT_2_1_280 } from './fixtures/claude-agent-2.1.280.js';

const boundary = '\n//#__leverframe_claude_module__:';
const stateModule = boundary + '/state.js\n'
  + 'const defaultEffort={kind:"inherit"};'
  + 'function Za(e,n){let o=e.sessionEffort??defaultEffort;switch(o.kind){case"level":return o.value;case"default":return;case"inherit":return e.effort}}'
  + 'function Xv(){}export{Za,Xv};';
const agentModule = boundary + '/agent.js\nimport{Xv}from"/state.js";'
  + CLAUDE_AGENT_2_1_280.slice(CLAUDE_AGENT_2_1_280.indexOf('async function go'));

describe('Claude Code 2.1.285 Agent effort binding', () => {
  it('imports the verified native effort reader when Agent no longer imports it', () => {
    const outcome = applyRoutingNoticeTransform(stateModule + agentModule, {});

    expect(outcome.results.every(result => result.status === 'OK')).toBe(true);
    expect(outcome.content).toContain('import{Xv,Za as __lfcRoutingEffort}from"/state.js";');
    expect(outcome.content).toContain('__lfcRoutingEffort(e.getAppState(),__lfcModel)');
    expect(applyRoutingNoticeTransform(outcome.content, {}).content).toBe(outcome.content);
  });

  it('fails without importing a private native helper', () => {
    const outcome = applyRoutingNoticeTransform(stateModule.replace('export{Za,Xv}', 'export{Xv}') + agentModule, {});

    expect(outcome.results.every(result => result.status === 'FAIL')).toBe(true);
    expect(outcome.content).not.toContain('Za as __lfcRoutingEffort');
  });
});
