import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { applyRoutingNoticeTransform } from '../src/patch-transforms-routing-notice.js';
import { CLAUDE_AGENT_2_1_266 } from './fixtures/claude-agent-2.1.266.js';

const CONFIG = {
  'leverframe:openai-oauth:current': {
    alias: 'atlas', display: 'Atlas',
    effort: { levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'high' },
  },
};

interface ChildContext {
  options: { mainLoopModel: string };
  permissionLayers?: Array<{ kind: string; effort?: string }>;
  getAppState: () => { effort: string };
}

interface Notice {
  notification: {
    text: string;
    key: string;
    segments: Array<{ text: string; bold?: boolean }>;
  };
}

async function launch(source: string, input: Record<string, unknown> = {}, environmentEffort?: string) {
  const notices: Notice[] = [];
  const context = {
    options: { mainLoopModel: 'fable' },
    getAppState: () => ({ effort: 'medium' }),
    agentLifecycle: { markTypeInvoked() {} },
  };
  const runtime = runInNewContext(source + ';({tool,Mw})', {
    wKt: (layers: ChildContext['permissionLayers']) => layers?.filter(layer => layer.kind === 'effort').at(-1)?.effort,
    Za: (state: { effort: string }) => state.effort,
    c: (child: ChildContext) => child.options.mainLoopModel,
    uy: (model: string) => model !== 'no-effort',
    YF: () => Boolean(input['launchPin']),
    D: () => 'high',
    H0: () => environmentEffort,
    P: (effort: string) => effort === 'max' ? 'high' : effort,
    Ue: (model: string) => model,
    PL: (model: string) => ['fable', 'opus', 'sonnet'].includes(model) ? `Claude ${model}` : null,
    gLn: (definition: string, parent: string, override?: string) => override ?? definition ?? parent,
    S_n: (parent: ChildContext, child: Partial<ChildContext>) => ({ ...parent, ...child }),
  }) as {
    tool: { call: (...args: unknown[]) => Promise<Array<{ model: string; effort?: string; description: string }>> };
    Mw: (options: Record<string, unknown>) => AsyncIterable<{ description: string }>;
  };
  const output = await runtime.tool.call({
    prompt: 'Inspect', description: 'Check changes', subagent_type: 'reviewer',
    model: 'atlas', run_in_background: true, ...input,
  }, context, undefined, undefined, (notice: Notice) => notices.push(notice));
  return { notices, output, runtime, context };
}

