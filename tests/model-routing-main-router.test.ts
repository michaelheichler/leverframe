import { runInNewContext, Script } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { applyMainRoutingTransform } from '../src/patch-transforms-main-routing.js';
import { applyMainRoutingWireGuard } from '../src/patch-transforms-main-wire.js';
import { ROUTING_ACTIVE_ENV, ROUTING_ACTIVE_VALUE } from '../src/constants.js';
import { applyRoutingPatchComposition } from '../src/patch-transforms-routing-composition.js';
import { applyModelRoutingTransform } from '../src/patch-transforms-model-routing.js';
import { applyLeverframePatches } from '../src/patch-transforms.js';
import { verifyPatchSites } from '../src/patch-transaction.js';
import { CLAUDE_MODULE_BOUNDARY, splitModulePayload } from '../src/claude-bundle-native.js';
import { CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE } from './fixtures/claude-agent-2.1.314-routing.js';
import { claudeAgentRoutingHandoffSource, ROUTING_TEST_PROMPT_POLICY, routingHandoffSchemaGlobals } from './fixtures/claude-agent-2.1.314-routing.js';
import { claudeAgentRoutingNoticeCompositionSource } from './fixtures/claude-agent-2.1.314-routing-composition.js';

const transformOptions: Parameters<typeof applyMainRoutingTransform>[1] = { enabled: true, visibleModelId: 'auto', policyModelId: 'concrete-router' };
const selectedMetadata = { id: 'concrete-router', context_window: 80_000,
  runtime: { max_input_tokens: 80_000, max_output_tokens: 12_000, effort_levels: ['low', 'medium'] } };
const sourcedRoutingComposition = claudeAgentRoutingNoticeCompositionSource();
const mainRouterModules = new Set([
  '/$bunfs/root/chunk-bqbyxpv1.js',
  '/$bunfs/root/chunk-a0eq9prc.js',
  '/$bunfs/root/chunk-z2g9tcvz.js',
]);
const patcherShell = `function patcherShell(){
const schema=z.enum(["sonnet","opus","haiku","fable"]).optional().describe(\`Optional model override for this agent.\`);
var KNOWN=["sonnet","opus","haiku","fable","opusplan"];
function alias(x){switch(x){case"best":{return"opus"}default:return null}}
function options(e,t,r){let n=current(),o=n==="opus"?[n,r]:[r];for(let i of o)apply(e,i,t);return e}
function capabilities(e,t){let r=feature();if(r!==void 0)return r;if(allowed(e,t))return supported;return unavailable}
function defaultEffort(e){return metadata(e)?.default_effort??"high"}
}`;

