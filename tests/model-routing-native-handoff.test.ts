import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { dirname, relative, sep } from 'node:path';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ROUTING_ACTIVE_ENV, ROUTING_ACTIVE_VALUE, ROUTING_LAUNCH_ACTION, ROUTING_PREPARE_ACTION,
  ROUTING_SNAPSHOT_LABEL } from '../src/constants.js';
import { prepareRoutingHandoff } from '../src/model-routing.js';
import { applyModelRoutingTransform } from '../src/patch-transforms-model-routing.js';
import { getAppHome } from '../src/paths.js';
import { resolveRoutingBinding, routingBindingStatePath } from '../src/routing-bindings.js';
import { acknowledgment, assertIsolatedRoutingSession, nativeRoutingContext, noticeOrResponse, readNoticeSequence,
  registerConsumer, requestJson, safeResponseSummary, sendBoundRequest, startNativeService } from './fixtures/model-routing-proxy.js';
import {
  claudeAgentRoutingHandoffSource as nativeHandoffSource,
  ROUTING_TEST_PROMPT_POLICY as policy,
} from './fixtures/claude-agent-2.1.314-routing.js';
const proxyToken = 'fixture-native-routing-token';
const controlOrigin = 'http://127.0.0.1:43123';
const originalTask = 'Keep parser response order stable while routing changes.';
const loopbackFetch = globalThis.fetch.bind(globalThis);
const handoff = {
  version: 1,
  originalTask,
  requiredConstraints: ['Keep response order unchanged.'],
  toolInstructions: ['Read the parser implementation.'],
  evidence: [{ source: 'tool-result', content: 'The parser currently preserves source order.' }],
  jobState: 'One compatibility case remains open.',
};
const outerHome = process.env['LEVERFRAME_TEST_HOME'];

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function makeHandoffInput(prompt = originalTask) {
  return {
    description: 'Review the parser behavior.',
    prompt,
    subagent_type: 'reviewer',
    routing_category: 'review',
    routing_handoff: handoff,
  };
}

function preparedPrompt(): string {
  return JSON.stringify(prepareRoutingHandoff({ policy, agentType: 'reviewer', explicitCategory: 'review',
    delegatedTask: originalTask, ...handoff }).envelope);
}

function addHookInstruction(prompt: string): string {
  try {
    return JSON.stringify({ ...JSON.parse(prompt) as Record<string, unknown>,
      additionalInstructions: ['Retain native response order.'] });
  } catch {
    return prompt;
  }
}

