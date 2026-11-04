import * as http from 'node:http';
import { dirname, relative, sep } from 'node:path';
import { expect, it } from 'vitest';
import { startHttpProxy } from '../src/http-proxy/server.js';
import type { ProxyRoute } from '../src/proxy.js';
import type { RoutingConfig } from '../src/model-routing.js';
import { buildRoutingCatalog, prepareRoutingHandoff, projectRoutingPromptPolicy } from '../src/model-routing.js';
import { createRoutingBinding, resolveRoutingBinding, routingBindingErrors, routingBindingStatePath } from '../src/routing-bindings.js';
import { input, observation, provider } from './model-routing-fixtures.js';
import { assertIsolatedRoutingSession, nativeRoutingContext } from './fixtures/model-routing-proxy.js';

const outerHome = process.env['LEVERFRAME_TEST_HOME'];
const target = { providerId: 'fixture-recovery-control-provider', modelId: 'fixture-recovery-control-model' };
const workload = { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 };
const timestamp = '2026-10-01T00:00:00.000Z';

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function recoveryState(sessionId: string, launchId: string) {
  const registered = provider({
    id: target.providerId,
    templateId: 'fixture',
    billing: { kind: 'metered', source: 'fixture-billing', observedAt: timestamp },
    modelsCache: { fetchedAt: timestamp, source: 'account', models: [{
      id: target.modelId,
      name: target.modelId,
      upstreamModelId: 'fixture-recovery-control-upstream',
      modelFormat: 'anthropic',
      contextWindow: 90_000,
      outputTokenLimit: 12_000,
      supportedReasoningEfforts: ['low'],
      pricing: { input: 2, output: 8, source: 'fixture-pricing', observedAt: timestamp },
    }] },
  });
  const catalog = buildRoutingCatalog(input([registered], {
    credentials: [observation(target.providerId)],
    discovery: [{ providerId: target.providerId, status: 'live', cacheFetchedAt: timestamp }],
  }));
  const config: RoutingConfig = { enabled: true, cheapFallback: target, pool: [target],
    categories: { implementation: { target, effort: 'low' } } };
  const prepared = prepareRoutingHandoff({ policy: projectRoutingPromptPolicy(config), agentType: 'reviewer',
    explicitCategory: 'implementation', delegatedTask: 'Recover the saved work.', originalTask: 'Continue the accepted review.',
    requiredConstraints: ['Keep response order stable.'], toolInstructions: ['Read source before editing.'],
    evidence: [{ source: 'tool-result', content: 'The earlier review identified one compatibility case.' }],
    jobState: 'The compatibility case remains open.' });
  const reviewedTask = JSON.stringify(prepared.envelope);
  const handoff = { version: 1 as const, agentType: 'reviewer', reviewedTask, prefix: prepared.envelope.prefix,
    provenance: 'explicit' as const };
  return { catalog, config, bindingInput: { sessionId, launchId, role: 'specialist' as const,
    category: 'implementation', agentType: 'reviewer', task: reviewedTask, handoff, config, catalog, workload } };
}

async function startRecoveryProxy(catalog: ReturnType<typeof buildRoutingCatalog>, config: RoutingConfig) {
  const routing = { recoveryOnly: true as const, config: { ...config, enabled: false, recoveryEnabled: true }, catalog, workload: {} };
  return startHttpProxy({ host: '127.0.0.1', port: 0, routes: [] as ProxyRoute[],
    routing: routing as unknown as NonNullable<Parameters<typeof startHttpProxy>[0]['routing']> });
}

