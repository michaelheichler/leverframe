import { AsyncLocalStorage } from 'node:async_hooks';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { ROUTING_SNAPSHOT_LABEL } from '../src/constants.js';
import { applyRoutingRecoveryTransform } from '../src/patch-transforms-routing-recovery.js';
import { CLAUDE_AGENT_2_1_314_RECOVERY_SCOPE_SOURCE } from './fixtures/claude-agent-2.1.314-recovery.js';

const policyModelId = 'fixture-recovery-shared-policy';
const bindingId = 'opaque-recovery-binding';
const nativeFacts = { id: policyModelId, context_window: 90_000,
  runtime: { max_input_tokens: 90_000, max_output_tokens: 12_000, effort_levels: ['high'] } };
const hostFacts = { contextWindow: 40_000, maxOutputTokens: 1_000, supportedReasoningEfforts: ['low'] };
const savedReviewedTask = JSON.stringify({ version: 1, agentType: 'reviewer',
  prefix: { role: 'specialist', category: 'implementation', stableInstructions: ['Keep the reviewed system context.'],
    tools: ['Read the source.'], providerIdentityRequirements: [] },
  task: { delegatedTask: 'Recover the accepted work.', originalTask: 'Keep the provider identity stable.',
    requiredConstraints: ['Preserve response order.'], evidence: [{ source: 'tool-result', content: 'The prior tool confirmed this behavior.' }],
    jobState: 'One compatibility issue remains open.' }, additionalInstructions: [] });

function snapshotMessage(content: string) {
  return { type: 'user', isMeta: undefined, toolUseResult: undefined, message: { role: 'user', content } };
}

interface RecoveryReply {
  kind: 'bound' | 'unbound';
  modelId?: string;
  policyModelId?: string;
  effort?: string;
  metadata?: Record<string, unknown>;
  handoff?: { version: number; agentType: string; reviewedTask: string };
}

interface RecoveryHarnessOptions {
  reply?: RecoveryReply;
  sidecar?: Record<string, unknown> | null;
  diskless?: boolean;
  forked?: boolean;
  nestedRecovery?: string;
  outputTokens?: number;
  resolvedRunnerModel?: string;
  iteratorGate?: Promise<void>;
  errorResponse?: { status: number; body: Record<string, unknown> };
  history?: Array<Record<string, unknown>>;
  interrupted?: boolean;
}

