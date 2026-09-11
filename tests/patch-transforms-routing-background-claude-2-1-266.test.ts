import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { applyRoutingNoticeTransform } from '../src/patch-transforms-routing-notice.js';
import { CLAUDE_AGENT_BACKGROUND_2_1_266 } from './fixtures/claude-agent-background-2.1.266.js';

const CONFIG = {
  'leverframe:openai-oauth:current': {
    alias: 'atlas', display: 'Atlas',
    effort: { levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'high' },
  },
};

interface Notice {
  notification: { text: string };
}

function setup(overrides: { aborted?: boolean; rejectSlot?: boolean } = {}) {
  const patched = applyRoutingNoticeTransform(CLAUDE_AGENT_BACKGROUND_2_1_266, CONFIG);
  expect(patched.results.every(result => result.status === 'OK')).toBe(true);
  const notices: Notice[] = [];
  const runtime = runInNewContext(patched.content + ';({tool,scheduled,rows})', {
    uy: () => true,
    YF: () => false,
    D: () => 'high',
    H0: () => undefined,
    P: (effort: string) => effort,
    Ue: (model: string) => model,
    PL: () => null,
    gLn: (definition: string, parent: string, override?: string) => override ?? definition ?? parent,
    S_n: (parent: object, child: object) => ({ ...parent, ...child }),
    Bw: String,
    ty: String,
    rejectSlot: overrides.rejectSlot ?? false,
  }) as {
    tool: { call: (...args: unknown[]) => Promise<{ data: { description: string }; row: { description: string } }> };
    scheduled: Array<() => AsyncIterable<unknown>>;
    rows: Array<{ description: string }>;
  };
  const context = {
    options: { mainLoopModel: 'sonnet' },
    getAppState: () => ({
      sessionEffort: { kind: 'inherit' },
      settingsEffortTable: { default: 'medium', byModel: { 'atlas[maximum]': 'xhigh' } },
    }),
    agentLifecycle: { markTypeInvoked() {} },
    abortController: { signal: { aborted: overrides.aborted ?? false } },
  };
  const launch = () => runtime.tool.call({
    prompt: 'Inspect', description: 'Routing probe check', subagent_type: 'reviewer',
    model: 'atlas[maximum]', run_in_background: true,
  }, context, undefined, undefined, (notice: Notice) => notices.push(notice));
  return { launch, notices, runtime };
}

describe('Claude Code 2.1.266 background agent routing', () => {
  it('labels the parent row and emits the notice before the deferred runner starts', async () => {
    const { launch, notices, runtime } = setup();
    const launched = await launch();

    expect(runtime.scheduled).toHaveLength(1);
    expect(runtime.rows).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.notification.text).toContain('Model Atlas');
    expect(notices[0]!.notification.text).toContain('Effort xhigh');
    expect(launched.data.description).toBe('Routing probe check · Atlas · xhigh');
    expect(launched.row.description).toBe('Routing probe check · Atlas · xhigh');
  });

  it.each([
    { name: 'aborted', overrides: { aborted: true } },
    { name: 'slot rejected', overrides: { rejectSlot: true } },
  ])('does not report a routing success when the launch is $name', async ({ overrides }) => {
    const { launch, notices, runtime } = setup(overrides);

    await expect(launch()).rejects.toThrow();
    expect(notices).toEqual([]);
    expect(runtime.rows).toEqual([]);
    expect(runtime.scheduled).toEqual([]);
  });
});
