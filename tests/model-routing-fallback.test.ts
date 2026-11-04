import { dirname, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { buildRoutingCatalog } from '../src/model-routing.js';
import type { ModelRef, RoutingConfig } from '../src/model-routing.js';
import { MAX_DOCUMENT_BYTES } from '../src/checkpoint-store.js';
import { advanceRoutingFallback, createRoutingBinding, listRoutingNotices, resolveRoutingBinding, routingBindingErrors,
  routingBindingStatePath, routingReplayAllowed, withRoutingLease } from '../src/routing-bindings.js';
import type { RoutingAttemptFailure, RoutingFallbackInput, RoutingBinding, RoutingAuthorizedTarget } from '../src/routing-bindings.js';
import { routingReplayCompatibility } from '../src/routing-replay-compatibility.js';
import { input, observation, provider } from './model-routing-fixtures.js';

const testHome = process.env['LEVERFRAME_TEST_HOME'];
const workload = { input: 120, output: 40, cacheRead: 0, cacheWrite: 0 };
const requirements = { capabilities: [], contextTokens: 1_000 };

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function refs() {
  return {
    initial: { providerId: 'fallback-primary-provider', modelId: 'fallback-primary-model' },
    shared: { providerId: 'fallback-shared-provider', modelId: 'fallback-shared-model' },
    router: { providerId: 'fallback-router-provider', modelId: 'fallback-router-model' },
    specialist: { providerId: 'fallback-specialist-provider', modelId: 'fallback-specialist-model' },
    later: { providerId: 'fallback-later-provider', modelId: 'fallback-later-model' },
  } satisfies Record<string, ModelRef>;
}

function catalogFor(models: ModelRef[], available: ModelRef[] = models, oversizedPricingFor?: ModelRef) {
  const availableKeys = new Set(available.map(ref => `${ref.providerId}/${ref.modelId}`));
  const providers = models.map(ref => provider({
    id: ref.providerId,
    templateId: 'fallback-test',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [{
      id: ref.modelId,
      name: ref.modelId,
      upstreamModelId: `upstream-${ref.modelId}`,
      modelFormat: 'anthropic',
      contextWindow: 90_000,
      outputTokenLimit: 12_000,
      supportedReasoningEfforts: ['low'],
      ...(oversizedPricingFor?.providerId === ref.providerId && oversizedPricingFor.modelId === ref.modelId
        ? { pricing: { source: 'fallback-test-pricing', tiers: [{ label: 'x'.repeat(MAX_DOCUMENT_BYTES) }] } }
        : {}),
    }] },
  }));
  return buildRoutingCatalog(input(providers, {
    credentials: models.map(ref => ({ ...observation(ref.providerId),
      available: availableKeys.has(`${ref.providerId}/${ref.modelId}`) })),
    discovery: models.map(ref => ({ providerId: ref.providerId, status: 'live' as const,
      cacheFetchedAt: '2026-10-01T00:00:00.000Z' })),
  }));
}

type FallbackCandidates = ReturnType<typeof refs>;

function configFor(role: 'router' | 'specialist', refs: FallbackCandidates, additions: Partial<RoutingConfig> = {}): RoutingConfig {
  const base: RoutingConfig = role === 'router'
    ? { enabled: true, cheapFallback: refs.initial, routerFallbacks: [refs.router, refs.later] }
    : { enabled: true, categories: { implementation: { target: refs.initial, fallbacks: [refs.specialist, refs.later] } } };
  return { ...base, ...additions };
}

async function createJob(role: 'router' | 'specialist', candidates = refs()) {
  const sessionId = `fallback-session-${randomUUID()}`;
  const launchId = `fallback-launch-${randomUUID()}`;
  const catalog = catalogFor(Object.values(candidates));
  const config = configFor(role, candidates);
  const statePath = routingBindingStatePath(sessionId);
  expect(testHome).toBeTruthy();
  expect(inside(testHome!, dirname(statePath))).toBe(true);
  const binding = await createRoutingBinding({ sessionId, launchId, role,
    ...(role === 'specialist' ? { category: 'implementation' } : {}), task: 'Complete the reviewed task.',
    config, catalog, workload, requirements });
  return { sessionId, launchId, binding, catalog, config, candidates };
}

