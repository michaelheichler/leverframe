import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { routingMeasuredCost, routingSdkUsage, writeRoutingInferenceLog } from '../src/routing-inference-log.js';
import { estimateCurrentRoutingRequest } from '../src/routing-request-estimate.js';
import { buildRoutingCatalog, type CostSnapshot } from '../src/model-routing-catalog.js';
import { httpProxyModelId } from '../src/http-proxy/routes.js';
import { createSelectorTrace, decodeSelectorTrace, encodeSelectorTrace, logSelectorOutcome, selectorCostSnapshot,
  selectorTargetForAlias, writeSelectorTrace } from '../src/routing-selector-log.js';
import type { ResponseUsage } from '../src/http-proxy/response-usage.js';
import type { RoutingConfig } from '../src/model-routing.js';
import { createRoutingBinding, routingBindingEvents } from '../src/routing-bindings.js';
import { getAppHome } from '../src/paths.js';
import type { RoutingAttemptFailure } from '../src/routing-fallback-contract.js';
import { cachedModel, input, observation, provider } from './model-routing-fixtures.js';

const testHome = process.env['LEVERFRAME_TEST_HOME'];

it.each([
  { label: 'known', priceModel: 'known-upstream-model', estimate: 'known', requestEstimate: 'known',
    requestBody: { max_tokens: 50, messages: [{ role: 'user', content: 'REQUEST_BODY_SECRET_SENTINEL' }] }, modelFields: {
      pricing: { input: 2, output: 8, source: 'fixture-pricing' },
    } },
  { label: 'unknown rates', priceModel: 'routing-fixture-incomplete', estimate: 'unknown', requestEstimate: 'unknown',
    requestBody: { max_tokens: 50, messages: [{ role: 'user', content: 'REQUEST_BODY_SECRET_SENTINEL' }] }, modelFields: {} },
  { label: 'cache-marked request', priceModel: 'known-upstream-model', estimate: 'known', requestEstimate: 'unknown',
    requestBody: { max_tokens: 50, messages: [{ role: 'user', content: 'REQUEST_BODY_SECRET_SENTINEL',
      cache_control: { type: 'ephemeral' } }] }, modelFields: {
      pricing: { input: 2, output: 8, source: 'fixture-pricing' },
    } },
  { label: 'missing output bound', priceModel: 'known-upstream-model', estimate: 'known', requestEstimate: 'unknown',
    requestBody: { messages: [{ role: 'user', content: 'REQUEST_BODY_SECRET_SENTINEL' }] }, modelFields: {
      pricing: { input: 2, output: 8, source: 'fixture-pricing' },
    } },
])('projects a $label estimate and safe fallback fields to the custom routing log', async scenario => {
  if (!testHome) throw new Error('The isolated test home is required.');
  const providerId = 'fixture/log-provider:Δ';
  const modelId = 'model/α:beta';
  const upstreamModelId = scenario.priceModel;
  const fetchedAt = '2026-10-01T00:00:00.000Z';
  const ref = { providerId, modelId };
  const supplied = provider({ id: providerId, templateId: 'anthropic-api', authRef: 'keyring:CREDENTIAL_SECRET_SENTINEL',
    authType: 'api', api: { url: 'https://fixture.invalid', npm: '@ai-sdk/anthropic' },
    modelsCache: { fetchedAt, source: 'account', models: [{ id: modelId, name: modelId,
      upstreamModelId, modelFormat: 'anthropic', contextWindow: 80_000, outputTokenLimit: 10_000,
      supportedReasoningEfforts: ['low'], supportedParameters: ['tools'], ...scenario.modelFields }] },
  });
  const catalog = buildRoutingCatalog(input([supplied], { credentials: [observation(providerId, 'api_key')],
    discovery: [{ providerId, status: 'live', cacheFetchedAt: fetchedAt }] }));
  const workload = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 };
  const config: RoutingConfig = { enabled: true, cheapFallback: ref, routerFallbacks: [], pool: [ref] };
  const binding = await createRoutingBinding({ sessionId: `session-${randomUUID()}`, launchId: 'signature-secret-sentinel',
    role: 'router', task: 'PROMPT_SECRET_SENTINEL HANDOFF_SECRET_SENTINEL', config, catalog, workload });
  const logPath = join(getAppHome(), `routing-inference-${scenario.estimate}-${scenario.label}.jsonl`);
  expect(relative(testHome, getAppHome())).not.toMatch(/^\.\.(?:\/|$)/);
  expect(relative(testHome, dirname(logPath))).not.toMatch(/^\.\.(?:\/|$)/);
  const failure = {
    reason: 'credential_rejected', acceptance: 'rejected', response: 'clear', output: 'none', tool: 'none',
    rawPrompt: 'PROMPT_SECRET_SENTINEL', rawHeaders: 'HEADER_SECRET_SENTINEL',
    credential: 'CREDENTIAL_SECRET_SENTINEL', signature: 'SIGNATURE_SECRET_SENTINEL',
  } satisfies RoutingAttemptFailure & Record<string, unknown>;

  const requestEstimate = estimateCurrentRoutingRequest(binding, scenario.requestBody);
  const options = {
    failure, previous: { providerId: 'previous/provider:β', modelId: 'previous/model:γ' }, durationMs: 31,
    usage: { usageStage: 'message_delta' as const, inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0, totalInputTokens: 100 },
    requestEstimate,
  };
  writeRoutingInferenceLog(logPath, 'fallback_proposed', 'request-log-fixture-01', 2, binding, options);

  const content = readFileSync(logPath, 'utf8');
  const [entry] = content.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  expect(entry).toMatchObject({ event: 'routing_fallback_proposed', requestId: 'request-log-fixture-01', attempt: 2,
    provider: providerId, model: modelId, previousProvider: 'previous/provider:β', previousModel: 'previous/model:γ',
    revision: binding.revision, role: 'router', policy: 'execution', policyVersion: '1',
    failureReason: 'credential_rejected', acceptance: 'rejected', response: 'clear', output: 'none', tool: 'none',
    estimate: { kind: scenario.estimate, unit: 'estimated_api_equivalent_usd', basis: 'binding_snapshot' },
    requestEstimate: { kind: scenario.requestEstimate, unit: 'estimated_api_equivalent_usd', basis: 'pre_policy_serialized_bytes' },
    measuredApiEquivalent: scenario.estimate === 'known'
      ? { kind: 'known', amount: 0.0006, currency: 'USD', basis: 'provider_usage' }
      : { kind: 'unknown', currency: 'USD', basis: 'provider_usage' },
    usageIsCumulative: true,
    actualBilling: 'unknown', subscriptionConsumption: 'unknown' });
  expect(content).not.toContain('session-secret-sentinel');
  expect(content).not.toContain('signature-secret-sentinel');
  expect(content).not.toContain('PROMPT_SECRET_SENTINEL');
  expect(content).not.toContain('HANDOFF_SECRET_SENTINEL');
  expect(content).not.toContain('REQUEST_BODY_SECRET_SENTINEL');
  expect(content).not.toContain('HEADER_SECRET_SENTINEL');
  expect(content).not.toContain('CREDENTIAL_SECRET_SENTINEL');
  expect(content).not.toContain('SIGNATURE_SECRET_SENTINEL');
});

