import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { applyModelRoutingTransform } from '../src/patch-transforms-model-routing.js';
import { applyRoutingPatchComposition } from '../src/patch-transforms-routing-composition.js';
import { applyLeverframePatches } from '../src/patch-transforms.js';
import { ROUTING_CONTROL_ERROR_READER } from '../src/patch-transforms-control-error.js';
import { ROUTING_ACTIVE_ENV, ROUTING_ACTIVE_VALUE, ROUTING_LAUNCH_ACTION, ROUTING_PREPARE_ACTION } from '../src/constants.js';
import { prepareRoutingHandoff } from '../src/model-routing.js';
import { CLAUDE_MODULE_BOUNDARY, splitModulePayload } from '../src/claude-bundle-native.js';
import {
  claudeAgentRoutingHandoffSource,
  ROUTING_TEST_PROMPT_POLICY,
  routingHandoffSchemaGlobals,
} from './fixtures/claude-agent-2.1.314-routing.js';
import { claudeAgentRoutingNoticeCompositionSource } from './fixtures/claude-agent-2.1.314-routing-composition.js';

const proxyToken = 'fixture-proxy-token';
const controlOrigin = 'http://127.0.0.1:43123';
const supportedHarnessSource = claudeAgentRoutingHandoffSource();
const supportedCompositionSource = claudeAgentRoutingNoticeCompositionSource();
const composedHarnessModuleNames = new Set([
  '/$bunfs/root/chunk-3pr91mb5.js',
  '/$bunfs/root/chunk-pwf6g3a4.js',
  '/$bunfs/root/chunk-430w8txz.js',
  '/$bunfs/root/chunk-sq7yspzm.js',
  '/$bunfs/root/chunk-bqbyxpv1.js',
  '/$bunfs/root/chunk-a0eq9prc.js',
  '/$bunfs/root/chunk-z2g9tcvz.js',
]);
const routerTransformOptions = { enabled: true, visibleModelId: 'auto', policyModelId: 'concrete-router', promptPolicy: ROUTING_TEST_PROMPT_POLICY };
const launchHandoff = { version: 1, originalTask: 'Review the accepted task', requiredConstraints: [], toolInstructions: [], evidence: [], jobState: '' };
const launchAgentInput = { description: 'Review launch', prompt: launchHandoff.originalTask, subagent_type: 'reviewer',
  routing_category: 'review', routing_handoff: launchHandoff };

interface MockControlRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface ChildRunner {
  model: string;
  routingBinding: string;
  effort: string;
  toolUseContext: Record<string, unknown>;
  promptMessages: Array<{ role: string; content: string }>;
  systemPromptModel: string;
  noticeModel: string;
  launchId: string;
  agentDefinition: Record<string, unknown>;
}

interface ChildMetadataObservation {
  model?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportedReasoningEfforts?: string[];
}

interface TargetMetadata {
  contextWindow: number | undefined;
  maxOutputTokens: number | undefined;
  supportedReasoningEfforts: string[] | undefined;
}