function failure(reason: RoutingAttemptFailure['reason'], overrides: Partial<RoutingAttemptFailure> = {}): RoutingAttemptFailure {
  return { reason, acceptance: 'rejected', response: 'clear', output: 'none', tool: 'none', ...overrides };
}

function nativeRequest() {
  return {
    model: 'visible-model',
    max_tokens: workload.output,
    system: [{ type: 'text', text: 'Follow the reviewed task.' }],
    messages: [{ role: 'user', content: 'Continue the approved work.' }],
    tools: [{ name: 'Agent', description: 'Delegate a reviewed task.', input_schema: {
      type: 'object', properties: { task: { type: 'string' } }, required: ['task'],
    } }],
  };
}

const nativeTransport = { source: 'native-anthropic', target: 'native-anthropic' };

it.each([
  { label: 'a request without thinking state', request: nativeRequest() },
  { label: 'a request with explicitly disabled thinking', request: { ...nativeRequest(), thinking: { type: 'disabled' } } },
])('permits the Agent tool schema on $label for native fallback', ({ request }) => {
  expect(routingReplayCompatibility(request, nativeTransport)).toEqual({ ok: true });
});

it.each([
  { label: 'unmatched tool-use history', request: { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'Agent', input: {} }] }] } },
  { label: 'unmatched tool-result history', request: { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'done' }] }] } },
  { label: 'thinking history', request: { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'internal' }] }] } },
  { label: 'redacted thinking history', request: { messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'opaque' }] }] } },
  { label: 'signed history', request: { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'accepted', signature: 'signed-state' }] }] } },
  { label: 'non-text history', request: { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'image-data' } }] }] } },
  { label: 'provider-managed context', request: { context_management: { edits: [] } } },
  { label: 'unrecognized request fields', request: { vendor_private_state: { value: 'opaque' } } },
])('refuses fallback after $label', ({ request }) => {
  expect(routingReplayCompatibility({ ...nativeRequest(), ...request }, nativeTransport).ok).toBe(false);
});

it('allows native-to-native replay after a completed tool turn', () => {
  const request = { ...nativeRequest(), messages: [
    { role: 'user', content: 'Start the reviewed task.' },
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'call-one', name: 'Agent', input: { task: 'Inspect the first item.' } },
      { type: 'tool_use', id: 'call-two', name: 'Agent', input: { task: 'Inspect the second item.' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call-one', content: 'First item is valid.' },
      { type: 'tool_result', tool_use_id: 'call-two', content: 'Second item is valid.' },
      { type: 'text', text: 'Continue with both results.' },
    ] },
  ] };

  expect(routingReplayCompatibility(request, nativeTransport)).toEqual({ ok: true });
});

it.each([
  { label: 'an unknown tool name', messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'UnknownTool', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'done' }] },
  ] },
  { label: 'a duplicate tool-use ID', messages: [
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'call', name: 'Agent', input: {} },
      { type: 'tool_use', id: 'call', name: 'Agent', input: {} },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'done' }] },
  ] },
  { label: 'an unresolved tool-result ID', messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call-one', name: 'Agent', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-two', content: 'done' }] },
  ] },
  { label: 'text before the first tool result', messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call-one', name: 'Agent', input: {} }] },
    { role: 'user', content: [
      { type: 'text', text: 'Tool result follows.' },
      { type: 'tool_result', tool_use_id: 'call-one', content: 'done' },
    ] },
  ] },
  { label: 'text between parallel tool results', messages: [
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'call-one', name: 'Agent', input: {} },
      { type: 'tool_use', id: 'call-two', name: 'Agent', input: {} },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call-one', content: 'first' },
      { type: 'text', text: 'One result remains.' },
      { type: 'tool_result', tool_use_id: 'call-two', content: 'second' },
    ] },
  ] },
  { label: 'parallel results split across user messages', messages: [
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'call-one', name: 'Agent', input: {} },
      { type: 'tool_use', id: 'call-two', name: 'Agent', input: {} },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-one', content: 'first' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-two', content: 'second' }] },
  ] },
  { label: 'a result before its assistant tool use', messages: [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-one', content: 'done' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call-one', name: 'Agent', input: {} }] },
  ] },
])('refuses native replay with $label', ({ messages }) => {
  expect(routingReplayCompatibility({ ...nativeRequest(), messages }, nativeTransport).ok).toBe(false);
});