function evaluateNative(options: {
  active?: boolean;
  hook?: (prompt: string) => string;
  changeAgentType?: boolean;
  resumeResponse?: Record<string, unknown>;
  fetcher?: (url: URL, init: { signal?: AbortSignal; body: string }) => Promise<unknown>;
  origin?: string;
  sessionId?: string;
  proxyToken?: string;
  events?: string[];
  requests?: Array<Record<string, unknown>>;
  systems?: Array<unknown[]>;
}) {
  const events = options.events ?? [];
  const requests = options.requests ?? [];
  const systems = options.systems ?? [];
  const env: Record<string, string> = { LEVERFRAME_CONTEXT_SELECTION_BASE_URL: options.origin ?? controlOrigin,
    LEVERFRAME_CONTEXT_SELECTION_TOKEN: options.proxyToken ?? proxyToken };
  if (options.active) env[ROUTING_ACTIVE_ENV] = ROUTING_ACTIVE_VALUE;
  const transformed = applyModelRoutingTransform(nativeHandoffSource(), { enabled: true, promptPolicy: policy });
  const executable = transformed.content.replace(/import\{[^}]+\}from"[^"]+";/g, '');
  const run = runInNewContext(executable + ';({Go,lwo,runLaunch,runResume,restoreAgentCall,buildRequest})', {
    process: { env },
    URL,
    AbortSignal,
    Buffer,
    TextDecoder,
    f: (thunk: () => unknown) => thunk(),
    u: z.object,
    o: () => z.string(),
    T: z.array,
    C: z.literal,
    lmi: 'Agent description',
    ami: 'Agent task',
    __lfSession: () => options.sessionId ?? 'session-from-native-fixture',
    z: () => options.sessionId ?? 'session-from-native-fixture',
    lS: () => { events.push('child-id'); return 'child-launch-from-native-fixture'; },
    fc: () => 'parent-model',
    iAe: (_agent: unknown, _parent: string, model?: string) => model ?? 'native-child-model',
    jG: (...args: [unknown, string, string]) => { const model = args[2]; events.push('model-selection'); return model; },
    XAo: async ({ prompt, agent: _agent }: { prompt: string; agent: unknown }) => {
      events.push('spawn-hook');
      return { agent: options.changeAgentType ? { agentType: 'different-agent', model: 'native-child-model' }
        : { agentType: 'reviewer', model: 'native-child-model' },
        spawn: { prompt: options.hook ? options.hook(prompt) : prompt, description: 'Review launch', background: undefined } };
    },
    Gt: (agent: Record<string, unknown>, update: Record<string, unknown>) => ({ ...agent, ...update }),
    Bn: async ({ rewritten }: { rewritten: { prompt: string } }) => {
      events.push('permission-review');
      events.push(`permission-prompt:${rewritten.prompt}`);
      return {};
    },
    Oe: ({ content }: { content: unknown }) => ({ role: 'user', content }),
    fEi: (messages: unknown[]) => ({ copies: messages }),
    gqs: () => ({}),
    U: undefined,
    _t: undefined,
    Hn: async () => undefined,
    Rrn: {},
    oX: () => false,
    UH: () => false,
    spawnTeammate: () => { events.push('teammate-spawn'); },
    AVe: () => false,
    Nce: () => ({ onToolPool: undefined, reviewTools: [] }),
    ffn: async (_agents: unknown[], model: string) => { events.push(`child-inference:${model}`); return `system:${model}`; },
    fetch: async (input: URL, init: { signal?: AbortSignal; body: string }) => {
      if (input.hostname !== '127.0.0.1') throw new Error('Only loopback control is allowed in this fixture.');
      if (init.signal?.aborted) throw new DOMException('Control request aborted.', 'AbortError');
      const body = JSON.parse(init.body) as Record<string, unknown>;
      requests.push(body);
      events.push(body['action'] === ROUTING_PREPARE_ACTION ? 'prepare-control'
        : body['action'] === ROUTING_LAUNCH_ACTION ? 'launch-control' : 'legacy-control');
      return options.fetcher ? options.fetcher(input, init) : Promise.resolve({
        ok: true,
        status: 200,
        json: async () => {
          return body['action'] === ROUTING_PREPARE_ACTION
            ? { prompt: preparedPrompt(), provenance: 'explicit' }
            : { modelId: 'opaque-routing-binding', policyModelId: 'native-specialist-model', effort: 'low',
              contextWindow: 70_000, maxOutputTokens: 8_000, revision: 1,
              ...(body['resume'] === true && options.resumeResponse === undefined
                ? { handoff: { version: 1, agentType: 'reviewer', reviewedTask: preparedPrompt() } } : {}),
              ...options.resumeResponse };
        },
      });
    },
    xn: async () => { events.push('restored-native-call'); return 'restored'; },
    Kt: { id: 'restored-call' },
    Ih: { shapeInheritedFields: (_inherited: unknown, shaped: Record<string, unknown>) => shaped },
    Die: () => [{ type: 'text', text: 'Native OAuth account identity.', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    s8t: (tools: unknown) => tools,
    gt: {},
    LT: (model: string) => model,
    jn: (model: string) => model,
    D0: {},
    cG: () => undefined,
    a6e: () => ({ session: 'native-session-identity' }),
    send: (request: Record<string, unknown>) => request,
  }) as {
    Go: { parse: (value: unknown) => Record<string, unknown> };
    lwo: (value: unknown, fork: boolean) => Record<string, unknown>;
    runLaunch: (context: Record<string, unknown>) => Promise<Record<string, unknown>>;
    runResume: (context: Record<string, unknown>, id: string) => Promise<Record<string, unknown>>;
    restoreAgentCall: (context: Record<string, unknown>) => Promise<unknown>;
    buildRequest: (request: Record<string, unknown>, messages: unknown) => Record<string, unknown>;
  };
  return { ...run, events, requests, systems, transformed };
}

function launchContext(agentInput = makeHandoffInput(), extras: Record<string, unknown> = {}) {
  return { agentInput, abortController: new AbortController(), options: { tools: [] }, agentId: 'parent-agent',
    messages: [{ role: 'user', content: 'parent conversation history' }], ...extras };
}

function resumeContext(promptMessages: Array<Record<string, unknown>> = [], extras: Record<string, unknown> = {}) {
  return { abortController: new AbortController(), options: { tools: [] }, promptMessages,
    followupMessages: [{ role: 'assistant', content: 'The current implementation still needs review.' }], ...extras };
}

it('parses the structured category and handoff through the native Agent schema', async () => {
  const harness = evaluateNative({ active: true });
  const child = await harness.runLaunch(launchContext());
  const preparation = harness.requests.find(request => request['action'] === ROUTING_PREPARE_ACTION);
  const launch = harness.requests.find(request => request['action'] === ROUTING_LAUNCH_ACTION);

  expect({ category: preparation?.['category'], originalTask: preparation?.['originalTask'],
    constraints: preparation?.['requiredConstraints'], evidence: preparation?.['evidence'],
    launchCategory: launch?.['category'], launchTask: launch?.['task'], childMessages: child['promptMessages'] }).toMatchObject({
    category: 'review',
    originalTask,
    constraints: handoff.requiredConstraints,
    evidence: handoff.evidence,
    launchCategory: 'review',
    childMessages: [{ role: 'user', content: expect.any(String) }],
  });
  expect(launch?.['task']).not.toBe(originalTask);
});

it('retains category and handoff fields through both derived native Agent schemas', () => {
  const harness = evaluateNative({ active: true });
  const ordinary = harness.lwo(makeHandoffInput(), false);
  const forkDerived = harness.lwo(makeHandoffInput(), true);

  expect({ ordinaryCategory: ordinary['routing_category'], ordinaryHandoff: ordinary['routing_handoff'],
    forkCategory: forkDerived['routing_category'], forkHandoff: forkDerived['routing_handoff'] }).toEqual({
    ordinaryCategory: 'review', ordinaryHandoff: handoff, forkCategory: 'review', forkHandoff: handoff,
  });
});

it('reviews the prepared prompt before permission and sends the exact reviewed prompt before child inference', async () => {
  const harness = evaluateNative({ active: true, hook: addHookInstruction });
  const child = await harness.runLaunch(launchContext());
  const prepareIndex = harness.events.indexOf('prepare-control');
  const hookIndex = harness.events.indexOf('spawn-hook');
  const permissionIndex = harness.events.findIndex(event => event.startsWith('permission-prompt:'));
  const launchIndex = harness.events.indexOf('launch-control');
  const inferenceIndex = harness.events.findIndex(event => event.startsWith('child-inference:'));
  const launch = harness.requests.find(request => request['action'] === ROUTING_LAUNCH_ACTION);
  const reviewedPrompt = String(launch?.['task']);

  expect({ ordered: prepareIndex < hookIndex && hookIndex < permissionIndex && permissionIndex < launchIndex
      && launchIndex < inferenceIndex,
    permissionPrompt: harness.events[permissionIndex]?.slice('permission-prompt:'.length),
    launchPrompt: reviewedPrompt,
    originalPrompt: launch?.['originalPrompt'],
    childMessages: child['promptMessages'] }).toMatchObject({
    ordered: true,
    permissionPrompt: reviewedPrompt,
    originalPrompt: preparedPrompt(),
    childMessages: [{ role: 'user', content: reviewedPrompt }],
  });
});

it('completes a reviewed native handoff through the authenticated loopback controller', async () => {
  const sessionId = randomUUID();
  const context = nativeRoutingContext();
  const nativeTargetModel = context.catalog.models.find(model => model.ref.providerId === context.routerTarget?.providerId
    && model.ref.modelId === context.routerTarget?.modelId)!;
  nativeTargetModel.capabilities.tools = true;
  nativeTargetModel.confirmedCapabilities.push('tools');
  context.config = { ...context.config, defaultCategory: 'review', agentCategories: { reviewer: 'review' },
    categories: { review: { target: context.routerTarget!, effort: 'low', instructions: policy.categoryInstructions['review'] } } };
  assertIsolatedRoutingSession(sessionId);
  const service = await startNativeService(context, { injectNativeRoutingFetch: true });
  const { proxy, certificates, observation, close } = service;
  const statePath = routingBindingStatePath(sessionId);
  expect(outerHome).toBeTruthy();
  expect(process.env['HOME']).toBeTruthy();
  expect(inside(outerHome!, getAppHome())).toBe(true);
  expect(inside(outerHome!, dirname(statePath))).toBe(true);
  expect(inside(outerHome!, certificates.caCertPath)).toBe(true);
  vi.stubGlobal('fetch', async () => { throw new Error('Default fetch is disabled in native transport fixtures.'); });
  const events: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const harness = evaluateNative({ active: true, hook: addHookInstruction, requests, events, sessionId,
    proxyToken: context.proxyToken, origin: `http://${proxy.host}:${proxy.port}`,
    fetcher: async (url, init) => loopbackFetch(url, { method: 'POST', redirect: 'error', signal: init.signal,
      headers: { authorization: `Bearer ${context.proxyToken}`, 'content-type': 'application/json' }, body: init.body }) });
  let notices: ReturnType<typeof readNoticeSequence> | undefined;

  try {
    const consumer = await registerConsumer(proxy.port, sessionId, proxy.token);
    const consumerId = String(consumer.body.consumerId);
    notices = readNoticeSequence(proxy.port, sessionId, consumerId, proxy.token);
    expect((await notices.connected).status).toBe(200);
    const child = await harness.runLaunch(launchContext(makeHandoffInput(), { sessionId }));
    const preparation = requests.find(request => request['action'] === ROUTING_PREPARE_ACTION);
    const launch = requests.find(request => request['action'] === ROUTING_LAUNCH_ACTION);
    const bindingId = String(child['routingBinding']);
    const bindingBefore = await resolveRoutingBinding({ sessionId, modelId: bindingId });
    const reviewedTask = String((child['promptMessages'] as Array<{ content: string }>)[0]?.content);
    const system = [{ type: 'text', text: 'Native OAuth identity and account instructions.',
      cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: 'Stable provider system context.', cache_control: { type: 'ephemeral' } }];
    const firstMessages = [{ role: 'user', content: reviewedTask }];
    const secondMessages = [...firstMessages, { role: 'assistant', content: 'The first turn completed.' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'native-tool-result',
        content: 'The follow-up tool result.' }] }];
    const sharedBody = { system, cache_control: { type: 'ephemeral', ttl: '1h' },
      cache_control_metadata: { session: sessionId, prefix: 'stable' } };
    const firstRequest = sendBoundRequest(proxy, certificates.caCert, sessionId, bindingId, 'low',
      { 'X-Fixture-Client': 'native-handoff' }, { ...sharedBody, messages: firstMessages });
    const launchOutcome = await noticeOrResponse(notices.nextNotice(), firstRequest);
    expect(launchOutcome.kind, JSON.stringify(safeResponseSummary(launchOutcome))).toBe('notice');
    expect(launchOutcome.stream!.notice).toMatchObject({ kind: 'launch', sessionId, modelId: bindingId,
      acknowledged: false });
    expect(observation.requests).toHaveLength(0);
    const launchAck = await requestJson(proxy.port, '/v1/leverframe/routing-notice-ack', proxy.token,
      acknowledgment(launchOutcome.stream!.notice, consumerId));
    expect(launchAck).toMatchObject({ status: 200, body: { acknowledged: true } });
    const first = await firstRequest;
    const completed = await notices.nextNotice();
    expect(completed.notice).toMatchObject({ kind: 'request_completed', sessionId, modelId: bindingId,
      revision: bindingBefore.revision, reason: 'request_completed', target: bindingBefore.decision.target,
      acknowledged: false });
    const completedAck = await requestJson(proxy.port, '/v1/leverframe/routing-notice-ack', proxy.token,
      acknowledgment(completed.notice, consumerId));
    expect(completedAck).toMatchObject({ status: 200, body: { acknowledged: true } });
    const second = await sendBoundRequest(proxy, certificates.caCert, sessionId, bindingId, 'low',
      { 'X-Fixture-Client': 'native-handoff' }, { ...sharedBody, messages: secondMessages });
    const binding = await resolveRoutingBinding({ sessionId, modelId: bindingId });
    const providerBodies = observation.requests.map(request => request.body);

    expect(binding.revision).toBe(bindingBefore.revision);
    expect(binding.identity).toEqual(bindingBefore.identity);
    expect(binding.decision.target).toEqual(bindingBefore.decision.target);

    expect({ events: events.filter(event => ['prepare-control', 'spawn-hook', 'permission-review', 'launch-control']
        .some(prefix => event.startsWith(prefix))),
      category: preparation?.['category'], launchCategory: launch?.['category'],
      launchPrompt: launch?.['task'], permissionPrompt: events.find(event => event.startsWith('permission-prompt:'))?.slice(18),
      bindingHandoff: binding.handoff?.reviewedTask, childMessages: child['promptMessages'],
      providerStatuses: [first.status, second.status], providerCalls: observation.requests.length }).toMatchObject({
      events: ['prepare-control', 'spawn-hook', 'permission-review', 'launch-control'],
      category: 'review',
      launchCategory: 'review',
      launchPrompt: reviewedTask,
      permissionPrompt: reviewedTask,
      bindingHandoff: reviewedTask,
      childMessages: [{ role: 'user', content: reviewedTask }],
      providerStatuses: [expect.stringContaining('200'), expect.stringContaining('200')],
      providerCalls: 2,
    });
    expect(providerBodies.map(body => body['system'])).toEqual([system, system]);
    expect(providerBodies.map(body => body['cache_control'])).toEqual([sharedBody.cache_control, sharedBody.cache_control]);
    expect(providerBodies.map(body => body['cache_control_metadata'])).toEqual([sharedBody.cache_control_metadata,
      sharedBody.cache_control_metadata]);
    const firstNativeMessages = providerBodies[0]!['messages'] as unknown[];
    const secondNativeMessages = providerBodies[1]!['messages'] as unknown[];
    expect(firstNativeMessages[0]).toEqual(firstMessages[0]);
    expect(secondNativeMessages[0]).toEqual(firstMessages[0]);
    expect(secondNativeMessages[2]).toEqual(secondMessages[2]);
    expect(observation.requests.map(request => ({ authorization: request.authorization, session: request.session,
      customHeader: request.customHeader }))).toEqual([
      { authorization: 'Bearer fixture-native-token', session: sessionId, customHeader: 'native-handoff' },
      { authorization: 'Bearer fixture-native-token', session: sessionId, customHeader: 'native-handoff' },
    ]);
    expect(JSON.parse(binding.handoff!.reviewedTask)).toMatchObject({
      task: { originalTask, requiredConstraints: handoff.requiredConstraints, evidence: handoff.evidence, jobState: handoff.jobState },
      additionalInstructions: ['Retain native response order.'],
    });
  } finally {
    notices?.close();
    await close();
  }
});