async function postRecoveryRequest(port: number, token: string, body: string, authorization = `Bearer ${token}`) {
  const response = new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/v1/leverframe/routing-recovery',
      headers: { Authorization: authorization, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, result => {
      const chunks: Buffer[] = [];
      result.on('data', chunk => chunks.push(Buffer.from(chunk)));
      result.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let body: Record<string, unknown>;
        try { body = JSON.parse(text) as Record<string, unknown>; }
        catch { body = { raw: text }; }
        resolve({ status: result.statusCode ?? 0, body });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
  return response;
}

it('restores a valid saved binding through the authenticated loopback recovery endpoint', async () => {
  const sessionId = 'recovery-control-bound-session';
  const launchId = 'recovery-control-bound-launch';
  assertIsolatedRoutingSession(sessionId);
  const state = recoveryState(sessionId, launchId);
  const binding = await createRoutingBinding(state.bindingInput);
  const statePath = routingBindingStatePath(sessionId);
  expect(inside(outerHome!, dirname(statePath))).toBe(true);
  const proxy = await startRecoveryProxy(state.catalog, state.config);

  try {
    const response = await postRecoveryRequest(proxy.port, proxy.token, JSON.stringify({ sessionId, launchId,
      sidecarValid: true, agentType: 'reviewer', marker: binding.modelId }));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ kind: 'bound', modelId: binding.modelId,
      policyModelId: `leverframe:${target.providerId}:${target.modelId}`, effort: 'low',
      metadata: { contextWindow: 90_000, maxOutputTokens: 12_000, supportedReasoningEfforts: ['low'] },
      handoff: { version: 1, agentType: 'reviewer', reviewedTask: binding.handoff!.reviewedTask } });
    expect((proxy as typeof proxy & { routingRecoveryOnly?: true }).routingRecoveryOnly).toBe(true);
    expect(proxy.routingEnabled).not.toBe(true);
  } finally {
    await proxy.close();
  }
});

it.each([
  { label: 'missing agent type', identity: {} },
  { label: 'mismatched agent type', identity: { agentType: 'different-agent' } },
])('rejects a known-bound recovery request with $label before model lookup', async ({ identity }) => {
  const sessionId = 'recovery-control-missing-agent-type';
  const launchId = 'recovery-control-missing-agent-type-launch';
  assertIsolatedRoutingSession(sessionId);
  const state = recoveryState(sessionId, launchId);
  const binding = await createRoutingBinding(state.bindingInput);
  let monitorModelReads = false;
  let modelReads = 0;
  const guardedCatalog = new Proxy(state.catalog, {
    get(source, property, receiver) {
      if (monitorModelReads && property === 'models') modelReads++;
      return Reflect.get(source, property, receiver) as unknown;
    },
  });
  const proxy = await startRecoveryProxy(guardedCatalog, state.config);
  monitorModelReads = true;

  try {
    const response = await postRecoveryRequest(proxy.port, proxy.token, JSON.stringify({ sessionId, launchId,
      sidecarValid: true, marker: binding.modelId, ...identity }));

    expect({ status: response.status, modelReads }).toEqual({ status: 400, modelReads: 0 });
  } finally {
    await proxy.close();
  }
});

it('accepts a valid unmarked historical sidecar without requiring provider catalog facts', async () => {
  const state = recoveryState('recovery-control-unbound-session', 'recovery-control-unbound-launch');
  const catalogWithoutReadableModels = new Proxy(state.catalog, {
    get(source, property, receiver) {
      if (property === 'models') throw new Error('Unbound recovery must not inspect model rows.');
      return Reflect.get(source, property, receiver) as unknown;
    },
  });
  const proxy = await startRecoveryProxy(catalogWithoutReadableModels, state.config);

  try {
    const response = await postRecoveryRequest(proxy.port, proxy.token, JSON.stringify({ sessionId: 'recovery-control-unbound-session',
      launchId: 'historical-launch-without-binding', sidecarValid: true }));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ kind: 'unbound' });
  } finally {
    await proxy.close();
  }
});

it('authenticates recovery requests before parsing malformed bodies', async () => {
  const state = recoveryState('recovery-control-auth-session', 'recovery-control-auth-launch');
  const proxy = await startRecoveryProxy(state.catalog, state.config);

  try {
    const response = await postRecoveryRequest(proxy.port, proxy.token, '{', 'Bearer incorrect-fixture-token');

    expect(response.status).toBe(401);
    expect(response.body).toHaveProperty('error');
  } finally {
    await proxy.close();
  }
});