it.each([
  { source: 'native-anthropic', target: 'openai-compatible' },
  { source: 'openai-compatible', target: 'native-anthropic' },
])('rejects completed native tool history across $source to $target', ({ source, target }) => {
  const request = { ...nativeRequest(), messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'Agent', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'done' }] },
  ] };

  expect(routingReplayCompatibility(request, { source, target })).toMatchObject({
    ok: false, reason: 'provider_bound_history',
  });
});

it('refuses request-level thinking before native fallback', () => {
  expect(routingReplayCompatibility({ ...nativeRequest(), thinking: { type: 'enabled', budget_tokens: 100 } }, nativeTransport).ok).toBe(false);
});

it.each([
  { source: 'sdk-openai', target: 'native-anthropic' },
  { source: 'native-anthropic', target: 'sdk-openai' },
])('keeps fallback disabled for an SDK $source to $target transport', ({ source, target }) => {
  expect(routingReplayCompatibility(nativeRequest(), { source, target }).ok).toBe(false);
});

it('leaves the request unchanged while checking fallback compatibility', () => {
  const request = nativeRequest();
  const before = structuredClone(request);

  routingReplayCompatibility(request, nativeTransport);

  expect(request).toEqual(before);
});

function fallbackInput(binding: RoutingBinding, leaseId: string, catalog: ReturnType<typeof catalogFor>,
  failureResult: RoutingAttemptFailure, options: { signal?: AbortSignal; deadline?: number } = {}): RoutingFallbackInput {
  return { sessionId: binding.sessionId, modelId: binding.id, leaseId, revision: binding.revision,
    failure: failureResult, catalog, workload, requirements, maxOutputTokens: workload.output,
    deadline: options.deadline ?? Date.parse(binding.expiresAt), signal: options.signal ?? new AbortController().signal };
}

it.each([
  { label: 'explicit quota rejection', failure: failure('quota_exhausted'), allowed: true },
  { label: 'a request that was not sent', failure: failure('credential_missing', { acceptance: 'not_sent' }), allowed: true },
  { label: 'an unrelated provider error', failure: { ...failure('quota_exhausted'), reason: 'bad_request' } as unknown as RoutingAttemptFailure, allowed: false },
  { label: 'unknown acceptance', failure: failure('credit_exhausted', { acceptance: 'unknown' }), allowed: false },
  { label: 'a committed response', failure: failure('credential_rejected', { response: 'committed' }), allowed: false },
  { label: 'an ambiguous response', failure: failure('quota_exhausted', { response: 'unknown' }), allowed: false },
  { label: 'emitted output', failure: failure('credit_exhausted', { output: 'emitted' }), allowed: false },
  { label: 'ambiguous output', failure: failure('credential_missing', { output: 'unknown' }), allowed: false },
  { label: 'emitted tool activity', failure: failure('credential_rejected', { tool: 'emitted' }), allowed: false },
  { label: 'ambiguous tool activity', failure: failure('quota_exhausted', { tool: 'unknown' }), allowed: false },
])('allows replay only when $label proves an unaccepted availability failure', ({ failure: failed, allowed }) => {
  expect(routingReplayAllowed(failed)).toBe(allowed);
});