it('rejects unsupported handoff versions through native schema parsing', () => {
  const harness = evaluateNative({ active: true });

  expect(() => harness.lwo({ ...makeHandoffInput(), routing_handoff: { ...handoff, version: 2 } }, false)).toThrow();
});

it('stops launch when the spawn hook changes the reviewed agent type', async () => {
  const harness = evaluateNative({ active: true, changeAgentType: true });

  await expect(harness.runLaunch(launchContext())).rejects.toThrow();

  expect(harness.requests.some(request => request['action'] === ROUTING_LAUNCH_ACTION)).toBe(false);
  expect(harness.events).not.toContain('permission-review');
  expect(harness.events.some(event => event.startsWith('child-inference:'))).toBe(false);
});

it('refuses an active teammate before spawn hooks and preserves the native off path', async () => {
  const active = evaluateNative({ active: true });
  const inactive = evaluateNative({ active: false });
  const activeAttempt = active.runLaunch(launchContext(makeHandoffInput(), { teammate: true }));
  const inactiveResult = await inactive.runLaunch(launchContext(makeHandoffInput(), { teammate: true }));

  await expect(activeAttempt).rejects.toThrow();
  expect(active.events).not.toContain('teammate-spawn');
  expect(active.events).not.toContain('spawn-hook');
  expect(inactive.events).toEqual(['teammate-spawn']);
  expect(inactiveResult).toMatchObject({ teammate: true });
});