function runPatchedHarness(response: Record<string, unknown>, requests: MockControlRequest[], events: string[] = [],
  targetMetadata?: Record<string, TargetMetadata>, childMetadata: { observed?: ChildMetadataObservation } = {},
  inferenceRequests: ConcreteRequest[] = [],
  controlHttpResponse?: { ok: boolean; status: number; body: Record<string, unknown> }) {
  const source = targetMetadata ? supportedCompositionSource : supportedHarnessSource;
  const patched = targetMetadata ? applyRoutingPatchComposition(source, 'auto', {
    routingEnabled: true,
    routingPolicyModelId: routerTransformOptions.policyModelId,
    routingPromptPolicy: routerTransformOptions.promptPolicy,
    routingMetadata: { contextWindow: 85_000, maxOutputTokens: 12_000, supportedReasoningEfforts: ['low', 'medium'] },
    routingTargetMetadata: targetMetadata,
  }) : applyModelRoutingTransform(source, routerTransformOptions);
  expect(patched.content).not.toBe(source);
  expect(patched.results.some(result => result.status === 'FAIL')).toBe(false);
  const moduleStart = targetMetadata ? patched.content.indexOf(CLAUDE_MODULE_BOUNDARY) : -1;
  const modules = moduleStart < 0 ? undefined : splitModulePayload(patched.content.slice(moduleStart));
  const selectedModules = modules?.filter(([name]) => composedHarnessModuleNames.has(name));
  if (targetMetadata) {
    expect(moduleStart).toBeGreaterThanOrEqual(0);
    expect(selectedModules?.length).toBeGreaterThan(0);
  }
  const executableSource = targetMetadata ? selectedModules!.map(([, content]) => content).join('\n') : patched.content;
  const executable = executableSource.replace(/import\{[^}]+\}from"[^"]+";/g, '')
    .replace(/export\{[^}]+\};/g, '');
  let metadataHelpers: Pick<typeof mainHelpers, 'yUe' | 'dn' | 'DZr'> | undefined;
  const nativeCatalog = { 'concrete-router': { id: 'concrete-router', context_window: 85_000,
    runtime: { max_input_tokens: 85_000, max_output_tokens: 12_000, effort_levels: ['low', 'medium'] } } };
  const runners = runInNewContext(executable + ';({runLaunch,runResume,runAndSend,yUe,dn,DZr})', {
    process: { env: {
      [ROUTING_ACTIVE_ENV]: ROUTING_ACTIVE_VALUE,
      LEVERFRAME_CONTEXT_SELECTION_BASE_URL: controlOrigin,
      LEVERFRAME_CONTEXT_SELECTION_TOKEN: proxyToken,
    } },
    URL,
    ...routingHandoffSchemaGlobals(),
    AbortSignal,
    Buffer,
    TextDecoder,
    s8t: (value: unknown) => value,
    gt: {},
    D0: nativeCatalog,
    a6e: () => ({ user_id: 'fixture-session-metadata' }),
    Die: () => [],
    __lfSession: () => 'session-from-harness',
    lS: () => { events.push('child-id'); return 'launch-from-child'; },
    iAe: (agent: { model: string }) => agent.model,
    jn: (model: string) => model,
    fc: () => 'parent-model',
    XAo: async ({ prompt }: { prompt: string }) => ({ agent: { agentType: 'reviewer', model: 'native-child-model' },
      spawn: { prompt, description: 'Review launch', background: undefined } }),
    Gt: (agent: Record<string, unknown>, update: Record<string, unknown>) => ({ ...agent, ...update }),
    Bn: async () => ({}),
    fEi: (messages: unknown[]) => ({ copies: messages }),
    gqs: () => ({}),
    Oe: ({ content }: { content: unknown }) => ({ role: 'user', content }),
    U: undefined,
    _t: undefined,
    Hn: async () => undefined,
    Rrn: {},
    oX: () => false,
    UH: () => false,
    spawnTeammate: () => undefined,
    AVe: () => false,
    Nce: () => ({ onToolPool: undefined, reviewTools: [] }),
    jG: (_definition: unknown, _parent: string, model: string) => {
      events.push(`resolve:${model}`);
      return model;
    },
    ffn: async (_prompt: unknown, model: string) => {
      if (metadataHelpers) {
        const childRuntime = metadataHelpers.dn(model);
        childMetadata.observed = {
          model,
          contextWindow: metadataHelpers.yUe(model)?.context_window as number | undefined,
          maxOutputTokens: childRuntime?.max_output_tokens as number | undefined,
          supportedReasoningEfforts: metadataHelpers.DZr(model),
        };
        events.push(`child-metadata:${model}`);
      }
      events.push('ffn');
      events.push(`ffn-model:${model}`);
      return `system:${model}`;
    },
    Xy: (_catalog: unknown, models: string[]) => nativeCatalog[models[0] as keyof typeof nativeCatalog],
    ln: () => nativeCatalog,
    __lfModelMeta: (model: string) => metadataHelpers?.yUe(model),
    EKs: (_definition: unknown, _parent: string, model: string) => model,
    FWr: (context: { agentContext?: Record<string, unknown> }) => ({ agentContext: { ...context.agentContext } }),
    LT: (model: string) => model,
    send: (request: ConcreteRequest) => { inferenceRequests.push(request); events.push('send'); return request; },
    fetch: async (url: URL, init: MockControlRequest) => {
      const request = { url: new URL(url.href), method: init.method, headers: init.headers, body: init.body };
      const payload = JSON.parse(init.body) as Record<string, unknown>;
      requests.push(request);
      events.push(payload['action'] === ROUTING_PREPARE_ACTION ? 'prepare-control' : 'launch-control');
      if (payload['action'] === ROUTING_PREPARE_ACTION && controlHttpResponse === undefined) {
        const prepared = prepareRoutingHandoff({ policy: ROUTING_TEST_PROMPT_POLICY, agentType: 'reviewer', explicitCategory: 'review',
          delegatedTask: launchHandoff.originalTask, ...launchHandoff });
        const body = { prompt: JSON.stringify(prepared.envelope), provenance: prepared.provenance };
        const bytes = new TextEncoder().encode(JSON.stringify(body));
        let read = false;
        const stream = { getReader: () => ({ read: async () => read ? { done: true as const, value: undefined }
          : (read = true, { done: false as const, value: bytes }), cancel: async () => undefined }) };
        return { ok: true, status: 200, json: async () => body, body: stream };
      }
      const defaultBody = payload['resume'] === true
        ? { ...response, handoff: response['handoff'] ?? { version: 1, agentType: 'reviewer', reviewedTask: JSON.stringify(
          prepareRoutingHandoff({ policy: ROUTING_TEST_PROMPT_POLICY, agentType: 'reviewer', explicitCategory: 'review',
            delegatedTask: launchHandoff.originalTask, ...launchHandoff }).envelope) } }
        : response;
      const reply = controlHttpResponse ?? { ok: true, status: 200, body: defaultBody };
      const bytes = new TextEncoder().encode(JSON.stringify(reply.body));
      let read = false;
      const body = { getReader: () => ({ read: async () => {
        if (read) return { done: true as const, value: undefined };
        read = true;
        return { done: false as const, value: bytes };
      }, cancel: async () => undefined }) };
      return { ok: reply.ok, status: reply.status, json: async () => reply.body, body };
    },
  }) as {
    runLaunch: (context: Record<string, unknown>) => Promise<ChildRunner>;
    runResume: (context: Record<string, unknown>, agentId: string) => Promise<ChildRunner>;
    runAndSend: (input: Record<string, unknown>) => Promise<ConcreteRequest>;
    yUe: (model: string) => Record<string, unknown> | undefined;
    dn: (model: string) => Record<string, unknown> | undefined;
    DZr: (model: string) => string[] | undefined;
  };
  const mainHelpers = runners;
  metadataHelpers = targetMetadata ? mainHelpers : undefined;
  return { ...runners,
    runLaunch: (context: Record<string, unknown>) => runners.runLaunch({ ...context, messages: context['messages'] ?? [], abortController: new AbortController(),
      agentInput: context['agentInput'] ?? launchAgentInput }),
    runResume: (context: Record<string, unknown>, agentId: string) => runners.runResume({ ...context, messages: context['messages'] ?? [],
      abortController: new AbortController() }, agentId),
  };
}