it.each([
  { reason: 'credential_missing' as const, available: false },
  { reason: 'credential_rejected' as const, available: true },
  { reason: 'quota_exhausted' as const, available: true },
  { reason: 'credit_exhausted' as const, available: true },
])('advances to the authorized replacement after $reason', async ({ reason, available }) => {
  const job = await createJob('specialist');
  const currentCatalog = catalogFor(Object.values(job.candidates), available
    ? Object.values(job.candidates) : [job.candidates.shared, job.candidates.router, job.candidates.specialist]);

  const updated = await withRoutingLease({ sessionId: job.sessionId, modelId: job.binding.id }, async leased =>
    advanceRoutingFallback(fallbackInput(leased, leased.lease!, currentCatalog, failure(reason))));

  expect(updated.decision.target).toEqual(job.candidates.specialist);
  expect(updated.revision).toBe(job.binding.revision + 1);
  expect(updated.decision.estimate.kind).toBe('unknown');
  expect(updated.pendingNotice).toMatchObject({ sessionId: job.sessionId, modelId: job.binding.id,
    previous: job.candidates.initial, target: job.candidates.specialist, reason, role: 'specialist',
    category: 'implementation', effort: null,
    policy: updated.decision.policy, policyVersion: updated.decision.policyVersion,
    estimate: updated.decision.estimate, cacheReuse: 'unknown', revision: updated.revision, acknowledged: false });
  expect(JSON.stringify(updated.pendingNotice)).not.toContain('Complete the reviewed task.');
});

it.each([
  { label: 'committed response', failure: failure('quota_exhausted', { response: 'committed' }) },
  { label: 'output emission', failure: failure('credit_exhausted', { output: 'emitted' }) },
  { label: 'tool emission', failure: failure('credential_rejected', { tool: 'emitted' }) },
  { label: 'ambiguous acceptance', failure: failure('credential_missing', { acceptance: 'unknown' }) },
  { label: 'ambiguous response', failure: failure('quota_exhausted', { response: 'unknown' }) },
  { label: 'ambiguous output', failure: failure('credit_exhausted', { output: 'unknown' }) },
])('keeps the binding on its current model after $label', async ({ failure: failedAttempt }) => {
  const job = await createJob('specialist');
  const currentCatalog = catalogFor(Object.values(job.candidates));

  await withRoutingLease({ sessionId: job.sessionId, modelId: job.binding.id }, async leased => {
    await expect(advanceRoutingFallback(fallbackInput(leased, leased.lease!, currentCatalog, failedAttempt))).rejects.toThrow();
  });

  const unchanged = await resolveRoutingBinding({ sessionId: job.sessionId, modelId: job.binding.id });
  expect(unchanged.decision.target).toEqual(job.binding.decision.target);
  expect(unchanged.revision).toBe(job.binding.revision);
});

it('requires the lease that owns the binding before changing its model', async () => {
  const job = await createJob('specialist');

  await withRoutingLease({ sessionId: job.sessionId, modelId: job.binding.id }, async leased => {
    await expect(advanceRoutingFallback(fallbackInput(leased, `${leased.lease}-other`, job.catalog,
      failure('quota_exhausted')))).rejects.toThrow();
  });

  const unchanged = await resolveRoutingBinding({ sessionId: job.sessionId, modelId: job.binding.id });
  expect(unchanged.decision.target).toEqual(job.binding.decision.target);
  expect(unchanged.revision).toBe(job.binding.revision);
});

it('skips an authorized target the transport predicate cannot serve', async () => {
  const job = await createJob('specialist');

  const updated = await withRoutingLease({ sessionId: job.sessionId, modelId: job.binding.id }, async leased => {
    const candidateAllowed = (target: RoutingAuthorizedTarget) => target.providerId !== job.candidates.specialist.providerId;
    const input = { ...fallbackInput(leased, leased.lease!, job.catalog, failure('quota_exhausted')), candidateAllowed };
    return advanceRoutingFallback(input as RoutingFallbackInput & { candidateAllowed: typeof candidateAllowed });
  });

  expect(updated.decision.target).toEqual(job.candidates.later);
  expect(updated.decision.events).toContainEqual(expect.objectContaining({
    target: job.candidates.specialist, reason: expect.any(String),
  }));
});

