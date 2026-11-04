import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';
import { expect, it } from 'vitest';
import { ROUTING_CONTROL_BODY_LIMIT, ROUTING_HANDOFF_LIMIT, ROUTING_LAUNCH_ACTION, ROUTING_PREPARE_ACTION,
  ROUTING_PROMPT_POLICY_LIMIT } from '../src/constants.js';
import { buildRoutingCatalog, projectRoutingPromptPolicy, type RoutingConfig } from '../src/model-routing.js';
import { getAppHome } from '../src/paths.js';
import { startHttpProxy } from '../src/http-proxy/server.js';
import { resolveRoutingBinding, routingBindingStatePath } from '../src/routing-bindings.js';
import type { SelectorPayload } from '../src/routing-selector.js';
import type { RoutingControlContext } from '../src/proxy-routing-control.js';
import { input, observation, provider } from './model-routing-fixtures.js';

const outerHome = process.env['LEVERFRAME_TEST_HOME'];
const proxyToken = 'fixture-handoff-control-token';
const target = { providerId: 'fixture-handoff-control-provider', modelId: 'fixture-handoff-control-model' };
const fetchedAt = '2026-10-01T00:00:00.000Z';

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function makeControlContext(events: string[], options: { enabled?: boolean; recoveryOnly?: boolean } = {}): RoutingControlContext {
  const registeredProvider = provider({
    id: target.providerId,
    templateId: 'fixture',
    modelsCache: {
      fetchedAt,
      source: 'account',
      models: [{ id: target.modelId, name: target.modelId, upstreamModelId: 'fixture-handoff-upstream-model',
        modelFormat: 'anthropic', contextWindow: 70_000, outputTokenLimit: 8_192, supportedReasoningEfforts: ['low'],
        pricing: { input: 2, output: 8, source: 'fixture-pricing', observedAt: fetchedAt } }],
    },
  });
  const catalog = buildRoutingCatalog(input([registeredProvider], {
    credentials: [observation(registeredProvider.id)],
    discovery: [{ providerId: registeredProvider.id, status: 'live', cacheFetchedAt: fetchedAt }],
  }));
  const config: RoutingConfig = {
    enabled: options.enabled ?? true,
    cheapFallback: target,
    pool: [target],
    defaultCategory: 'review',
    agentCategories: { reviewer: 'review' },
    categories: {
      review: { target, effort: 'low', instructions: 'Check the requested behavior and its edge cases.',
        alternatingTargets: [{ ...target, effort: 'low' }, { ...target, effort: 'low' }] },
      implementation: { target, effort: 'low', instructions: 'Preserve the accepted implementation constraints.' },
    },
    selector: { enabled: true, target, maxExtraCallsPerTask: 1, timeoutMs: 100, maxOutputTokens: 300 },
  };
  return {
    proxyToken,
    config,
    catalog,
    workload: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
    ...(options.recoveryOnly ? { recoveryOnly: true as const } : {}),
    selectorTransport: async (_target: typeof target, _payload: SelectorPayload, _signal: AbortSignal) => {
      events.push('selector-call');
      throw new Error('Selector calls are disabled in this fixture.');
    },
  };
}

async function startControlServer(context: RoutingControlContext) {
  const { proxyToken: _proxyToken, ...routing } = context;
  const proxy = await startHttpProxy({ routes: [], routing, proxyAuthToken: proxyToken });
  return { proxy, origin: `http://${proxy.host}:${proxy.port}` };
}

function prepareBody(context: RoutingControlContext, sessionId: string) {
  return {
    action: ROUTING_PREPARE_ACTION,
    version: 1,
    policy: projectRoutingPromptPolicy(context.config),
    agentType: 'reviewer',
    category: 'review',
    delegatedTask: 'Inspect the changed parser behavior.',
    originalTask: 'Keep parser response order stable while routing changes.',
    requiredConstraints: ['Keep response order unchanged.', 'Preserve the native provider identity.'],
    toolInstructions: ['Read the parser implementation.', 'Do not edit generated files.'],
    evidence: [{ source: 'tool-result', content: 'The parser currently preserves source order.' }],
    jobState: 'The first review found one unresolved compatibility case.',
    sessionId,
    launchId: 'fixture-handoff-launch',
    role: 'specialist',
    task: 'Legacy launch task that must not replace the prepared handoff.',
    selectorEvidence: {
      features: { size: 'small', turns: 'few', tools: 'few', recentFailures: 0 },
      workload: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
      selectorWorkload: { input: 100, output: 30, cacheRead: 0, cacheWrite: 0 },
    },
  };
}