it('binds the launched child model before runner creation and preserves its prompt context', async () => {
  const requests: MockControlRequest[] = [];
  const events: string[] = [];
  const responseBinding = { modelId: 'opaque-launch-binding', policyModelId: 'concrete-reviewer-model', effort: 'low',
    contextWindow: 70_000, maxOutputTokens: 12_000, revision: 1 };
  const runners = runPatchedHarness(responseBinding, requests, events);
  const context = { options: { tools: [] }, metadata: { session: 'parent-context' } };

  const child = await runners.runLaunch(context);

  expect(requests).toHaveLength(2);
  expect(events).toEqual([
    'prepare-control',
    'child-id',
    'launch-control',
    `resolve:${responseBinding.policyModelId}`,
    'ffn',
    `ffn-model:${responseBinding.policyModelId}`,
  ]);
  expect(requests[0]?.url.origin).toBe(controlOrigin);
  expect(requests[0]?.url.pathname).toBe('/v1/leverframe/routing-launch');
  expect(requests[0]?.method).toBe('POST');
  expect(requests[0]?.headers).toMatchObject({ Authorization: `Bearer ${proxyToken}` });
  expect(JSON.parse(requests[0]!.body)).toMatchObject({ action: ROUTING_PREPARE_ACTION, agentType: 'reviewer' });
  const launch = JSON.parse(requests[1]!.body) as Record<string, unknown>;
  expect(launch).toMatchObject({
    action: ROUTING_LAUNCH_ACTION,
    sessionId: 'session-from-harness',
    launchId: 'launch-from-child',
    role: 'specialist',
    agentType: 'reviewer',
    resume: false,
  });
  expect(JSON.parse(String(launch['task'])).task.originalTask).toBe('Review the accepted task');
  expect(child).toMatchObject({
    model: responseBinding.policyModelId,
    routingBinding: responseBinding.modelId,
    effort: responseBinding.effort,
    systemPromptModel: responseBinding.policyModelId,
    noticeModel: responseBinding.policyModelId,
    launchId: 'launch-from-child',
    toolUseContext: context,
  });
  expect(child.promptMessages).toEqual([{ role: 'user', content: launch['task'] }]);
});