it('keeps the frozen authorization unchanged when the transport predicate mutates its candidate', async () => {
  const job = await createJob('specialist');
  const authorization = structuredClone(job.binding.fallbackAuthorization);
  let predicateCalls = 0;

  const updated = await withRoutingLease({ sessionId: job.sessionId, modelId: job.binding.id }, async leased => {
    const candidateAllowed = (target: RoutingAuthorizedTarget) => {
      predicateCalls++;
      Object.assign(target, { providerId: 'unconfigured-provider', modelId: 'unconfigured-model' });
      return true;
    };
    const input = { ...fallbackInput(leased, leased.lease!, job.catalog, failure('quota_exhausted')), candidateAllowed };
    return advanceRoutingFallback(input as RoutingFallbackInput & { candidateAllowed: typeof candidateAllowed });
  });
  const persisted = await resolveRoutingBinding({ sessionId: job.sessionId, modelId: job.binding.id });

  expect(predicateCalls).toBeGreaterThan(0);
  expect(updated.decision.target).toEqual(job.candidates.specialist);
  expect(persisted.fallbackAuthorization).toEqual(authorization);
});

it('does not enter a replacement attempt while its notice remains unacknowledged', async () => {
  const job = await createJob('specialist');
  await withRoutingLease({ sessionId: job.sessionId, modelId: job.binding.id }, async leased =>
    advanceRoutingFallback(fallbackInput(leased, leased.lease!, job.catalog, failure('quota_exhausted'))));
  let replacementAttempts = 0;

  await expect(withRoutingLease({ sessionId: job.sessionId, modelId: job.binding.id }, async () => {
    replacementAttempts++;
  })).rejects.toThrow();

  expect(replacementAttempts).toBe(0);
});

it('leaves the binding unchanged when its parent request is cancelled', async () => {
  const job = await createJob('specialist');
  const abort = new AbortController();
  abort.abort();

  await withRoutingLease({ sessionId: job.sessionId, modelId: job.binding.id }, async leased => {
    await expect(advanceRoutingFallback(fallbackInput(leased, leased.lease!, job.catalog,
      failure('quota_exhausted'), { signal: abort.signal }))).rejects.toThrow();
  });

  const unchanged = await resolveRoutingBinding({ sessionId: job.sessionId, modelId: job.binding.id });
  expect(unchanged.decision.target).toEqual(job.binding.decision.target);
  expect(unchanged.revision).toBe(job.binding.revision);
});

it('leaves the binding unchanged after its absolute request deadline', async () => {
  const job = await createJob('specialist');

  await withRoutingLease({ sessionId: job.sessionId, modelId: job.binding.id }, async leased => {
    await expect(advanceRoutingFallback(fallbackInput(leased, leased.lease!, job.catalog,
      failure('quota_exhausted'), { deadline: Date.now() - 1 }))).rejects.toThrow();
  });

  const unchanged = await resolveRoutingBinding({ sessionId: job.sessionId, modelId: job.binding.id });
  expect(unchanged.decision.target).toEqual(job.binding.decision.target);
  expect(unchanged.revision).toBe(job.binding.revision);
});

it.each([
  { role: 'router' as const, expected: 'router' as const },
  { role: 'specialist' as const, expected: 'specialist' as const },
])('uses the $role fallback chain for that job role', async ({ role, expected }) => {
  const job = await createJob(role);

  const updated = await withRoutingLease({ sessionId: job.sessionId, modelId: job.binding.id }, async leased =>
    advanceRoutingFallback(fallbackInput(leased, leased.lease!, job.catalog, failure('quota_exhausted'))));

  expect(updated.decision.target).toEqual(job.candidates[expected]);
});

