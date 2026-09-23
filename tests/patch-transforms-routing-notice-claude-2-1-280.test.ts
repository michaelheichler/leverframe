import { describe, expect, it } from 'vitest';
import { applyRoutingNoticeTransform } from '../src/patch-transforms-routing-notice.js';
import { CLAUDE_AGENT_2_1_280 } from './fixtures/claude-agent-2.1.280.js';

describe('Claude Code 2.1.280 agent routing', () => {
  it('adds model and effort to the accepted Agent launch', () => {
    const unrelated = 'let elsewhere={agentDefinition:other,promptMessages:[]};';
    const config = {
      'leverframe:openai-oauth:current': { alias: 'atlas', display: 'Atlas' },
    };
    const outcome = applyRoutingNoticeTransform(unrelated + CLAUDE_AGENT_2_1_280, config);

    expect(outcome.results).toEqual([
      { status: 'OK', name: 'PATCH 10: routing notice' },
      { status: 'OK', name: 'PATCH 10d: agent description indicator' },
    ]);
    expect(outcome.content).toContain('/*ccpatch:routing-v3:start*/');
    expect(outcome.content).toContain(unrelated);
    expect(outcome.content).toContain('G.spawnedSubagent=ve;/*ccpatch:routing-v3:start*/');
    expect(outcome.content).toContain('Ge.description=C;');
    expect(outcome.content).toContain('__lfcEffort=String(s.effort??Za(e.getAppState(),__lfcModel)??"default")');
    expect(outcome.content).toContain('??__lfcModel,');
    expect(applyRoutingNoticeTransform(outcome.content, config).content).toBe(outcome.content);
  });
});