it('estimates each serialized request size without changing the routing binding', async () => {
  const providerId = 'fixture/request-cost-provider';
  const modelId = 'fixture/request-cost-model';
  const fetchedAt = '2026-10-01T00:00:00.000Z';
  const supplied = provider({ id: providerId, templateId: 'anthropic-api',
    modelsCache: { fetchedAt, models: [{ id: modelId, name: modelId, upstreamModelId: modelId,
      modelFormat: 'anthropic', contextWindow: 80_000, outputTokenLimit: 10_000,
      pricing: { input: 2, output: 8, source: 'fixture-pricing' } }] } });
  const catalog = buildRoutingCatalog(input([supplied], { credentials: [observation(providerId, 'api_key')],
    discovery: [{ providerId, status: 'live', cacheFetchedAt: fetchedAt }] }));
  const ref = { providerId, modelId };
  const binding = await createRoutingBinding({ sessionId: `session-${randomUUID()}`, launchId: 'request-cost-launch',
    role: 'router', task: 'request size comparison', config: { enabled: true, cheapFallback: ref, routerFallbacks: [], pool: [ref] },
    catalog, workload: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } });
  const smallerBody = { max_tokens: 50, messages: [{ role: 'user', content: 'REQUEST_BODY_SECRET_SENTINEL' }] };
  const largerBody = { max_tokens: 50, messages: [{ role: 'user', content: 'REQUEST_BODY_SECRET_SENTINEL '.repeat(80) }] };
  const bindingBefore = JSON.stringify(binding);
  const estimates = [smallerBody, largerBody].map(body => estimateCurrentRoutingRequest(binding, body));

  expect(estimates[0]).toMatchObject({ kind: 'known' });
  expect(estimates[1]).toMatchObject({ kind: 'known' });
  expect(estimates[1]?.amount ?? 0).toBeGreaterThan(estimates[0]?.amount ?? 0);
  expect(JSON.stringify(binding)).toBe(bindingBefore);
  expect(JSON.stringify(estimates)).not.toContain('REQUEST_BODY_SECRET_SENTINEL');
});