it('keeps the front prefix stable and preserves native identity, cache, session, and tools', () => {
  const harness = evaluateNative({ active: true });
  const context = { agentContext: {}, tools: [{ name: 'Agent' }, { name: 'Read' }], model: 'router-model' };
  const first = harness.buildRequest(context, [{ role: 'user', content: 'first turn task' }]);
  const second = harness.buildRequest(context, [{ role: 'user', content: 'second turn task' }]);
  const system = first['system'] as Array<{ text?: string; cache_control?: unknown }>;

  expect({ samePrefix: second['system'], nativeBlock: system[0], routerBlock: system[1],
    metadata: first['metadata'], tools: first['tools'] }).toMatchObject({
    samePrefix: system,
    nativeBlock: { text: 'Native OAuth account identity.', cache_control: { type: 'ephemeral', ttl: '1h' } },
    routerBlock: { text: expect.any(String) },
    metadata: { session: 'native-session-identity' },
    tools: [{ name: 'Agent' }],
  });
  expect(system).toHaveLength(2);
  expect(String(system[1]?.text).length).toBeGreaterThan(0);
});

it('keeps bound specialists and routing-off requests on their native system prompt', () => {
  const specialist = evaluateNative({ active: true }).buildRequest({ model: 'router-model', agentContext: {
    agentType: 'subagent', leverframeRoutingBinding: 'opaque-binding', leverframeRoutingPolicyModel: 'router-model',
  } }, null);
  const off = evaluateNative({ active: false }).buildRequest({ model: 'router-model', agentContext: {} }, null);

  expect(specialist['system']).toEqual([{ type: 'text', text: 'Native OAuth account identity.',
    cache_control: { type: 'ephemeral', ttl: '1h' } }]);
  expect(off['system']).toEqual(specialist['system']);
});