interface RecoveryHarness {
  functions: {
    jr(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    yUe(model: string): Record<string, unknown> | undefined;
    tP(input: Record<string, unknown>): AsyncGenerator<unknown>;
  };
  captures: {
    requests: Array<{ url: string; method: string; authorization?: string; body: Record<string, unknown> }>;
    resolutions: Array<{ model: string; metadata?: Record<string, unknown> }>;
    reminders: Array<{ model: string; metadata?: Record<string, unknown> }>;
    iteratorBefore: Array<Record<string, unknown> | undefined>;
    iteratorAfter: Array<Record<string, unknown> | undefined>;
    iteratorEfforts: Array<string | undefined>;
    runnerModels: string[];
    iteratorFinally: Array<Record<string, unknown> | undefined>;
  promptMessages: unknown[][];
    sent: Array<Record<string, unknown>>;
    newAgentPrepared: boolean;
    childStarted: () => void;
    childStartedPromise: Promise<void>;
    transformStatus?: string;
    transformExtra?: string;
  };
}

function nativeSidecar(): Record<string, unknown> {
  return { agentType: 'reviewer', model: policyModelId, effort: 'high', leverframeRoutingBinding: bindingId };
}

function createRecoveryHarness(options: RecoveryHarnessOptions = {}): RecoveryHarness {
  const iteratorGate = options.iteratorGate ?? Promise.resolve();
  const captures: RecoveryHarness['captures'] = {
    requests: [],
    resolutions: [],
    reminders: [],
    iteratorBefore: [],
    iteratorAfter: [],
    iteratorEfforts: [],
    runnerModels: [],
    iteratorFinally: [],
    promptMessages: [],
    sent: [],
    newAgentPrepared: false,
    childStarted: () => undefined,
    childStartedPromise: Promise.resolve(),
  };
  let signalChildStarted!: () => void;
  captures.childStartedPromise = new Promise<void>(resolve => { signalChildStarted = resolve; });
  captures.childStarted = signalChildStarted;
  const reply = options.reply ?? {
    kind: 'bound',
    modelId: bindingId,
    policyModelId,
    effort: 'low',
    metadata: hostFacts,
    handoff: { version: 1, agentType: 'reviewer', reviewedTask: savedReviewedTask },
  };
  const metadataLookup = (model: string) => harness.functions?.yUe(model);
  const controlRequests = captures.requests;
  const originalFetch = async (url: URL, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => {
    if (init.signal?.aborted) throw new DOMException('Recovery request aborted.', 'AbortError');
    controlRequests.push({ url: url.href, method: init.method, authorization: init.headers['Authorization'],
      body: JSON.parse(init.body) as Record<string, unknown> });
    if (options.errorResponse) {
      const bytes = new TextEncoder().encode(JSON.stringify(options.errorResponse.body));
      let read = false;
      const body = { getReader: () => ({ read: async () => {
        if (read) return { done: true as const, value: undefined };
        read = true;
        return { done: false as const, value: bytes };
      }, cancel: async () => undefined }) };
      return { ok: false, status: options.errorResponse.status, body };
    }
    const response = options.nestedRecovery === 'jr' && controlRequests.length > 1 ? { kind: 'unbound' as const } : reply;
    return { ok: true, status: 200, json: async () => response };
  };
  const bindingTransform = applyRoutingRecoveryTransform(CLAUDE_AGENT_2_1_314_RECOVERY_SCOPE_SOURCE, { enabled: true });
  captures.transformStatus = bindingTransform.results[0]?.status;
  captures.transformExtra = bindingTransform.results[0]?.extra;
  const executable = bindingTransform.content
    .replace('import{AsyncLocalStorage as __lfRecoveryALS}from"node:async_hooks";', 'const __lfRecoveryALS=AsyncLocalStorage;')
    .replace(/import\{[^}]+\}from"[^"]+";/g, '')
    .replace(/export\{__lfRecoveryRun,__lfRecoveryCurrent,__lfRecoveryIterator,__lfRecoveryBounds\};/g, '');
  let harness: RecoveryHarness;
  const functions = runInNewContext(executable + '\n;({jr,yUe,tP})', {
    AsyncLocalStorage,
    AbortController,
    AbortSignal,
    Buffer,
    URL,
    TextDecoder,
    TextEncoder,
    Oe: ({ content }: { content: string }) => ({ type: 'user', isMeta: undefined, toolUseResult: undefined,
      message: { role: 'user', content } }),
    process: { env: {
      LEVERFRAME_CONTEXT_SELECTION_BASE_URL: 'http://127.0.0.1:43123',
      LEVERFRAME_CONTEXT_SELECTION_TOKEN: 'fixture-recovery-token',
    } },
    __lfSession: () => 'fixture-recovery-session',
    nE: async () => options.sidecar === undefined ? nativeSidecar() : options.sidecar,
    Or: (agentId: string) => agentId,
    jt: async () => undefined,
    op: () => ({}),
    Wr: {},
    xse: async () => null,
    gLe: () => undefined,
    X: () => options.diskless === true,
    vn: () => false,
    ptt: () => false,
    lE: () => true,
    g8e: () => false,
    fc: () => 'parent-model',
    iAe: (definition: { model?: string }) => definition.model,
    UZe: () => ({ systemPrompt: 'native system preparation' }),
    xn: () => '',
    Zjr: () => ({ marks: {} }),
    jG: (_definition: unknown, _parent: string, model: string) => {
      captures.resolutions.push({ model, metadata: metadataLookup(model) });
      return model;
    },
    RMr: (input: { agentDefinition: unknown; model: string }) => {
      captures.reminders.push({ model: input.model, metadata: metadataLookup(input.model) });
      return { agentDefinition: input.agentDefinition };
    },
    Xy: (_catalog: unknown, models: string[]) => models.find(model => model === policyModelId) ? nativeFacts : undefined,
    ln: () => ({ [policyModelId]: nativeFacts }),
    Ue: undefined,
    FWr: (context: { agentContext?: Record<string, unknown> }) => ({ agentContext: { ...context.agentContext } }),
    a6e: () => ({ user_id: 'fixture-session-id' }),
    jn: (model: string) => model,
    D0: {},
    cG: () => undefined,
    LT: (model: string) => model,
    buildRequest: undefined,
    send: (request: Record<string, unknown>) => { captures.sent.push(request); return request; },
    sent: captures.sent,
    soe: (runner: Record<string, unknown>) => runner,
    iteratorBefore: captures.iteratorBefore,
    iteratorAfter: captures.iteratorAfter,
    iteratorEfforts: captures.iteratorEfforts,
    runnerModels: captures.runnerModels,
    iteratorFinally: captures.iteratorFinally,
    childStarted: captures.childStarted,
    iteratorGate,
    nestedRecovery: options.nestedRecovery,
    isFork: options.forked === true,
    recoveryCaptures: captures,
    outputTokens: options.outputTokens,
    EKs: () => options.resolvedRunnerModel ?? policyModelId,
    fetch: originalFetch,
  }) as RecoveryHarness['functions'];
  harness = { functions, captures };
  return harness;
}

function launch(harness: RecoveryHarness, agentId = 'fixture-recovered-child', options: { history?: Array<Record<string, unknown>>;
  interrupted?: boolean; abortController?: AbortController } = {}) {
  const toolUseContext = {
    session: 'fixture-recovery-session',
    storageV5: {},
    abortController: options.abortController ?? new AbortController(),
    getAppState: () => ({}),
    permissionLayers: [],
    options: { tools: [] },
    agentContext: { session: 'fixture-parent-session' },
    promptMessages: options.history ?? [],
  };
  return harness.functions.jr({ agentId, toolUseContext, continueInterruptedTurn: options.interrupted === true });
}

it('isolates same-ID main metadata while a recovered child advances and keeps the binding on wire', async () => {
  let release!: () => void;
  const iteratorGate = new Promise<void>(resolve => { release = resolve; });
  const harness = createRecoveryHarness({ iteratorGate });
  const before = harness.functions.yUe(policyModelId);
  const child = await launch(harness);
  const iterator = (child['makeStream'] as () => AsyncGenerator<unknown>)();
  const next = iterator.next();
  await harness.captures.childStartedPromise;
  const mainDuring = harness.functions.yUe(policyModelId);
  release();
  const step = await next;
  const after = harness.functions.yUe(policyModelId);
  await iterator.return(undefined);

  expect({ status: harness.captures.transformStatus, extra: harness.captures.transformExtra })
    .toEqual({ status: 'OK', extra: undefined });
  expect(harness.captures.requests).toHaveLength(1);
  expect(before).toMatchObject({ context_window: nativeFacts.context_window,
    runtime: { effort_levels: ['high'], max_output_tokens: 12_000 } });
  expect(mainDuring).toEqual(before);
  expect(after).toEqual(before);
  expect(harness.captures.resolutions[0]).toMatchObject({ model: policyModelId,
    metadata: { context_window: hostFacts.contextWindow, runtime: { effort_levels: ['low'] } } });
  expect(harness.captures.reminders[0]).toMatchObject({ model: policyModelId,
    metadata: { context_window: hostFacts.contextWindow, runtime: { max_output_tokens: 1_000 } } });
  expect(harness.captures.iteratorBefore[0]).toMatchObject({ context_window: hostFacts.contextWindow });
  expect(harness.captures.iteratorAfter[0]).toMatchObject({ context_window: hostFacts.contextWindow });
  expect(harness.captures.iteratorFinally[0]).toMatchObject({ context_window: hostFacts.contextWindow });
  expect(step.value).toMatchObject({ model: bindingId, max_tokens: 900, effort: 'low' });
  expect(harness.captures.iteratorEfforts[0]).toBe('low');
  expect(harness.captures.runnerModels[0]).toBe(policyModelId);
  expect(harness.captures.requests[0]?.body).toMatchObject({ sessionId: 'fixture-recovery-session',
    launchId: 'fixture-recovered-child', sidecarValid: true, marker: bindingId, agentType: 'reviewer' });
});
it('appends the matching recovered task after Q and preserves one tool-result follow-up', async () => {
  const existing = { type: 'user', message: { role: 'user', content: 'Current recovery history.' } };
  const harness = createRecoveryHarness();
  const child = await launch(harness, 'fixture-recovered-child', { history: [existing] });
  await (child['makeStream'] as () => AsyncGenerator<unknown>)().next();

  expect(harness.captures.requests[0]?.body).toMatchObject({ agentType: 'reviewer', marker: bindingId });
  expect(harness.captures.promptMessages[0]).toEqual([existing,
    snapshotMessage(`${ROUTING_SNAPSHOT_LABEL}${savedReviewedTask}`),
    { role: 'user', content: 'Current recovery follow-up' }]);
});
it('does not append a second recovered snapshot when Q already has it', async () => {
  const existing = { type: 'user', message: { role: 'user', content: `${ROUTING_SNAPSHOT_LABEL}${savedReviewedTask}` } };
  const harness = createRecoveryHarness();
  const child = await launch(harness, 'fixture-recovered-child', { history: [existing] });
  await (child['makeStream'] as () => AsyncGenerator<unknown>)().next();

  expect(harness.captures.promptMessages[0]).toEqual([existing, { role: 'user', content: 'Current recovery follow-up' }]);
});

it('does not treat a tool-result row as proof that the recovery snapshot is already in Q', async () => {
  const toolResult = { type: 'user', toolUseResult: { content: savedReviewedTask },
    message: { role: 'user', content: savedReviewedTask } };
  const harness = createRecoveryHarness();
  const child = await launch(harness, 'fixture-recovered-child', { history: [toolResult] });
  await (child['makeStream'] as () => AsyncGenerator<unknown>)().next();

  expect(harness.captures.promptMessages[0]).toEqual([toolResult,
    snapshotMessage(`${ROUTING_SNAPSHOT_LABEL}${savedReviewedTask}`),
    { role: 'user', content: 'Current recovery follow-up' }]);
});

it('rejects interrupted recovery when Q lacks the saved task snapshot', async () => {
  const harness = createRecoveryHarness();

  await expect(launch(harness, 'fixture-recovered-child', { history: [], interrupted: true })).rejects.toThrow();

  expect(harness.captures.sent).toHaveLength(0);
});
it('propagates parent cancellation before recovery lookup', async () => {
  const controller = new AbortController();
  controller.abort();
  const harness = createRecoveryHarness();

  await expect(launch(harness, 'fixture-recovered-child', { abortController: controller })).rejects.toThrow();

  expect(harness.captures.requests).toHaveLength(0);
});

const iteratorOperations = [
  { label: 'next', perform: async (iterator: AsyncGenerator<unknown>) => (await iterator.next()).done, expected: true },
  { label: 'return', perform: async (iterator: AsyncGenerator<unknown>) => (await iterator.return(undefined)).done, expected: true },
  { label: 'throw', perform: async (iterator: AsyncGenerator<unknown>) =>
    iterator.throw(new Error('fixture cancellation')).then(() => 'resolved', () => 'rejected'), expected: 'rejected' },
];

it.each(iteratorOperations)('keeps recovery metadata active through async iterator $label and finally', async ({ perform, expected }) => {
  const harness = createRecoveryHarness();
  const child = await launch(harness);
  const iterator = (child['makeStream'] as () => AsyncGenerator<unknown>)();
  await iterator.next();

  const outcome = await perform(iterator);

  expect(outcome).toBe(expected);
  expect(harness.captures.iteratorFinally[0]).toMatchObject({ context_window: hostFacts.contextWindow,
    runtime: { max_output_tokens: hostFacts.maxOutputTokens, effort_levels: hostFacts.supportedReasoningEfforts } });
});

it('preserves a historical unmarked child as an ordinary native-model request', async () => {
  const harness = createRecoveryHarness({ reply: { kind: 'unbound' },
    sidecar: { agentType: 'subagent', model: policyModelId, effort: 'high' } });
  const child = await launch(harness);
  const iterator = (child['makeStream'] as () => AsyncGenerator<unknown>)();
  const step = await iterator.next();

  expect(harness.captures.requests[0]?.body).toMatchObject({ sidecarValid: true });
  expect(harness.captures.requests[0]?.body.marker).toBeUndefined();
  expect(harness.captures.resolutions[0]?.metadata).toMatchObject({ context_window: nativeFacts.context_window });
  expect(step.value).toMatchObject({ model: policyModelId, max_tokens: 900 });
  expect((step.value as Record<string, unknown>)['model']).not.toBe(bindingId);
});

it.each([
  { label: 'unbound child call', nestedRecovery: 'unbound' },
  { label: 'mismatched child binding call', nestedRecovery: 'mismatched' },
  { label: 'new-agent launch', nestedRecovery: 'agent' },
])('rejects nested $label before request dispatch in a recovered scope', async ({ nestedRecovery }) => {
  const harness = createRecoveryHarness({ nestedRecovery });
  const child = await launch(harness);
  const iterator = (child['makeStream'] as () => AsyncGenerator<unknown>)();
  const result = await iterator.next().then(() => '', error => String(error));

  expect(result).toMatch(/recovery|agent/i);
  expect(harness.captures.sent).toHaveLength(0);
  expect(harness.captures.newAgentPrepared).toBe(false);
});

it('rejects a child runner resolution that differs from its accepted concrete model before dispatch', async () => {
  const harness = createRecoveryHarness({ resolvedRunnerModel: 'different-resolved-model' });
  const child = await launch(harness);
  const result = await (child['makeStream'] as () => AsyncGenerator<unknown>)().next()
    .then(() => '', error => String(error));

  expect(result).toMatch(/restricted|changed/i);
  expect(harness.captures.runnerModels).toHaveLength(0);
  expect(harness.captures.sent).toHaveLength(0);
});

it('rejects an unbound nested resume before preparing its model inside recovery scope', async () => {
  const harness = createRecoveryHarness({ nestedRecovery: 'jr' });
  const child = await launch(harness);
  const result = await (child['makeStream'] as () => AsyncGenerator<unknown>)().next()
    .then(() => '', error => String(error));

  expect(result).toMatch(/nested|recovery|marker/i);
  expect(harness.captures.requests).toHaveLength(2);
  expect(harness.captures.resolutions).toHaveLength(1);
  expect(harness.captures.reminders).toHaveLength(1);
  expect(harness.captures.sent).toHaveLength(0);
});

it('rejects a transferred binding when its async iterator has no recovery scope', async () => {
  const harness = createRecoveryHarness();
  const result = await harness.functions.tP({ model: policyModelId, session: 'fixture-recovery-session',
    routingBinding: bindingId }).next().then(() => '', error => String(error));

  expect(result).toMatch(/recovery scope/i);
  expect(harness.captures.iteratorBefore).toHaveLength(0);
  expect(harness.captures.sent).toHaveLength(0);
});

it.each([
  { label: 'diskless', diskless: true },
  { label: 'observer', sidecar: { ...nativeSidecar(), isObserver: true } },
  { label: 'fork', forked: true },
])('rejects a bound $label resume before model preparation', async options => {
  const harness = createRecoveryHarness(options);
  const result = await launch(harness).then(() => '', error => String(error));

  expect(result).toMatch(/recovery mode/i);
  expect(harness.captures.resolutions).toHaveLength(0);
  expect(harness.captures.reminders).toHaveLength(0);
});

it('fails before dispatch when a recovered output request exceeds its saved limit', async () => {
  const harness = createRecoveryHarness({ outputTokens: 1_001 });
  const child = await launch(harness);
  const iterator = (child['makeStream'] as () => AsyncGenerator<unknown>)();
  const result = await iterator.next().then(() => '', error => String(error));

  expect(result).toMatch(/output limit/i);
  expect(harness.captures.sent).toHaveLength(0);
});