interface MainRouterFunctions {
  ro(model: string, options?: Record<string, unknown>): boolean;
  Ut(model: string): string;
  LT(model: string): string;
  yUe(...models: string[]): Record<string, unknown> | undefined;
  dn(model: string): Record<string, unknown> | undefined;
  DZr(model: string): string[] | undefined;
  iQo(input: Record<string, unknown>, context?: unknown): Record<string, unknown>;
  nkn(model: string): string | null;
  _p(input: Record<string, unknown>): Record<string, unknown>;
  pS(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function mainRouter(availableModels: string[], runtimeModel?: string, overriddenModel?: string,
  options = transformOptions, includeNativeCatalogModel = true,
  source = CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE, sourceAlreadyTransformed = false,
  additionalNativeModels: Record<string, unknown> = {}, composeBounds = false) {
  const transformed = sourceAlreadyTransformed ? { content: source }
    : composeBounds ? applyRoutingPatchComposition(source, options.visibleModelId, {
      routingEnabled: true,
      routingPolicyModelId: options.policyModelId,
      routingPromptPolicy: ROUTING_TEST_PROMPT_POLICY,
      routingMetadata: options.metadata ? { contextWindow: options.metadata.contextWindow,
        maxOutputTokens: options.metadata.maxOutputTokens,
        supportedReasoningEfforts: options.metadata.supportedReasoningEfforts }
        : { contextWindow: 80_000, maxOutputTokens: 12_000, supportedReasoningEfforts: ['low', 'medium'] },
      routingTargetMetadata: options.targetMetadata && Object.fromEntries(Object.entries(options.targetMetadata)
        .map(([id, value]) => [id, { contextWindow: value.contextWindow,
          maxOutputTokens: value.maxOutputTokens, supportedReasoningEfforts: value.supportedReasoningEfforts }])),
    }) : applyMainRoutingTransform(source, options);
  if (composeBounds) {
    expect(transformed.content).not.toBe(source);
    expect('results' in transformed && !transformed.results.some(result => result.status === 'FAIL')).toBe(true);
  }
  const restrictionChecks: string[] = [];
  const metadataLookups: string[] = [];
  const effortLookups: string[] = [];
  const promptStarts: string[] = [];
  const nativeCatalog = { ...(includeNativeCatalogModel ? { [selectedMetadata.id]: selectedMetadata } : {}), ...additionalNativeModels };
  const extractsMainModules = composeBounds || sourceAlreadyTransformed;
  const moduleStart = extractsMainModules ? transformed.content.indexOf(CLAUDE_MODULE_BOUNDARY) : -1;
  const parsedModules = moduleStart < 0 ? undefined
    : splitModulePayload(transformed.content.slice(moduleStart));
  const selectedModules = parsedModules?.filter(([name]) => mainRouterModules.has(name));
  if (extractsMainModules) {
    expect(moduleStart).toBeGreaterThanOrEqual(0);
    expect(selectedModules?.length).toBeGreaterThan(0);
  }
  const executableSource = extractsMainModules ? selectedModules!.map(([, content]) => content).join('\n')
    : transformed.content;
  const executable = executableSource.replace(/import\{[^}]+\}from"[^"]+";/g, '')
    .replace(/export\{[^}]+\};/g, '');
  let metadataResolver: (model: string) => Record<string, unknown> | undefined;
  const functions = runInNewContext(executable + '\n;({ro,Ut,LT,yUe,dn,DZr,iQo,nkn,_p,pS})', {
    process: { env: { [ROUTING_ACTIVE_ENV]: ROUTING_ACTIVE_VALUE } },
    ...routingHandoffSchemaGlobals(),
    gOe: (model: string) => { restrictionChecks.push(model); return false; },
    e3: () => false,
    uV: () => false,
    pV: () => undefined,
    lr: () => ({ availableModels }),
    wK: () => false,
    Qdt: () => ({ kind: 'model' }),
    Dt: (value: string) => value.trim().toLowerCase(),
    v_: () => false,
    Pw: () => null,
    dr: () => false,
    beo: () => true,
    Rw: (model: string, overrides: Record<string, string>) => overrides[model] ?? model,
    Se: () => ({ modelOverrides: {} }),
    Cge: () => ({}),
    HTn: (model: string) => model,
    hso: () => false,
    yK: () => false,
    kK: () => false,
    bK: () => false,
    HS: () => false,
    tos: () => null,
    zP: (model: string) => model,
    hV: (model: string) => model,
    sG: (model: string) => model,
    jn: (model: string) => model,
    D0: overriddenModel ? { 'concrete-router': 0 } : {},
    cG: () => undefined,
    Ck: () => overriddenModel ? { overridden: true, mapped: overriddenModel } : undefined,
    Mme: () => overriddenModel ? [overriddenModel] : [],
    Te: () => 'thirdParty',
    Io: [],
    Xy: (_catalog: unknown, models: string[]) => {
    const id = models[0]!;
      metadataLookups.push(id);
      const availableId = models.find(model => nativeCatalog[model as keyof typeof nativeCatalog] !== undefined);
      return availableId ? nativeCatalog[availableId as keyof typeof nativeCatalog] : undefined;
    },
    __lfModelMeta: (model: string) => metadataResolver?.(model),
    ln: () => nativeCatalog,
    le: (model: string) => { effortLookups.push(model); return model === selectedMetadata.id ? 'low' : null; },
    DD: (model: string) => model,
    Qe: (model: string) => model,
    ROe: () => [],
    lE: () => false,
    b: (level: string) => level,
    HD: () => false,
    Lu: () => false,
    qK: () => true,
    fy: ({ mainLoopModel }: { mainLoopModel: string }) => runtimeModel ?? mainLoopModel,
    fh: (name: string) => { promptStarts.push(name); },
    ot: () => 'default-model',
    K7: () => false,
    Td: () => 'default-model',
    Le: () => undefined,
    be: () => undefined,
    nO: () => undefined,
    R9t: () => false,
    Me: () => false,
    Ak: () => 'fallback-model',
    eos: () => false,
  }) as MainRouterFunctions;
  metadataResolver = functions.yUe;
  return { functions, restrictionChecks, metadataLookups, effortLookups, promptStarts };
}