it('prices complete cumulative usage without counting aggregate and split cache writes twice', () => {
  const snapshot = { kind: 'known', currency: 'USD', unit: 'per-million-tokens', input: 2, output: 8,
    cacheRead: 0.2, cacheWrites: [{ ttlSeconds: 300, rate: 1.25 }, { ttlSeconds: 3600, rate: 2 }],
    substituted: false, freshness: 'current' } satisfies CostSnapshot;
  const measured = routingMeasuredCost(snapshot, { usageStage: 'message_delta', inputTokens: 100, outputTokens: 10,
    cacheReadInputTokens: 5, cacheCreationInputTokens: 6, cacheCreation5mInputTokens: 2,
    cacheCreation1hInputTokens: 4, totalInputTokens: 111 });

  expect(measured).toMatchObject({ kind: 'known', amount: 291.5 / 1_000_000 });
});

it.each([
  { missing: 'input', usage: { usageStage: 'message_delta' as const, outputTokens: 10, cacheReadInputTokens: 5,
    cacheCreationInputTokens: 6, cacheCreation5mInputTokens: 2, cacheCreation1hInputTokens: 4, totalInputTokens: 111 } },
  { missing: 'output', usage: { usageStage: 'message_delta' as const, inputTokens: 100, cacheReadInputTokens: 5,
    cacheCreationInputTokens: 6, cacheCreation5mInputTokens: 2, cacheCreation1hInputTokens: 4, totalInputTokens: 111 } },
  { missing: 'cache read', usage: { usageStage: 'message_delta' as const, inputTokens: 100, outputTokens: 10,
    cacheCreationInputTokens: 6, cacheCreation5mInputTokens: 2, cacheCreation1hInputTokens: 4, totalInputTokens: 111 } },
  { missing: 'cache creation', usage: { usageStage: 'message_delta' as const, inputTokens: 100, outputTokens: 10,
    cacheReadInputTokens: 5, cacheCreation5mInputTokens: 2, cacheCreation1hInputTokens: 4, totalInputTokens: 111 } },
])('keeps measured usage unknown when the $missing token count is missing', ({ usage }) => {
  const snapshot = { kind: 'known', currency: 'USD', unit: 'per-million-tokens', input: 2, output: 8,
    cacheRead: 0.2, cacheWrites: [{ ttlSeconds: 300, rate: 1.25 }, { ttlSeconds: 3600, rate: 2 }],
    substituted: false, freshness: 'current' } satisfies CostSnapshot;

  expect(routingMeasuredCost(snapshot, usage)).toMatchObject({ kind: 'unknown' });
});

it('keeps measured usage unknown when the aggregate input total disagrees with its partitions', () => {
  const snapshot = { kind: 'known', currency: 'USD', unit: 'per-million-tokens', input: 2, output: 8,
    cacheRead: 0.2, cacheWrites: [{ ttlSeconds: 300, rate: 1.25 }, { ttlSeconds: 3600, rate: 2 }],
    substituted: false, freshness: 'current' } satisfies CostSnapshot;
  const usage = { usageStage: 'message_delta', inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 5,
    cacheCreationInputTokens: 6, cacheCreation5mInputTokens: 2, cacheCreation1hInputTokens: 4, totalInputTokens: 112 } satisfies ResponseUsage;

  expect(routingMeasuredCost(snapshot, usage)).toMatchObject({ kind: 'unknown' });
});

it('keeps measured usage unknown when cache TTL partitions do not cover aggregate cache creation', () => {
  const snapshot = { kind: 'known', currency: 'USD', unit: 'per-million-tokens', input: 2, output: 8,
    cacheRead: 0.2, cacheWrites: [{ ttlSeconds: 300, rate: 1.25 }, { ttlSeconds: 3600, rate: 2 }],
    substituted: false, freshness: 'current' } satisfies CostSnapshot;
  const usage = { usageStage: 'message_delta', inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 5,
    cacheCreationInputTokens: 6, cacheCreation5mInputTokens: 2, cacheCreation1hInputTokens: 3, totalInputTokens: 111 } satisfies ResponseUsage;

  expect(routingMeasuredCost(snapshot, usage)).toMatchObject({ kind: 'unknown' });
});