it('rejects restored Agent calls while routing is active and preserves them when routing is off', async () => {
  const active = evaluateNative({ active: true });
  const off = evaluateNative({ active: false });

  await expect(active.restoreAgentCall({ agentContext: { agentType: 'subagent',
    leverframeRoutingBinding: 'opaque-binding', leverframeRoutingPolicyModel: 'router-model' } })).rejects.toThrow();
  await expect(off.restoreAgentCall({})).resolves.toBe('restored');
  expect(active.events).not.toContain('restored-native-call');
  expect(off.events).toContain('restored-native-call');
});

it('passes an already aborted signal to neither prepare nor launch control', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const harness = evaluateNative({ active: true, requests });
  const controller = new AbortController();
  controller.abort();

  await expect(harness.runLaunch(launchContext(makeHandoffInput(), { abortController: controller }))).rejects.toThrow();

  expect(requests).toEqual([]);
  expect(harness.events).not.toContain('child-inference:native-specialist-model');
});

it('adds the frozen launch snapshot once before current resumed work', async () => {
  const harness = evaluateNative({ active: true });
  const child = await harness.runResume(resumeContext(), 'retained-child-id');
  const reviewed = preparedPrompt();

  expect(child['promptMessages']).toEqual([
    { role: 'user', content: `${ROUTING_SNAPSHOT_LABEL}${reviewed}` },
    { role: 'user', content: 'The current follow-up' },
  ]);
});