function mainOutboundRequest() {
  const source = [patcherShell, claudeAgentRoutingHandoffSource()].join('\n');
  const bindings = applyModelRoutingTransform(source, { enabled: true, promptPolicy: ROUTING_TEST_PROMPT_POLICY });
  const main = applyMainRoutingTransform(bindings.content, transformOptions);
  const wire = applyMainRoutingWireGuard(main.content, { enabled: true, visibleModelId: 'auto' });
  const executable = wire.content.replace(/import\{[^}]+\}from"[^"]+";/g, '');
  return runInNewContext(executable + '\n;({buildRequest,_p})', {
    process: { env: { [ROUTING_ACTIVE_ENV]: ROUTING_ACTIVE_VALUE } },
    ...routingHandoffSchemaGlobals(),
    a6e: () => ({ user_id: 'fixture-session-metadata' }),
    s8t: (value: unknown) => value,
    gt: {},
    gOe: () => false,
    e3: () => false,
    uV: () => false,
    pV: () => undefined,
    lr: () => ({ availableModels: ['concrete-router'] }),
    wK: () => false,
    Qdt: () => ({ kind: 'model' }),
    Dt: (value: string) => value.trim().toLowerCase(),
    v_: () => false,
    Pw: () => null,
    dr: () => false,
    beo: () => true,
    Rw: (model: string) => model,
    Se: () => ({ modelOverrides: {} }),
    Cge: () => ({}),
    HTn: (model: string) => model,
    hso: () => false,
    yK: () => false,
    kK: () => false,
    bK: () => false,
    HS: () => false,
    tos: () => null,
    zP: (model: string) => model,
    hV: (model: string) => model,
    sG: (model: string) => model,
    jn: (model: string) => model,
    D0: {},
    cG: () => undefined,
    Ut: (model: string) => model,
    Qb: () => true,
    HD: () => false,
    Lu: () => false,
    qK: () => true,
    fy: ({ mainLoopModel }: { mainLoopModel: string }) => mainLoopModel,
    ot: () => 'default-model',
    K7: () => false,
    Die: () => [],
  }) as {
    buildRequest: (input: { model: string; agentContext: Record<string, unknown>; tools?: Array<{ name: string }> }, messages: unknown) => { model: string; agentContext: Record<string, unknown> };
    _p: (input: Record<string, unknown>) => { runtimeModel: string };
  };
}

function cliModel(model: string) {
  return { cli: { model, isNonInteractiveSession: false }, env: {}, settings: {}, agentFrontmatter: undefined };
}

it('parses the minimized sourced router modules before transformation', () => {
  expect(() => new Script(CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE)).not.toThrow();
});

it('returns executable source when main routing is enabled', () => {
  const transformed = applyMainRoutingTransform(CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE, transformOptions);

  expect(() => new Script(transformed.content)).not.toThrow();
});

it('skips an already applied main alias transform when the pin and metadata match', () => {
  const first = applyMainRoutingTransform(CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE, transformOptions);
  const repeated = applyMainRoutingTransform(first.content, transformOptions);

  expect(repeated.content).toBe(first.content);
  expect(repeated.results[0]?.status).toBe('SKIP');
});

it.each([
  { label: 'pin', options: { ...transformOptions, policyModelId: 'different-policy-model' } },
  { label: 'confirmed metadata', options: { ...transformOptions, metadata: { contextWindow: 90_000 } } },
  { label: 'visible model', options: { ...transformOptions, visibleModelId: 'different-auto' } },
])('fails closed when an applied main alias sees changed $label', ({ options }) => {
  const first = applyMainRoutingTransform(CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE, transformOptions);
  const repeated = applyMainRoutingTransform(first.content, options);

  expect(repeated.content).toBe(first.content);
  expect(repeated.results[0]?.status).toBe('FAIL');
});

it('keeps sourced main router bytes unchanged when routing is off', () => {
  const transformed = applyMainRoutingTransform(CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE,
    { ...transformOptions, enabled: false });

  expect(transformed.content).toBe(CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE);
});