function launchBody(context: RoutingControlContext, sessionId: string, launchId: string, originalPrompt: string,
  reviewedTask: string, selectorEvidence?: unknown, category = 'review') {
  const input = prepareBody(context, sessionId);
  return {
    action: ROUTING_LAUNCH_ACTION,
    policy: projectRoutingPromptPolicy(context.config),
    sessionId,
    launchId,
    role: 'specialist',
    agentType: input.agentType,
    category,
    effort: 'low',
    task: reviewedTask,
    resume: false,
    originalPrompt,
    delegatedTask: input.delegatedTask,
    handoff: { version: 1, originalTask: input.originalTask, requiredConstraints: input.requiredConstraints,
      toolInstructions: input.toolInstructions, evidence: input.evidence, jobState: input.jobState },
    ...(selectorEvidence === undefined ? {} : { selectorEvidence }),
  };
}

function reorderedHookPrompt(prompt: string, additionalInstructions: string[]): string {
  const envelope = JSON.parse(prompt) as Record<string, unknown>;
  return JSON.stringify({ additionalInstructions, task: envelope['task'], prefix: envelope['prefix'],
    agentType: envelope['agentType'], version: envelope['version'] });
}

function changedOriginalTask(prompt: string): string {
  const envelope = JSON.parse(prompt) as Record<string, unknown>;
  const task = envelope['task'] as Record<string, unknown>;
  return JSON.stringify({ ...envelope, task: { ...task, originalTask: 'Change the accepted task.' } });
}