it('keeps measured usage unknown when a used token category has no current rate', () => {
  const snapshot = { kind: 'known', currency: 'USD', unit: 'per-million-tokens', input: 2, output: 8,
    cacheRead: 0.2, substituted: false, freshness: 'current' } satisfies CostSnapshot;
  const usage = { usageStage: 'message_delta', inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 5,
    cacheCreationInputTokens: 6, totalInputTokens: 111 } satisfies ResponseUsage;

  expect(routingMeasuredCost(snapshot, usage)).toMatchObject({ kind: 'unknown' });
});

it('maps measured SDK usage without inventing missing counts or logging provider metadata', () => {
  const measured = routingSdkUsage({ model: 'provider/model-secret-sentinel', input_tokens: 12, output_tokens: 3,
    cache_creation_input_tokens: 2, cache_read_input_tokens: 4, cache_creation_5m_input_tokens: 1,
    cache_creation_1h_input_tokens: 1, promptCacheKeyHash: 'PROMPT_CACHE_KEY_SECRET_SENTINEL' });
  const partial = routingSdkUsage({ model: 'provider/model-secret-sentinel', input_tokens: 12,
    promptCacheKeyHash: 'PROMPT_CACHE_KEY_SECRET_SENTINEL' });

  expect(measured).toEqual({ usageStage: 'message_delta', inputTokens: 12, outputTokens: 3,
    cacheCreationInputTokens: 2, cacheReadInputTokens: 4, cacheCreation5mInputTokens: 1, cacheCreation1hInputTokens: 1 });
  expect(partial.inputTokens).toBe(12);
  expect(partial.outputTokens).toBeUndefined();
  expect(partial.cacheReadInputTokens).toBeUndefined();
  expect(partial.cacheCreationInputTokens).toBeUndefined();
  expect(JSON.stringify(measured)).not.toContain('provider/model-secret-sentinel');
  expect(JSON.stringify(measured)).not.toContain('PROMPT_CACHE_KEY_SECRET_SENTINEL');
});

it('labels a router outcome as its selected target when selector metadata is unavailable', async () => {
  const providerId = 'fixture/selector-router-provider';
  const modelId = 'fixture/selector-router-model';
  const fetchedAt = '2026-10-01T00:00:00.000Z';
  const ref = { providerId, modelId };
  const supplied = provider({ id: providerId, templateId: 'anthropic-api',
    modelsCache: { fetchedAt, source: 'account', models: [{ ...cachedModel(modelId), name: modelId,
      contextWindow: 80_000, outputTokenLimit: 10_000,
      pricing: { input: 2, output: 8, source: 'fixture-pricing', observedAt: fetchedAt } }] } });
  const catalog = buildRoutingCatalog(input([supplied], { credentials: [observation(providerId, 'api_key')],
    discovery: [{ providerId, status: 'live', cacheFetchedAt: fetchedAt }] }));
  const binding = await createRoutingBinding({ sessionId: `session-${randomUUID()}`, launchId: 'selector-router-launch',
    role: 'router', task: 'Private router task', config: { enabled: true, cheapFallback: ref, routerFallbacks: [], pool: [ref] },
    catalog, workload: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    selectorSkipReason: routingBindingEvents.selectorMetadataUnavailable });
  const logPath = join(getAppHome(), 'selector-router-outcome.jsonl');
  expect(relative(testHome!, dirname(logPath))).not.toMatch(/^\.\.(?:\/|$)/);

  logSelectorOutcome(logPath, binding);

  const [entry] = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  expect(entry).toMatchObject({ event: 'routing_selector_outcome', targetRole: 'selected_target',
    provider: providerId, model: modelId, reason: routingBindingEvents.selectorMetadataUnavailable });
});