it('skips an already selected model and refuses an exhausted fallback chain', async () => {
  const candidates = refs();
  const sessionId = `fallback-session-${randomUUID()}`;
  const catalog = catalogFor(Object.values(candidates));
  const config = { enabled: true, categories: { implementation: { target: candidates.initial,
    fallbacks: [candidates.initial] } } } satisfies RoutingConfig;
  const binding = await createRoutingBinding({ sessionId, launchId: `fallback-launch-${randomUUID()}`, role: 'specialist',
    category: 'implementation', task: 'Complete the reviewed task.', config, catalog, workload, requirements });
  expect(testHome).toBeTruthy();
  expect(inside(testHome!, dirname(routingBindingStatePath(sessionId)))).toBe(true);

  await withRoutingLease({ sessionId, modelId: binding.id }, async leased => {
    await expect(advanceRoutingFallback(fallbackInput(leased, leased.lease!, catalog, failure('quota_exhausted')))).rejects.toThrow();
  });

  const unchanged = await resolveRoutingBinding({ sessionId, modelId: binding.id });
  expect(unchanged.decision.target).toEqual(binding.decision.target);
  expect(unchanged.revision).toBe(binding.revision);
});

it('keeps the launch authorized fallback after configuration changes on resume', async () => {
  const job = await createJob('specialist');
  const changedConfig = configFor('specialist', job.candidates, {
    categories: { implementation: { target: job.candidates.initial, fallbacks: [job.candidates.router] } },
  });
  const resumed = await createRoutingBinding({ sessionId: job.sessionId, launchId: job.launchId, role: 'specialist',
    category: 'implementation', task: 'Complete the reviewed task.', config: changedConfig,
    catalog: job.catalog, workload, requirements, resume: true });

  const updated = await withRoutingLease({ sessionId: job.sessionId, modelId: resumed.id }, async leased =>
    advanceRoutingFallback(fallbackInput(leased, leased.lease!, job.catalog, failure('quota_exhausted'))));

  expect(updated.decision.target).toEqual(job.candidates.specialist);
});

it('retains a resolved fallback whose credentials are missing at launch', async () => {
  const candidates = refs();
  const sessionId = `fallback-session-${randomUUID()}`;
  const launchId = `fallback-launch-${randomUUID()}`;
  const initialCatalog = catalogFor(Object.values(candidates), [candidates.initial]);
  expect(testHome).toBeTruthy();
  expect(inside(testHome!, dirname(routingBindingStatePath(sessionId)))).toBe(true);
  const binding = await createRoutingBinding({ sessionId, launchId, role: 'specialist', category: 'implementation',
    task: 'Complete the reviewed task.', config: configFor('specialist', candidates), catalog: initialCatalog, workload, requirements });
  const currentCatalog = catalogFor(Object.values(candidates));

  const updated = await withRoutingLease({ sessionId, modelId: binding.id }, async leased =>
    advanceRoutingFallback(fallbackInput(leased, leased.lease!, currentCatalog, failure('quota_exhausted'))));

  expect(updated.decision.target).toEqual(candidates.specialist);
});

it('rejects a configured fallback that has no resolved model record', async () => {
  const candidates = refs();
  const sessionId = `fallback-session-${randomUUID()}`;
  const unknown = { providerId: 'fallback-unresolved-provider', modelId: 'fallback-unresolved-model',
    upstreamModelId: 'claimed-upstream-identity' } as ModelRef;
  const config = { enabled: true, categories: { implementation: { target: candidates.initial,
    fallbacks: [unknown, candidates.specialist] } } } satisfies RoutingConfig;
  expect(testHome).toBeTruthy();
  expect(inside(testHome!, dirname(routingBindingStatePath(sessionId)))).toBe(true);

  await expect(createRoutingBinding({ sessionId, launchId: `fallback-launch-${randomUUID()}`, role: 'specialist',
    category: 'implementation', task: 'Complete the reviewed task.', config,
    catalog: catalogFor([candidates.initial, candidates.specialist]), workload, requirements })).rejects.toThrow();
});