it('uses specialist host metadata during child prompt preparation and keeps the binding on the outbound request', async () => {
  const specialistModel = 'claude-external-specialist-model';
  const hiddenBinding = 'opaque-external-specialist-binding';
  const targetMetadata = { [specialistModel]: {
    contextWindow: 38_000,
    maxOutputTokens: 3_200,
    supportedReasoningEfforts: ['low'],
  } };
  const responseBinding = { modelId: hiddenBinding, policyModelId: specialistModel, effort: 'low',
    contextWindow: 38_000, maxOutputTokens: 3_200, revision: 1 };
  const requests: MockControlRequest[] = [];
  const events: string[] = [];
  const childMetadata: { observed?: ChildMetadataObservation } = {};
  const inferenceRequests: ConcreteRequest[] = [];
  const runners = runPatchedHarness(responseBinding, requests, events, targetMetadata, childMetadata, inferenceRequests);
  const context = { options: { tools: [] }, metadata: { session: 'parent-context' } };
  const child = await runners.runLaunch(context);
  const inference = await runners.runAndSend({ ...child,
    toolUseContext: { agentContext: { agentType: 'subagent', session: 'specialist-session',
      leverframeRoutingBinding: hiddenBinding, leverframeRoutingPolicyModel: specialistModel }, contextWindow: 38_000 },
    session: 'specialist-session', spawnMode: 'spawn' });

  expect(child).toMatchObject({ model: specialistModel, routingBinding: hiddenBinding, effort: 'low' });
  expect(childMetadata.observed).toEqual({ model: specialistModel, contextWindow: 38_000, maxOutputTokens: 3_200,
    supportedReasoningEfforts: ['low'] });
  expect(events.indexOf(`child-metadata:${specialistModel}`)).toBeLessThan(events.indexOf('send'));
  expect(inferenceRequests).toHaveLength(1);
  expect(inference.model).toBe(hiddenBinding);
  expect(inference.agentContext).toMatchObject({
    leverframeRoutingBinding: hiddenBinding,
    leverframeRoutingPolicyModel: specialistModel,
  });
});