async function postControl(origin: string, body: Record<string, unknown>) {
  const response = await fetch(`${origin}/v1/leverframe/routing-launch`, {
    method: 'POST',
    headers: { authorization: `Bearer ${proxyToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function assertFixturePaths(sessionId: string, certificatePath?: string): string {
  expect(outerHome).toBeTruthy();
  expect(inside(outerHome!, getAppHome())).toBe(true);
  const statePath = routingBindingStatePath(sessionId);
  expect(inside(outerHome!, dirname(statePath))).toBe(true);
  if (certificatePath) expect(inside(outerHome!, certificatePath)).toBe(true);
  return statePath;
}

it('prepares a reviewed handoff through authenticated control without binding or selector side effects', async () => {
  const events: string[] = [];
  const context = makeControlContext(events);
  const sessionId = randomUUID();
  const statePath = assertFixturePaths(sessionId);
  const { proxy, origin } = await startControlServer(context);

  try {
    assertFixturePaths(sessionId, proxy.caCertPath);
    expect(existsSync(statePath)).toBe(false);
    const result = await postControl(origin, prepareBody(context, sessionId));
    const prompt = result.body['prompt'];
    const envelope = typeof prompt === 'string' ? JSON.parse(prompt) as Record<string, unknown> : undefined;

    expect({ status: result.status, envelope, provenance: result.body['provenance'], selectorCalls: events,
      bindingExists: existsSync(statePath) }).toMatchObject({
      status: 200,
      envelope: {
        agentType: 'reviewer',
        prefix: { role: 'specialist', category: 'review', tools: ['Read the parser implementation.', 'Do not edit generated files.'] },
        task: {
          delegatedTask: 'Inspect the changed parser behavior.',
          originalTask: 'Keep parser response order stable while routing changes.',
          jobState: 'The first review found one unresolved compatibility case.',
        },
      },
      provenance: 'explicit',
      selectorCalls: [],
      bindingExists: false,
    });
  } finally {
    await proxy.close();
  }
});

it('accepts a valid prepare body above the former request cap while preserving the selected handoff', async () => {
  const events: string[] = [];
  const context = makeControlContext(events);
  const sessionId = randomUUID();
  const statePath = assertFixturePaths(sessionId);
  const unselectedInstruction = 'x'.repeat(ROUTING_PROMPT_POLICY_LIMIT - 1_024);
  context.config.categories!['unused_capacity_fixture'] = { target, effort: 'low', instructions: unselectedInstruction };
  const body = prepareBody(context, sessionId);
  const bodyBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  const projectedPolicy = JSON.stringify(projectRoutingPromptPolicy(context.config));
  const { proxy, origin } = await startControlServer(context);

  try {
    expect(bodyBytes).toBeGreaterThan(ROUTING_PROMPT_POLICY_LIMIT);
    expect(bodyBytes).toBeLessThan(ROUTING_CONTROL_BODY_LIMIT);
    expect(Buffer.byteLength(projectedPolicy, 'utf8')).toBeLessThan(ROUTING_PROMPT_POLICY_LIMIT);
    const result = await postControl(origin, body);
    const prompt = typeof result.body['prompt'] === 'string' ? String(result.body['prompt']) : '';

    expect({ status: result.status, selectedInstructionIncluded: prompt.includes('Check the requested behavior and its edge cases.'),
      unselectedInstructionIncluded: prompt.includes(unselectedInstruction), selectorCalls: events,
      bindingExists: existsSync(statePath), promptBytes: Buffer.byteLength(prompt, 'utf8') }).toMatchObject({
      status: 200,
      selectedInstructionIncluded: true,
      unselectedInstructionIncluded: false,
      selectorCalls: [],
      bindingExists: false,
    });
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(ROUTING_HANDOFF_LIMIT);
  } finally {
    await proxy.close();
  }
});

it('rejects an oversized projected category policy before preparing a handoff', async () => {
  const events: string[] = [];
  const context = makeControlContext(events);
  const sessionId = randomUUID();
  const statePath = assertFixturePaths(sessionId);
  const oversizedInstruction = 'x'.repeat(ROUTING_PROMPT_POLICY_LIMIT + 1);
  const validBody = prepareBody(context, sessionId);
  context.config.categories!['unused_capacity_fixture'] = { target, effort: 'low', instructions: oversizedInstruction };
  const body = { ...validBody, policy: { ...validBody.policy,
    categoryInstructions: { ...validBody.policy.categoryInstructions, unused_capacity_fixture: oversizedInstruction } } };
  const bodyBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  const { proxy, origin } = await startControlServer(context);

  try {
    expect(bodyBytes).toBeLessThan(ROUTING_CONTROL_BODY_LIMIT);
    const result = await postControl(origin, body);

    expect({ status: result.status, hasPrompt: typeof result.body['prompt'] === 'string', selectorCalls: events,
      bindingExists: existsSync(statePath) }).toEqual({ status: 400, hasPrompt: false, selectorCalls: [], bindingExists: false });
  } finally {
    await proxy.close();
  }
});

it('accepts a reordered hook review with added instructions and stores the exact reviewed handoff', async () => {
  const events: string[] = [];
  const context = makeControlContext(events);
  const targetModel = context.catalog.models.find(model => model.ref.providerId === target.providerId
    && model.ref.modelId === target.modelId)!;
  targetModel.capabilities.tools = true;
  targetModel.confirmedCapabilities.push('tools');
  const sessionId = randomUUID();
  const statePath = assertFixturePaths(sessionId);
  const launchId = randomUUID();
  const { proxy, origin } = await startControlServer(context);

  try {
    const preparation = await postControl(origin, prepareBody(context, sessionId));
    const originalPrompt = String(preparation.body['prompt']);
    const reviewedTask = reorderedHookPrompt(originalPrompt, ['Keep the native response order.']);
    const launch = await postControl(origin, launchBody(context, sessionId, launchId, originalPrompt, reviewedTask));

    expect({ prepareStatus: preparation.status, launchStatus: launch.status,
      hasBindingId: typeof launch.body['modelId'] === 'string', selectorCalls: events,
      bindingExists: existsSync(statePath) }).toEqual({
      prepareStatus: 200,
      launchStatus: 200,
      hasBindingId: true,
      selectorCalls: [],
      bindingExists: true,
    });
    const binding = await resolveRoutingBinding({ sessionId, modelId: String(launch.body['modelId']) });

    expect({ category: binding.category, savedHandoff: (binding as unknown as { handoff?: unknown }).handoff }).toMatchObject({
      category: 'review',
      savedHandoff: { version: 1, agentType: 'reviewer', reviewedTask, provenance: 'explicit' },
    });
  } finally {
    await proxy.close();
  }
});

it.each([
  { label: 'pre-hook envelope', change: (context: RoutingControlContext, session: string, launchId: string,
    original: string, reviewed: string, selector: unknown) => launchBody(context, session, launchId,
    changedOriginalTask(original), reviewed, selector) },
  { label: 'hook-reviewed task', change: (context: RoutingControlContext, session: string, launchId: string,
    original: string, reviewed: string, selector: unknown) => launchBody(context, session, launchId,
    original, changedOriginalTask(reviewed), selector) },
  { label: 'resolved category', change: (context: RoutingControlContext, session: string, launchId: string,
    original: string, reviewed: string, selector: unknown) => launchBody(context, session, launchId,
    original, reviewed, selector, 'implementation') },
  { label: 'captured policy', change: (context: RoutingControlContext, session: string, launchId: string,
    original: string, reviewed: string, selector: unknown) => ({
    ...launchBody(context, session, launchId, original, reviewed, selector),
    policy: { ...projectRoutingPromptPolicy(context.config), defaultCategory: 'implementation' },
  }) },
])('rejects a launch with a tampered $label before binding or selector calls', async ({ change }) => {
  const events: string[] = [];
  const context = makeControlContext(events);
  const sessionId = randomUUID();
  const statePath = assertFixturePaths(sessionId);
  const launchId = randomUUID();
  const { proxy, origin } = await startControlServer(context);

  try {
    const preparation = await postControl(origin, prepareBody(context, sessionId));
    const originalPrompt = String(preparation.body['prompt']);
    const selectorEvidence = prepareBody(context, sessionId).selectorEvidence;
    const launch = await postControl(origin, change(context, sessionId, launchId, originalPrompt, originalPrompt, selectorEvidence));

    expect({ status: launch.status, hasBinding: typeof launch.body['modelId'] === 'string', selectorCalls: events,
      bindingExists: existsSync(statePath) }).toEqual({ status: 400, hasBinding: false, selectorCalls: [], bindingExists: false });
  } finally {
    await proxy.close();
  }
});

it('rejects a stale policy before preparing or binding the task', async () => {
  const events: string[] = [];
  const context = makeControlContext(events);
  const sessionId = randomUUID();
  const statePath = assertFixturePaths(sessionId);
  const { proxy, origin } = await startControlServer(context);

  try {
    const body = { ...prepareBody(context, sessionId), policy: { ...projectRoutingPromptPolicy(context.config), defaultCategory: 'implementation' } };
    const result = await postControl(origin, body);

    expect({ status: result.status, hasPrompt: typeof result.body['prompt'] === 'string', selectorCalls: events,
      bindingExists: existsSync(statePath) }).toEqual({ status: 400, hasPrompt: false, selectorCalls: [], bindingExists: false });
  } finally {
    await proxy.close();
  }
});

it('rejects malformed handoff fields with a validation error instead of a runtime TypeError', async () => {
  const events: string[] = [];
  const context = makeControlContext(events);
  const sessionId = randomUUID();
  const statePath = assertFixturePaths(sessionId);
  const { proxy, origin } = await startControlServer(context);

  try {
    const result = await postControl(origin, { ...prepareBody(context, sessionId), delegatedTask: 7 });
    const error = result.body['error'] as { message?: string } | undefined;

    const message = error?.message ?? '';
    expect({ status: result.status, meaningfulError: message.length > 0 && !/is not a function|Cannot read properties/.test(message),
      selectorCalls: events, bindingExists: existsSync(statePath) }).toEqual({ status: 400,
      meaningfulError: true, selectorCalls: [], bindingExists: false });
  } finally {
    await proxy.close();
  }
});

it.each([
  { label: 'disabled routing', enabled: false, recoveryOnly: false },
  { label: 'recovery-only routing', enabled: true, recoveryOnly: true },
])('rejects prepare for $label before creating a binding', async ({ enabled, recoveryOnly }) => {
  const events: string[] = [];
  const context = makeControlContext(events, { enabled, recoveryOnly });
  const sessionId = randomUUID();
  const statePath = assertFixturePaths(sessionId);
  const { proxy, origin } = await startControlServer(context);

  try {
    const result = await postControl(origin, prepareBody(context, sessionId));

    expect({ status: result.status, hasPrompt: typeof result.body['prompt'] === 'string', selectorCalls: events,
      bindingExists: existsSync(statePath) }).toEqual({ status: 400, hasPrompt: false, selectorCalls: [], bindingExists: false });
  } finally {
    await proxy.close();
  }
});

it('rejects an unknown control action instead of creating a legacy binding', async () => {
  const events: string[] = [];
  const context = makeControlContext(events);
  const sessionId = randomUUID();
  const statePath = assertFixturePaths(sessionId);
  const { proxy, origin } = await startControlServer(context);

  try {
    const result = await postControl(origin, { ...prepareBody(context, sessionId), action: 'unsupported' });

    expect({ status: result.status, hasPrompt: typeof result.body['prompt'] === 'string', selectorCalls: events,
      bindingExists: existsSync(statePath) }).toEqual({ status: 400, hasPrompt: false, selectorCalls: [], bindingExists: false });
  } finally {
    await proxy.close();
  }
});