it('leaves an unsupported main router source unchanged instead of partially transforming it', () => {
  const unsupported = CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE.slice(
    0, CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE.indexOf('/$bunfs/root/chunk-a0eq9prc.js'));
  const transformed = applyMainRoutingTransform(unsupported, transformOptions);

  expect(transformed.content).toBe(unsupported);
});

it('keeps the public auto identity through the native model normalizers', () => {
  const { functions } = mainRouter(['concrete-router']);

  expect(functions.Ut('auto')).toBe('auto');
  expect(functions.LT('auto')).toBe('auto');
});

it('checks the pinned concrete model when the public auto alias is allowed', () => {
  const harness = mainRouter(['concrete-router']);

  expect(harness.functions.ro('auto', { allowlist: ['concrete-router'] })).toBe(true);
  expect(harness.restrictionChecks).toContain('concrete-router');
});

it('rejects an explicit policy override that maps the concrete pin to a different model', () => {
  const { functions } = mainRouter(['override-target']);

  expect(() => functions.ro('auto', {
    allowlist: ['override-target'],
    overridesMap: { 'concrete-router': 'override-target' },
  })).toThrow();
});

it('rejects a provider model override that changes the concrete target identity', () => {
  const { functions } = mainRouter(['concrete-router'], undefined, 'mapped-provider-model');

  expect(() => functions.ro('auto', { allowlist: ['concrete-router'] })).toThrow();
});

it('uses the pinned concrete model for native catalog context lookup', () => {
  const harness = mainRouter(['concrete-router']);

  expect(harness.functions.yUe('auto')).toEqual(selectedMetadata);
  expect(harness.metadataLookups).toContain('concrete-router');
});

it('uses the pinned concrete model for native effort lookup', () => {
  const harness = mainRouter(['concrete-router']);

  expect(harness.functions.nkn('auto')).toBe('low');
  expect(harness.effortLookups).toContain('concrete-router');
});

it('supplies confirmed registry metadata when the native catalog lacks the concrete router model', () => {
  const metadata = { contextWindow: 90_000, maxOutputTokens: 12_000, supportedReasoningEfforts: ['low', 'medium'] };
  const options = { ...transformOptions, metadata };
  const harness = mainRouter(['concrete-router'], undefined, undefined, options, false,
    sourcedRoutingComposition, false, {}, true);

  expect(harness.functions.yUe('auto')).toEqual({
    id: 'concrete-router',
    context_window: 90_000,
    runtime: { max_input_tokens: 90_000, max_output_tokens: 12_000, effort_levels: ['low', 'medium'] },
  });
  expect(harness.functions.dn('auto')).toEqual({ max_input_tokens: 90_000, max_output_tokens: 12_000, effort_levels: ['low', 'medium'] });
  expect(harness.functions.dn('concrete-router')).toEqual(harness.functions.dn('auto'));
  expect(harness.functions.DZr('auto')).toEqual(['low', 'medium']);
  expect(harness.functions.DZr('concrete-router')).toEqual(['low', 'medium']);
});

it('uses host-confirmed metadata for a nonfavorite specialist despite looser native metadata', () => {
  const specialistModel = 'external-specialist-model';
  const specialistMetadata = { contextWindow: 38_000, maxOutputTokens: 3_200, supportedReasoningEfforts: ['low'] };
  const targetMetadata = { [specialistModel]: specialistMetadata };
  const options = { ...transformOptions, targetMetadata } as typeof transformOptions & {
    targetMetadata: Record<string, typeof specialistMetadata>;
  };
  const nativeSpecialist = { id: specialistModel, context_window: 180_000,
    runtime: { max_input_tokens: 180_000, max_output_tokens: 24_000, effort_levels: ['low', 'medium', 'high'] },
    nativeCatalogFact: 'preserved' };
  const harness = mainRouter(['concrete-router'], undefined, undefined, options, true,
    CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE, false, { [specialistModel]: nativeSpecialist });

  expect(harness.functions.yUe(specialistModel)).toMatchObject({
    id: specialistModel,
    context_window: specialistMetadata.contextWindow,
    runtime: { max_input_tokens: specialistMetadata.contextWindow, max_output_tokens: specialistMetadata.maxOutputTokens,
      effort_levels: specialistMetadata.supportedReasoningEfforts },
    nativeCatalogFact: 'preserved',
  });
  expect(harness.functions.dn(specialistModel)).toMatchObject({
    max_input_tokens: specialistMetadata.contextWindow,
    max_output_tokens: specialistMetadata.maxOutputTokens,
    effort_levels: specialistMetadata.supportedReasoningEfforts,
  });
  expect(harness.functions.DZr(specialistModel)).toEqual(specialistMetadata.supportedReasoningEfforts);
});