it('rejects a router launch with a configured unresolved cheap floor', async () => {
  const candidates = refs();
  const sessionId = `fallback-session-${randomUUID()}`;
  const unresolvedFloor = { providerId: 'fallback-floor-unresolved-provider', modelId: 'fallback-floor-unresolved-model' };
  const config = configFor('router', candidates, { cheapFloor: unresolvedFloor });
  expect(testHome).toBeTruthy();
  expect(inside(testHome!, dirname(routingBindingStatePath(sessionId)))).toBe(true);

  await expect(createRoutingBinding({ sessionId, launchId: `fallback-launch-${randomUUID()}`, role: 'router',
    task: 'Complete the reviewed task.', config, catalog: catalogFor(Object.values(candidates)), workload, requirements,
  })).rejects.toBeInstanceOf(Error);
});

it('rejects a specialist binding when selector default resolution reaches an unresolved router floor', async () => {
  const candidates = refs();
  const sessionId = `fallback-session-${randomUUID()}`;
  const unresolvedFloor = { providerId: 'fallback-selector-floor-provider', modelId: 'fallback-selector-floor-model' };
  const config = configFor('specialist', candidates, { cheapFloor: unresolvedFloor,
    selector: { enabled: true, maxExtraCallsPerTask: 1 } });
  expect(testHome).toBeTruthy();
  expect(inside(testHome!, dirname(routingBindingStatePath(sessionId)))).toBe(true);

  await expect(createRoutingBinding({ sessionId, launchId: `fallback-launch-${randomUUID()}`, role: 'specialist',
    category: 'implementation', task: 'Complete the reviewed task.', config,
    catalog: catalogFor(Object.values(candidates)), workload, requirements,
  })).rejects.toBeInstanceOf(Error);
});

it('fails closed when the current catalog loses an earlier authorized fallback', async () => {
  const job = await createJob('specialist');
  const currentCatalog = catalogFor([job.candidates.initial, job.candidates.later]);
  let predicateCalls = 0;

  await withRoutingLease({ sessionId: job.sessionId, modelId: job.binding.id }, async leased => {
    const candidateAllowed = (_target: RoutingAuthorizedTarget) => { predicateCalls++; return false; };
    const input = { ...fallbackInput(leased, leased.lease!, currentCatalog, failure('quota_exhausted')), candidateAllowed };
    await expect(advanceRoutingFallback(input as RoutingFallbackInput & { candidateAllowed: typeof candidateAllowed })).rejects.toThrow();
  });

  const unchanged = await resolveRoutingBinding({ sessionId: job.sessionId, modelId: job.binding.id });
  expect(predicateCalls).toBe(0);
  expect(unchanged.decision.target).toEqual(job.binding.decision.target);
  expect(unchanged.revision).toBe(job.binding.revision);
});

it('keeps the binding and notice journal unchanged when the next snapshot exceeds storage capacity', async () => {
  const job = await createJob('specialist');
  const oversizedCatalog = catalogFor(Object.values(job.candidates), Object.values(job.candidates), job.candidates.specialist);

  await withRoutingLease({ sessionId: job.sessionId, modelId: job.binding.id }, async leased => {
    await expect(advanceRoutingFallback(fallbackInput(leased, leased.lease!, oversizedCatalog,
      failure('quota_exhausted')))).rejects.toMatchObject({ code: routingBindingErrors.capacity });
  });

  const unchanged = await resolveRoutingBinding({ sessionId: job.sessionId, modelId: job.binding.id });
  expect(unchanged.decision.target).toEqual(job.binding.decision.target);
  expect(unchanged.revision).toBe(job.binding.revision);
  expect(listRoutingNotices(job.sessionId, 0)).toEqual([]);
});