it.each([
  { label: 'context window', response: { modelId: 'opaque-incomplete-context-binding',
    policyModelId: 'leverframe:fixture-provider:incomplete-context', maxOutputTokens: 3_200, supportedReasoningEfforts: ['low'] } },
  { label: 'output limit', response: { modelId: 'opaque-incomplete-output-binding',
    policyModelId: 'leverframe:fixture-provider:incomplete-output', contextWindow: 38_000, supportedReasoningEfforts: ['low'] } },
])('does not prepare a specialist child when authenticated control lacks its confirmed $label', async ({ response }) => {
  const requests: MockControlRequest[] = [];
  const events: string[] = [];
  const runners = runPatchedHarness({ ...response, effort: 'low', revision: 1 }, requests, events);

  await expect(runners.runLaunch({ options: { tools: [] }, metadata: { session: 'parent-context' } }))
    .rejects.toMatchObject({ message: expect.any(String) });

  expect(requests).toHaveLength(2);
  expect(requests[0]?.headers).toMatchObject({ Authorization: `Bearer ${proxyToken}` });
  expect(events).not.toContain('ffn');
  expect(events).not.toContain(`ffn-model:${response.policyModelId}`);
});

it('surfaces bounded recovery guidance from control errors before model resolution or prompt preparation', async () => {
  const requests: MockControlRequest[] = [];
  const events: string[] = [];
  const longMessage = `Review routing preferences and recover this saved job. ${'fixture detail '.repeat(120)} private-prompt-tail`;
  const runners = runPatchedHarness({}, requests, events, undefined, {}, [], {
    ok: false,
    status: 400,
    body: { error: { code: 'routing_recovery_required', message: longMessage },
      privatePrompt: 'private-prompt-field', credential: 'private-credential-field' },
  });

  const failure = await runners.runLaunch({ options: { tools: [] }, metadata: { session: 'parent-context' } })
    .then(() => '', error => String(error));

  expect(failure).toContain('routing_recovery_required');
  expect(failure).toMatch(/routing preferences/i);
  expect(failure).toMatch(/recover/i);
  expect(failure.length).toBeLessThan(longMessage.length);
  expect(failure).not.toContain('private-prompt-tail');
  expect(failure).not.toContain('private-prompt-field');
  expect(failure).not.toContain('private-credential-field');
  expect(events).not.toContain('ffn');
  expect(events).not.toContain('resolve:undefined');
});

const nativeChildPreparationCases = [
  { label: 'launch', expectedControls: 2, invoke: (runners: ReturnType<typeof runPatchedHarness>, context: Record<string, unknown>) => runners.runLaunch(context) },
  { label: 'resume', expectedControls: 1, invoke: (runners: ReturnType<typeof runPatchedHarness>, context: Record<string, unknown>) => runners.runResume(context, 'retained-child-id') },
];

it.each(nativeChildPreparationCases)('blocks native child $label when host and native catalogs lack bounds', async ({ invoke, expectedControls }) => {
  const requests: MockControlRequest[] = [];
  const events: string[] = [];
  const inferenceRequests: ConcreteRequest[] = [];
  const responseBinding = { modelId: 'opaque-native-child-binding', policyModelId: 'claude-native-specialist',
    effort: 'low', revision: 1 };
  const runners = runPatchedHarness(responseBinding, requests, events, {}, {}, inferenceRequests);

  await expect(invoke(runners, { options: { tools: [] }, metadata: { session: 'parent-context' } }))
    .rejects.toMatchObject({ message: expect.any(String) });

  expect(requests).toHaveLength(expectedControls);
  expect(events).not.toContain('ffn');
  expect(inferenceRequests).toHaveLength(0);
});