it('keeps unconfirmed specialist metadata unknown instead of inheriting the front router limits', () => {
  const specialistModel = 'partially-confirmed-specialist-model';
  const targetMetadata = { [specialistModel]: { contextWindow: 38_000 } };
  const options = { ...transformOptions, targetMetadata } as typeof transformOptions & {
    targetMetadata: Record<string, { contextWindow: number; maxOutputTokens?: number; supportedReasoningEfforts?: string[] }>;
  };
  const harness = mainRouter(['concrete-router'], undefined, undefined, options);

  expect(harness.functions.yUe(specialistModel)).toMatchObject({
    id: specialistModel,
    context_window: 38_000,
    runtime: { max_input_tokens: 38_000 },
  });
  expect(harness.functions.dn(specialistModel)).toEqual({ max_input_tokens: 38_000 });
  expect(harness.functions.DZr(specialistModel)).toBeUndefined();
});

it('prepares a native specialist absent from the native catalog when host bounds are confirmed', async () => {
  const specialistModel = 'claude-external-specialist';
  const targetMetadata = { [specialistModel]: { contextWindow: 38_000, maxOutputTokens: 3_200,
    supportedReasoningEfforts: ['low'] } };
  const options = { ...transformOptions, targetMetadata } as typeof transformOptions & {
    targetMetadata: Record<string, { contextWindow: number; maxOutputTokens: number; supportedReasoningEfforts: string[] }>;
  };
  const harness = mainRouter(['concrete-router'], undefined, undefined, options, false);

  await expect(harness.functions.pS({ runtimeModel: specialistModel })).resolves.toMatchObject({ runtimeModel: specialistModel });
  expect(harness.promptStarts).toEqual(['before_getSystemPrompt']);
});

it.each([
  { label: 'context window', native: { id: 'claude-unknown-bounds', runtime: { max_output_tokens: 3_200 } } },
  { label: 'output limit', native: { id: 'claude-unknown-bounds', context_window: 38_000,
    runtime: { max_input_tokens: 38_000 } } },
])('fails before prompt preparation when native metadata lacks a confirmed $label', async ({ native }) => {
  const options = { ...transformOptions, targetMetadata: {} } as typeof transformOptions & {
    targetMetadata: Record<string, { contextWindow?: number; maxOutputTokens?: number; supportedReasoningEfforts?: string[] }>;
  };
  const harness = mainRouter(['concrete-router'], undefined, undefined, options, false,
    sourcedRoutingComposition, false, { 'claude-unknown-bounds': native }, true);

  await expect(harness.functions.pS({ runtimeModel: 'claude-unknown-bounds' })).rejects.toMatchObject({ message: expect.any(String) });
  expect(harness.promptStarts).toEqual([]);
});

it('prefers mapped primary model metadata over a native fallback row', () => {
  const primary = 'mapped-specialist-primary';
  const fallback = 'native-specialist-fallback';
  const primaryFacts = { contextWindow: 42_000, maxOutputTokens: 2_000, supportedReasoningEfforts: ['low'] };
  const options = { ...transformOptions, targetMetadata: { [primary]: primaryFacts } } as typeof transformOptions & {
    targetMetadata: Record<string, typeof primaryFacts>;
  };
  const harness = mainRouter(['concrete-router'], undefined, undefined, options, true,
    CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE, false,
    { [fallback]: { id: fallback, context_window: 190_000, runtime: { max_output_tokens: 30_000 } } });

  expect(harness.functions.yUe(primary, fallback)).toMatchObject({ id: primary, context_window: primaryFacts.contextWindow,
    runtime: { max_input_tokens: primaryFacts.contextWindow, max_output_tokens: primaryFacts.maxOutputTokens,
      effort_levels: primaryFacts.supportedReasoningEfforts } });
});