describe('Claude Code 2.1.266 agent routing', () => {
  it('shows the child model and effective effort in the notice and description', async () => {
    const patched = applyRoutingNoticeTransform(CLAUDE_AGENT_2_1_266, CONFIG);
    const { notices, output } = await launch(patched.content, { definitionEffort: 'low' });

    expect(notices).toHaveLength(1);
    expect(notices[0]!.notification.text).toContain('reviewer');
    expect(notices[0]!.notification.text).toContain('Atlas');
    expect(notices[0]!.notification.text).toContain('low');
    expect(notices[0]!.notification.segments.filter(segment => segment.bold).map(segment => segment.text))
      .toEqual(['reviewer', 'Atlas', 'low']);
    expect(output[0]).toEqual({ model: 'atlas', effort: 'low', description: 'Check changes · Atlas · low' });
  });

  it('uses inherited effort and native environment overrides from the same resolver as the request', async () => {
    const patched = applyRoutingNoticeTransform(CLAUDE_AGENT_2_1_266, CONFIG);
    const inherited = await launch(patched.content);
    const overridden = await launch(patched.content, { definitionEffort: 'low' }, 'xhigh');

    expect(inherited.notices[0]?.notification.text).toContain('medium');
    expect(overridden.notices[0]?.notification.text).toContain('xhigh');
    expect(overridden.output[0]?.effort).toBe('xhigh');
  });

  it('honors the request query source when resolving launch-pinned effort', async () => {
    const patched = applyRoutingNoticeTransform(CLAUDE_AGENT_2_1_266, CONFIG);
    const pinned = await launch(patched.content, { launchPin: true, definitionEffort: 'low' });
    const investigator = await launch(patched.content, {
      launchPin: true, definitionEffort: 'low', querySource: 'auto_mode_investigator',
    });

    expect(pinned.output[0]?.effort).toBe('high');
    expect(pinned.notices[0]?.notification.text).toContain('Effort high');
    expect(investigator.output[0]?.effort).toBe('low');
    expect(investigator.notices[0]?.notification.text).toContain('Effort low');
  });

  it.each(['fable', 'opus', 'sonnet'])('retains native %s display and subscription model identity', async model => {
    const patched = applyRoutingNoticeTransform(CLAUDE_AGENT_2_1_266, CONFIG);
    const { notices, output } = await launch(patched.content, { model });

    expect(output[0]?.model).toBe(model);
    expect(notices[0]?.notification.text).toContain(`Claude ${model}`);
    expect(notices[0]?.notification.text).toContain('medium');
  });

  it('does not emit another launch notice on resume', async () => {
    const patched = applyRoutingNoticeTransform(CLAUDE_AGENT_2_1_266, CONFIG);
    const resumed = await launch(patched.content, { override: { replHydration: { kind: 'resume' } } });

    expect(resumed.notices).toEqual([]);
    expect(resumed.output[0]?.description).toBe('Check changes');
  });

  it('preserves descriptions for runner callers outside the Agent tool', async () => {
    const patched = applyRoutingNoticeTransform(CLAUDE_AGENT_2_1_266, CONFIG);
    const { runtime, context } = await launch(patched.content);
    const output = [];
    for await (const step of runtime.Mw({
      agentDefinition: { agentType: 'internal' }, toolUseContext: context,
      description: 'Internal operation', model: 'atlas',
    })) output.push(step);
    expect(output[0]?.description).toBe('Internal operation');
  });

  it('labels an Agent description even when the caller omits its notification callback', async () => {
    const patched = applyRoutingNoticeTransform(CLAUDE_AGENT_2_1_266, CONFIG);
    const { runtime, context } = await launch(patched.content);
    const output = await runtime.tool.call({
      subagent_type: 'reviewer', model: 'atlas', description: 'Review',
    }, context);
    expect(output[0]?.description).toBe('Review · Atlas · medium');
  });

  it('retains display names for context modes and rejects inherited object properties', async () => {
    const patched = applyRoutingNoticeTransform(CLAUDE_AGENT_2_1_266, CONFIG);
    const maximum = await launch(patched.content, { model: 'atlas[maximum]' });
    const unknown = await launch(patched.content, { model: 'constructor' });

    expect(maximum.notices[0]?.notification.text).toContain('Model Atlas');
    expect(unknown.notices[0]?.notification.text).toContain('Model constructor');
  });

  it('refreshes display metadata and remains idempotent', async () => {
    const first = applyRoutingNoticeTransform(CLAUDE_AGENT_2_1_266, CONFIG);
    const second = applyRoutingNoticeTransform(first.content, CONFIG);
    expect(second.content).toBe(first.content);
    const changed = applyRoutingNoticeTransform(second.content, {
      'leverframe:openai-oauth:current': { ...CONFIG['leverframe:openai-oauth:current'], display: 'Updated Atlas' },
    });
    const { notices } = await launch(changed.content);
    expect(notices[0]?.notification.text).toContain('Updated Atlas');
  });

  it('preserves Unicode display names and separators in the native byte container', async () => {
    const patched = applyRoutingNoticeTransform(CLAUDE_AGENT_2_1_266, {
      'leverframe:openai-oauth:current': { ...CONFIG['leverframe:openai-oauth:current'], display: 'Lüná' },
    });
    const nativeText = Buffer.from(patched.content, 'utf8').toString('latin1');
    const { notices, output } = await launch(nativeText);

    expect(notices[0]?.notification.text).toBe('Agent reviewer · Model Lüná · Effort medium');
    expect(output[0]?.description).toBe('Check changes · Lüná · medium');
  });
});