it('restores the bound model for a resumed child with its retained identity and session', async () => {
  const requests: MockControlRequest[] = [];
  const events: string[] = [];
  const responseBinding = { modelId: 'opaque-resume-binding', policyModelId: 'concrete-resume-model', effort: 'high',
    contextWindow: 80_000, maxOutputTokens: 14_000, revision: 2 };
  const runners = runPatchedHarness(responseBinding, requests, events);
  const context = { options: { tools: [] }, metadata: { session: 'resumed-parent-context' } };

  const child = await runners.runResume(context, 'retained-child-id');

  expect(requests).toHaveLength(1);
  expect(events).toEqual([
    'launch-control',
    `resolve:${responseBinding.policyModelId}`,
    'ffn',
    `ffn-model:${responseBinding.policyModelId}`,
  ]);
  expect(JSON.parse(requests[0]!.body)).toMatchObject({
    sessionId: 'session-from-harness',
    launchId: 'retained-child-id',
    role: 'specialist',
    agentType: 'reviewer',
    task: 'Resume the accepted task',
    resume: true,
  });
  expect(child).toMatchObject({
    model: responseBinding.policyModelId,
    routingBinding: responseBinding.modelId,
    effort: responseBinding.effort,
    toolUseContext: context,
  });
});

it('keeps routing-off harness source unchanged', () => {
  const result = applyModelRoutingTransform(supportedHarnessSource, { enabled: false });

  expect(result.content).toBe(supportedHarnessSource);
});

it('retains the last patch when the source layout cannot be routed', () => {
  const previouslyPatched = applyModelRoutingTransform(supportedHarnessSource, routerTransformOptions);
  const nextModule = '\n//#__leverframe_claude_module__:/$bunfs/root/chunk-pwf6g3a4.js';
  const unsupported = previouslyPatched.content.slice(0, previouslyPatched.content.indexOf(nextModule));

  const result = applyModelRoutingTransform(unsupported, routerTransformOptions);

  expect(result.content).toBe(unsupported);
  expect(result.results[0]?.status).not.toBe(previouslyPatched.results[0]?.status);
});

function removeModuleReader(source: string, moduleName: string): string {
  const boundary = '\n//#__leverframe_claude_module__:';
  const moduleBoundary = `${boundary}${moduleName}\n`;
  const start = source.indexOf(moduleBoundary);
  const end = source.indexOf(boundary, start + moduleBoundary.length);
  const module = source.slice(start, end < 0 ? undefined : end);
  const withoutReader = module.replace(ROUTING_CONTROL_ERROR_READER, '');
  return source.slice(0, start) + withoutReader + (end < 0 ? '' : source.slice(end));
}

it.each([
  { path: 'launch', moduleName: '/$bunfs/root/chunk-3pr91mb5.js' },
  { path: 'resume', moduleName: '/$bunfs/root/chunk-pwf6g3a4.js' },
])('rejects a partially modified $path control-error reader patch atomically', ({ moduleName }) => {
  const patched = applyModelRoutingTransform(supportedHarnessSource, routerTransformOptions);
  const incomplete = removeModuleReader(patched.content, moduleName);

  const reapplied = applyModelRoutingTransform(incomplete, routerTransformOptions);

  expect(reapplied.content).toBe(incomplete);
  expect(reapplied.results[0]?.status).toBe('FAIL');
});

it('leaves the bundle unchanged when routing activation cannot patch a supported layout', () => {
  const source = supportedHarnessSource;
  const priorOutcome = applyModelRoutingTransform(source, routerTransformOptions);
  const resumeModule = '\n//#__leverframe_claude_module__:/$bunfs/root/chunk-pwf6g3a4.js';
  const unsupported = source.slice(0, source.indexOf(resumeModule));

  const outcome = applyLeverframePatches(unsupported, { auto: {
    routingEnabled: true,
    routingPolicyModelId: 'concrete-router',
    routingMetadata: { contextWindow: 80_000, maxOutputTokens: 10_000, supportedReasoningEfforts: ['low'] },
  } });

  expect(outcome.content).toBe(unsupported);
  expect(outcome.results[0]?.status).not.toBe(priorOutcome.results[0]?.status);
});

interface ConcreteRequest {
  model: string;
  effort: string;
  contextWindow: number;
  agentContext: Record<string, unknown>;
}