it('retains a resolved native primary row instead of replacing it with a mapped fallback', () => {
  const primary = 'native-specialist-primary';
  const fallback = 'mapped-specialist-fallback';
  const fallbackFacts = { contextWindow: 42_000, maxOutputTokens: 2_000, supportedReasoningEfforts: ['low'] };
  const options = { ...transformOptions, targetMetadata: { [fallback]: fallbackFacts } } as typeof transformOptions & {
    targetMetadata: Record<string, typeof fallbackFacts>;
  };
  const nativePrimary = { id: primary, context_window: 91_000, runtime: { max_output_tokens: 8_000 } };
  const harness = mainRouter(['concrete-router'], undefined, undefined, options, true,
    CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE, false, { [primary]: nativePrimary });

  expect(harness.functions.yUe(primary, fallback)).toEqual(nativePrimary);
});

it('uses the first mapped fallback when no native model resolves', () => {
  const primary = 'nonfavorite-specialist-primary';
  const firstFallback = 'mapped-specialist-fallback-first';
  const laterFallback = 'mapped-specialist-fallback-later';
  const firstFacts = { contextWindow: 42_000, maxOutputTokens: 2_000, supportedReasoningEfforts: ['low'] };
  const laterFacts = { contextWindow: 81_000, maxOutputTokens: 9_000, supportedReasoningEfforts: ['high'] };
  const options = { ...transformOptions, targetMetadata: { [firstFallback]: firstFacts, [laterFallback]: laterFacts } } as typeof transformOptions & {
    targetMetadata: Record<string, typeof firstFacts>;
  };
  const harness = mainRouter(['concrete-router'], undefined, undefined, options);

  expect(harness.functions.yUe(primary, firstFallback, laterFallback)).toMatchObject({ id: firstFallback,
    context_window: firstFacts.contextWindow, runtime: { max_output_tokens: firstFacts.maxOutputTokens,
      effort_levels: firstFacts.supportedReasoningEfforts } });
});

it('rejects malformed supported effort metadata before changing the sourced module', () => {
  const malformedMetadata = { contextWindow: 90_000, maxOutputTokens: 12_000,
    supportedReasoningEfforts: 'low' as unknown as string[] };
  const options = { ...transformOptions, metadata: malformedMetadata };
  const transformed = applyMainRoutingTransform(CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE, options);

  expect(transformed.content).toBe(CLAUDE_AGENT_2_1_314_ROUTING_MAIN_SOURCE);
});

it('keeps auto as the root outbound model when no specialist binding is present', () => {
  const { buildRequest, _p } = mainOutboundRequest();

  const root = _p({ userSpecifiedModel: 'auto', permissionMode: 'default' });
  const request = buildRequest({ model: root.runtimeModel, agentContext: {}, tools: [{ name: 'Agent' }] }, null);

  expect(request.model).toBe('auto');
});

it('skips an already applied outbound guard when the visible model matches', () => {
  const source = claudeAgentRoutingHandoffSource();
  const bindingTransform = applyModelRoutingTransform(source, { enabled: true, promptPolicy: ROUTING_TEST_PROMPT_POLICY });
  const mainTransform = applyMainRoutingTransform(bindingTransform.content, transformOptions);
  const first = applyMainRoutingWireGuard(mainTransform.content, { enabled: true, visibleModelId: 'auto' });
  const repeated = applyMainRoutingWireGuard(first.content, { enabled: true, visibleModelId: 'auto' });

  expect(repeated.content).toBe(first.content);
  expect(repeated.results[0]?.status).toBe('SKIP');
});

it('fails closed when an applied outbound guard receives a different visible model', () => {
  const source = claudeAgentRoutingHandoffSource();
  const bindingTransform = applyModelRoutingTransform(source, { enabled: true, promptPolicy: ROUTING_TEST_PROMPT_POLICY });
  const mainTransform = applyMainRoutingTransform(bindingTransform.content, transformOptions);
  const first = applyMainRoutingWireGuard(mainTransform.content, { enabled: true, visibleModelId: 'auto' });
  const repeated = applyMainRoutingWireGuard(first.content, { enabled: true, visibleModelId: 'another-visible-model' });

  expect(repeated.content).toBe(first.content);
  expect(repeated.results[0]?.status).toBe('FAIL');
});