it('round-trips selector traces containing only a UUID and hashed launch identities', () => {
  const sessionId = 'selector-session-private-sentinel';
  const launchId = 'selector-launch-private-sentinel';
  const trace = createSelectorTrace(sessionId, launchId);
  const encoded = encodeSelectorTrace(trace);

  expect(trace).toMatchObject({ requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    sessionHash: expect.stringMatching(/^[0-9a-f]{64}$/), launchHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(JSON.stringify(trace)).not.toContain(sessionId);
  expect(JSON.stringify(trace)).not.toContain(launchId);
  expect(decodeSelectorTrace(encoded)).toEqual(trace);
});

it.each([
  { label: 'UUID', change: (trace: ReturnType<typeof createSelectorTrace>) => ({ ...trace, requestId: 'invalid-request-id' }) },
  { label: 'session hash', change: (trace: ReturnType<typeof createSelectorTrace>) => ({ ...trace, sessionHash: 'invalid-hash' }) },
  { label: 'extra key', change: (trace: ReturnType<typeof createSelectorTrace>) => ({ ...trace, payload: 'PRIVATE_BODY_SENTINEL' }) },
])('rejects selector traces with an invalid $label', ({ change }) => {
  const invalid = change(createSelectorTrace('selector-session', 'selector-launch'));
  const encoded = Buffer.from(JSON.stringify(invalid), 'utf8').toString('base64url');

  expect(decodeSelectorTrace(encoded)).toBeUndefined();
  expect(() => encodeSelectorTrace(invalid)).toThrow();
});

it.each([
  { label: 'malformed base64url', raw: 'not*base64url' },
  { label: 'oversized header', raw: 'A'.repeat(513) },
])('rejects a selector trace with $label', ({ raw }) => {
  expect(decodeSelectorTrace(raw)).toBeUndefined();
});

it('projects selector failures without raw identity or arbitrary reason data', () => {
  const trace = createSelectorTrace('PROMPT_SECRET_SENTINEL', 'SIGNATURE_SECRET_SENTINEL');
  const target = { providerId: 'fixture-selector-provider', modelId: 'fixture-selector-model' };
  const logPath = join(getAppHome(), 'selector-trace-failure.jsonl');
  expect(relative(testHome!, dirname(logPath))).not.toMatch(/^\.\.(?:\/|$)/);

  writeSelectorTrace(logPath, trace, 'failed', { target, reason: 'BODY_SECRET_SENTINEL',
    bindingHash: 'CREDENTIAL_SECRET_SENTINEL' });

  const content = readFileSync(logPath, 'utf8');
  const [entry] = content.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  expect(entry).toMatchObject({ event: 'routing_selector_failed', requestId: trace.requestId,
    sessionHash: trace.sessionHash, launchHash: trace.launchHash, provider: target.providerId, model: target.modelId });
  expect(entry).not.toHaveProperty('reason');
  expect(entry).not.toHaveProperty('bindingHash');
  expect(content).not.toContain('PROMPT_SECRET_SENTINEL');
  expect(content).not.toContain('SIGNATURE_SECRET_SENTINEL');
  expect(content).not.toContain('BODY_SECRET_SENTINEL');
  expect(content).not.toContain('CREDENTIAL_SECRET_SENTINEL');
});

it.each([
  { event: 'attempt' as const, targetRole: 'selector' },
  { event: 'outcome' as const, targetRole: 'selected_target' },
])('labels the target for a selector $event event', ({ event, targetRole }) => {
  const trace = createSelectorTrace('selector-role-session', 'selector-role-launch');
  const target = { providerId: 'fixture-selector-provider', modelId: 'fixture-selector-model' };
  const logPath = join(getAppHome(), `selector-role-${event}.jsonl`);
  expect(relative(testHome!, dirname(logPath))).not.toMatch(/^\.\.(?:\/|$)/);

  writeSelectorTrace(logPath, trace, event, { target });

  const [entry] = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  expect(entry).toMatchObject({ targetRole, provider: target.providerId, model: target.modelId });
});

it.each([
  { label: 'complete', usage: { usageStage: 'message_delta' as const, inputTokens: 100, outputTokens: 20,
    cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, expected: { kind: 'known', amount: 0.00036 } },
  { label: 'missing cache-read partition', usage: { usageStage: 'message_delta' as const, inputTokens: 100, outputTokens: 20,
    cacheCreationInputTokens: 0 }, expected: { kind: 'unknown' } },
  { label: 'missing cache-creation partition', usage: { usageStage: 'message_delta' as const, inputTokens: 100, outputTokens: 20,
    cacheReadInputTokens: 0 }, expected: { kind: 'unknown' } },
])('records a $label selector cost with fixture price provenance', ({ usage, expected }) => {
  const providerId = 'fixture/selector-cost-provider';
  const modelId = 'fixture/selector-cost-model';
  const fetchedAt = '2026-10-01T00:00:00.000Z';
  const ref = { providerId, modelId };
  const supplied = provider({ id: providerId, templateId: 'anthropic-api',
    modelsCache: { fetchedAt, source: 'account', models: [{ ...cachedModel(modelId),
      pricing: { input: 2, output: 8, source: 'fixture-pricing', observedAt: fetchedAt } }] } });
  const catalog = buildRoutingCatalog(input([supplied], { credentials: [observation(providerId, 'api_key')],
    discovery: [{ providerId, status: 'live', cacheFetchedAt: fetchedAt }] }));
  const snapshot = selectorCostSnapshot(catalog, ref)!;
  const trace = createSelectorTrace('selector-cost-session', 'selector-cost-launch');
  const logPath = join(getAppHome(), `selector-cost-${expected.kind}.jsonl`);
  expect(relative(testHome!, dirname(logPath))).not.toMatch(/^\.\.(?:\/|$)/);

  writeSelectorTrace(logPath, trace, 'usage', { target: ref, snapshot, usage });

  const [entry] = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  expect(entry['measuredApiEquivalent']).toMatchObject({ ...expected, currency: 'USD', basis: 'provider_usage',
    source: snapshot.source, freshness: snapshot.freshness });
});

it('keeps a selector target unresolved when two model references share an alias', () => {
  const fetchedAt = '2026-10-01T00:00:00.000Z';
  const firstProvider = provider({ id: 'fixture:alias', templateId: 'custom',
    modelsCache: { fetchedAt, models: [cachedModel('model')] } });
  const secondProvider = provider({ id: 'fixture', templateId: 'custom',
    modelsCache: { fetchedAt, models: [cachedModel('alias:model')] } });
  const uniqueProvider = provider({ id: 'fixture-unique-alias', templateId: 'custom',
    modelsCache: { fetchedAt, models: [cachedModel('unique-model')] } });
  const catalog = buildRoutingCatalog(input([firstProvider, secondProvider, uniqueProvider]));
  const alias = httpProxyModelId(firstProvider.id, 'model');

  expect(httpProxyModelId(secondProvider.id, 'alias:model')).toBe(alias);
  expect(selectorTargetForAlias(catalog, httpProxyModelId(uniqueProvider.id, 'unique-model')))
    .toEqual({ providerId: uniqueProvider.id, modelId: 'unique-model' });
  expect(selectorTargetForAlias(catalog, alias)).toBeUndefined();
});

it('keeps conflicting prices for one selector target unknown', () => {
  const providerId = 'fixture/conflicting-selector-prices';
  const modelId = 'fixture-conflicting-model';
  const fetchedAt = '2026-10-01T00:00:00.000Z';
  const supplied = provider({ id: providerId, templateId: 'anthropic-api',
    modelsCache: { fetchedAt, models: [
      { ...cachedModel(modelId), pricing: { input: 2, output: 8, source: 'fixture-pricing', observedAt: fetchedAt } },
      { ...cachedModel(modelId), pricing: { input: 3, output: 8, source: 'fixture-pricing', observedAt: fetchedAt } },
    ] } });
  const catalog = buildRoutingCatalog(input([supplied]));

  expect(selectorCostSnapshot(catalog, { providerId, modelId })).toBeUndefined();
});

it('keeps cyclic selector price data unknown', () => {
  const providerId = 'fixture/cyclic-selector-prices';
  const modelId = 'fixture-cyclic-model';
  const fetchedAt = '2026-10-01T00:00:00.000Z';
  const supplied = provider({ id: providerId, templateId: 'anthropic-api',
    modelsCache: { fetchedAt, models: [{ ...cachedModel(modelId),
      pricing: { input: 2, output: 8, source: 'fixture-pricing', observedAt: fetchedAt } }] } });
  const catalog = buildRoutingCatalog(input([supplied]));
  const snapshot = catalog.models[0]!.estimate as CostSnapshot & Record<string, unknown>;
  snapshot['cyclicReference'] = snapshot;

  expect(selectorCostSnapshot(catalog, { providerId, modelId })).toBeUndefined();
});

it('does not throw when selector trace logging cannot open its target path', () => {
  const blockerPath = join(getAppHome(), `selector-log-blocker-${randomUUID()}`);
  const logPath = join(blockerPath, 'selector.jsonl');
  expect(relative(testHome!, dirname(blockerPath))).not.toMatch(/^\.\.(?:\/|$)/);
  writeFileSync(blockerPath, 'fixture file blocks directory creation');

  expect(() => writeSelectorTrace(logPath, createSelectorTrace('selector-session', 'selector-launch'), 'attempt'))
    .not.toThrow();
});