function runConcreteHarness(availableModels: string[], fallbackModel: string, requests: ConcreteRequest[]) {
  const transformed = applyModelRoutingTransform(supportedHarnessSource, routerTransformOptions);
  const executable = transformed.content.replace(/import\{[^}]+\}from"[^"]+";/g, '');
  return runInNewContext(executable + ';runAndSend', {
    process: { env: { [ROUTING_ACTIVE_ENV]: ROUTING_ACTIVE_VALUE } },
    AbortSignal,
    Buffer,
    ...routingHandoffSchemaGlobals(),
    availableModels,
    iAe: (definition: { model: string }) => definition.model,
    EKs: (_definition: unknown, _parentModel: string, requestedModel: string) =>
      availableModels.includes(requestedModel) ? requestedModel : fallbackModel,
    FWr: (toolContext: { agentContext: Record<string, unknown> }) => ({
      agentContext: { ...toolContext.agentContext },
    }),
    a6e: () => ({ user_id: 'fixture-session-metadata' }),
    s8t: (value: unknown) => value,
    gt: {},
    LT: (model: string) => model,
    jn: (model: string) => model,
    Die: () => [],
    send: (request: ConcreteRequest) => {
      requests.push(request);
      return request;
    },
  }) as (input: Record<string, unknown>) => Promise<ConcreteRequest>;
}

function concreteLaunchInput(policyModel: string, hiddenBinding: string) {
  const agentContext = { agentType: 'subagent', session: 'worker-session', effort: 'low', contextWindow: 70_000 };
  return {
    agentDefinition: { agentType: 'reviewer' },
    promptMessages: [],
  toolUseContext: { agentContext, contextWindow: 70_000, spawnedByWorkflowRunId: undefined },
    canUseTool: () => undefined,
    isAsync: true,
    override: undefined,
    model: policyModel,
    routingBinding: hiddenBinding,
    effort: 'low',
    session: 'worker-session',
    spawnMode: 'spawn',
  };
}

it('resolves an available concrete child model while sending only its binding identity', async () => {
  const policyModel = 'concrete-worker-model';
  const hiddenBinding = 'opaque-worker-binding';
  const requests: ConcreteRequest[] = [];
  const runAndSend = runConcreteHarness([policyModel], 'parent-model', requests);

  const request = await runAndSend(concreteLaunchInput(policyModel, hiddenBinding));

  expect(request.model).toBe(hiddenBinding);
  expect(request.effort).toBe('low');
  expect(request.contextWindow).toBe(70_000);
  expect(request.agentContext).toMatchObject({
    session: 'worker-session',
    effort: 'low',
    contextWindow: 70_000,
    leverframeRoutingBinding: hiddenBinding,
    leverframeRoutingPolicyModel: policyModel,
  });
  expect(requests).toHaveLength(1);
});

it('fails before outbound inference when the available model set rejects the concrete target', async () => {
  const policyModel = 'concrete-worker-model';
  const requests: ConcreteRequest[] = [];
  const runAndSend = runConcreteHarness(['other-available-model'], 'parent-model', requests);

  await expect(runAndSend(concreteLaunchInput(policyModel, 'opaque-worker-binding')))
    .rejects.toMatchObject({ name: expect.any(String), message: expect.any(String) });

  expect(requests).toHaveLength(0);
});

it.each([
  ['remote', { isRemote: true }],
  ['forked or observer', { isFork: true }],
])('fails closed for %s launches before registering a local binding', async (_kind, launchMode) => {
  const requests: MockControlRequest[] = [];
  const runners = runPatchedHarness({
    modelId: 'opaque-launch-binding', policyModelId: 'concrete-reviewer-model', effort: 'low', revision: 1,
  }, requests);

  await expect(runners.runLaunch({ options: { tools: [] }, ...launchMode }))
    .rejects.toMatchObject({ message: expect.any(String) });
  expect(requests).toHaveLength(0);
});