it('rejects a concrete root model at the outbound boundary before the sender receives it', () => {
  const { buildRequest } = mainOutboundRequest();
  const send = vi.fn();

  expect(() => send(buildRequest({ model: 'concrete-router', agentContext: {} }, null))).toThrow();
  expect(send).not.toHaveBeenCalled();
});

it('keeps the hidden wire identity for a specialist agent context binding', () => {
  const buildRequest = mainOutboundRequest();

  const request = buildRequest.buildRequest({ model: 'concrete-router', agentContext: {
    agentType: 'subagent',
    leverframeRoutingBinding: 'opaque-specialist-binding',
    leverframeRoutingPolicyModel: 'concrete-router',
  } }, null);

  expect(request.model).toBe('opaque-specialist-binding');
});

it('keeps auto in the startup model state when its concrete target is eligible', () => {
  const { functions } = mainRouter(['concrete-router']);

  const result = functions.iQo(cliModel('auto'));

  expect(result.initialMainLoopModel).toBe('auto');
  expect(result.resolvedInitialModel).toBe('auto');
});

it('fails startup instead of falling back when the concrete router target is denied', () => {
  const { functions } = mainRouter(['another-allowed-model']);

  expect(() => functions.iQo(cliModel('auto'))).toThrow();
});

it('checks the concrete target even when the sourced plan shortcut would bypass its allowlist check', () => {
  const harness = mainRouter(['another-allowed-model']);

  expect(() => harness.functions._p({ userSpecifiedModel: 'auto', permissionMode: 'default' })).toThrow();
  expect(harness.restrictionChecks).toContain('concrete-router');
});

it('fails before prompt preparation when plan mode substitutes a different runtime model', () => {
  const { functions } = mainRouter(['concrete-router'], 'plan-substitute-model');

  expect(() => functions._p({ userSpecifiedModel: 'auto', permissionMode: 'plan' })).toThrow();
});

it('applies the frozen target map through the full patcher twice and verifies it semantically', () => {
  const sourceModules = splitModulePayload(claudeAgentRoutingNoticeCompositionSource());
  expect(sourceModules).not.toBeNull();
  const adapterModule = sourceModules!.find(([name]) => name === '/$bunfs/root/chunk-f5200rjz.js')!;
  adapterModule[1] = `${patcherShell}\n${adapterModule[1]}`;
  const source = sourceModules!.map(([name, content]) => `${CLAUDE_MODULE_BOUNDARY}${name}\n${content}`).join('');
  const metadata = { contextWindow: 90_000, maxOutputTokens: 12_000, supportedReasoningEfforts: ['low', 'medium'] };
  const specialistModel = 'claude-specialist-from-host-catalog';
  const specialistMetadata = { contextWindow: 38_000, maxOutputTokens: 3_200, supportedReasoningEfforts: ['low'] };
  const config = { auto: {
    routingEnabled: true as const,
    routingPolicyModelId: 'concrete-router',
    routingPromptPolicy: ROUTING_TEST_PROMPT_POLICY,
    routingMetadata: metadata,
    routingTargetMetadata: { [specialistModel]: specialistMetadata },
  } };
  const first = applyLeverframePatches(source, config);
  expect(first.content, JSON.stringify(first.results)).not.toBe(source);
  expect(first.results.some(result => result.status === 'FAIL')).toBe(false);
  const second = applyLeverframePatches(first.content, config);
  expect(second.content).toBe(first.content);
  expect(second.results.some(result => result.status === 'FAIL')).toBe(false);
  const verified = verifyPatchSites(second.content, config);
  const { functions } = mainRouter(['concrete-router'], undefined, undefined, transformOptions, false, second.content, true);

  expect(verified.complete).toBe(true);
  expect(verified.results.every(result => result.status !== 'FAIL')).toBe(true);
  expect(functions.ro('auto', { allowlist: ['concrete-router'] })).toBe(true);
  expect(functions.Ut('auto')).toBe('auto');
  expect(functions.yUe('auto')).toMatchObject({ id: 'concrete-router', context_window: 90_000 });
  expect(functions.nkn('auto')).toBe('low');
  expect(functions.yUe(specialistModel)).toMatchObject({ id: specialistModel, context_window: 38_000,
    runtime: { max_input_tokens: 38_000, max_output_tokens: 3_200, effort_levels: ['low'] } });
});