it.each([
  { label: 'original task', content: preparedPrompt() },
  { label: 'saved snapshot', content: `${ROUTING_SNAPSHOT_LABEL}${preparedPrompt()}` },
])('does not duplicate an existing $label in resumed history', async ({ content }) => {
  const harness = evaluateNative({ active: true });
  const existing = { type: 'user', message: { role: 'user', content } };
  const child = await harness.runResume(resumeContext([existing]), 'retained-child-id');

  expect(child['promptMessages']).toEqual([existing, { role: 'user', content: 'The current follow-up' }]);
});

it('does not accept a tool-result row as proof that the saved task appears in history', async () => {
  const harness = evaluateNative({ active: true });
  const toolResult = { type: 'user', toolUseResult: { content: preparedPrompt() },
    message: { role: 'user', content: preparedPrompt() } };
  const child = await harness.runResume(resumeContext([toolResult]), 'retained-child-id');

  expect(child['promptMessages']).toEqual([toolResult,
    { role: 'user', content: `${ROUTING_SNAPSHOT_LABEL}${preparedPrompt()}` },
    { role: 'user', content: 'The current follow-up' }]);
});

it('rejects an interrupted active resume when history lacks the launch snapshot', async () => {
  const harness = evaluateNative({ active: true });

  await expect(harness.runResume(resumeContext([], { E: true }), 'retained-child-id')).rejects.toThrow();
});

it('requires a saved handoff only in active routing and preserves the native unbound resume', async () => {
  const missingHandoff = { modelId: 'native-model-binding', policyModelId: 'native-resume-model', effort: 'low',
    contextWindow: 70_000, maxOutputTokens: 8_000, revision: 1 };
  const active = evaluateNative({ active: true, resumeResponse: missingHandoff });
  const off = evaluateNative({ active: false, resumeResponse: missingHandoff });

  await expect(active.runResume(resumeContext(), 'retained-child-id')).rejects.toThrow();
  const nativeResume = await off.runResume(resumeContext(), 'retained-child-id');

  expect(nativeResume['promptMessages']).toEqual([
    { role: 'assistant', content: 'The current implementation still needs review.' },
    { role: 'user', content: 'The current follow-up' },
  ]);
});