it('rejects an unknown marked binding before reading provider model metadata', async () => {
  const state = recoveryState('recovery-control-unknown-marker', 'recovery-control-unknown-launch');
  const catalogWithoutReadableModels = new Proxy(state.catalog, {
    get(source, property, receiver) {
      if (property === 'models') throw new Error('Invalid recovery state must fail before model identity lookup.');
      return Reflect.get(source, property, receiver) as unknown;
    },
  });
  const proxy = await startRecoveryProxy(catalogWithoutReadableModels, state.config);

  try {
    const response = await postRecoveryRequest(proxy.port, proxy.token, JSON.stringify({ sessionId: 'recovery-control-unknown-marker',
      launchId: 'missing-bound-launch', sidecarValid: true, marker: 'forged-marker' }));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: routingBindingErrors.invalid } });
  } finally {
    await proxy.close();
  }
});

it.each([
  { label: 'with an authorized alternative', fallbacks: [{ providerId: 'anthropic', modelId: 'fixture-recovery-alternative', effort: 'low' }] },
  { label: 'without an authorized alternative', fallbacks: [] },
])('fails closed when the saved native row is absent, even $label', async ({ fallbacks }) => {
  const sessionId = `recovery-native-row-absent-${globalThis.crypto.randomUUID()}`;
  const launchId = `recovery-native-row-absent-${globalThis.crypto.randomUUID()}`;
  assertIsolatedRoutingSession(sessionId);
  const state = nativeRoutingContext();
  const primary = state.catalog.models[0]!;
  const alternative = { ...primary, ref: { providerId: 'anthropic', modelId: 'fixture-recovery-alternative' },
    upstreamModelId: 'fixture-recovery-alternative-upstream', credential: { ...primary.credential, available: true } };
  state.catalog = { ...state.catalog, models: [primary, alternative] };
  state.config = { ...state.config, categories: { implementation: { target: primary.ref, effort: 'low', fallbacks } } };
  const policy = projectRoutingPromptPolicy(state.config);
  const prepared = prepareRoutingHandoff({ policy, agentType: 'reviewer', explicitCategory: 'implementation',
    delegatedTask: 'Recover the saved specialist work.', originalTask: 'Continue the accepted native review.',
    requiredConstraints: ['Preserve the saved target.'], toolInstructions: ['Inspect existing state.'],
    evidence: [{ source: 'tool-result', content: 'The previous review remains open.' }], jobState: 'Continue from the saved checkpoint.' });
  const reviewedTask = JSON.stringify(prepared.envelope);
  const handoff = { version: 1 as const, agentType: 'reviewer', reviewedTask, prefix: prepared.envelope.prefix,
    provenance: prepared.provenance as 'explicit' | 'agent_mapping' | 'task_category_match' | 'default' };
  const binding = await createRoutingBinding({ sessionId, launchId, role: 'specialist', category: 'implementation',
    agentType: 'reviewer', task: reviewedTask, handoff, config: state.config, catalog: state.catalog, workload: state.workload });
  const currentCatalog = { ...state.catalog, models: [alternative] };
  const proxy = await startRecoveryProxy(currentCatalog, state.config);

  try {
    const response = await postRecoveryRequest(proxy.port, proxy.token, JSON.stringify({ sessionId, launchId,
      sidecarValid: true, agentType: 'reviewer', marker: binding.modelId }));
    const after = await resolveRoutingBinding({ sessionId, modelId: binding.modelId });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: routingBindingErrors.identityMismatch } });
    expect(after.id).toBe(binding.id);
    expect(after.revision).toBe(binding.revision);
    expect(after.identity).toEqual(binding.identity);
    expect(after.decision.target).toEqual(binding.decision.target);
    expect(after.fallbackAuthorization?.targets.map(({ providerId, modelId, kind }) => ({ providerId, modelId, kind })))
      .toEqual(binding.fallbackAuthorization?.targets.map(({ providerId, modelId, kind }) => ({ providerId, modelId, kind })));
    expect(proxy.routingRecoveryOnly).toBe(true);
  } finally {
    await proxy.close();
  }
});
