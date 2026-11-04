import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildRoutingCatalog } from '../src/model-routing.js';
import { getAppHome } from '../src/paths.js';
import { createRoutingBinding, resolveRoutingRecovery, routingBindingErrors,
  routingBindingStatePath, scanRoutingRecovery } from '../src/routing-bindings.js';
import type { RoutingConfig } from '../src/model-routing.js';
import { input, observation, provider } from './model-routing-fixtures.js';

const target = { providerId: 'fixture-recovery-provider', modelId: 'fixture-recovery-model' };
const workload = { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 };
const outerHome = process.env['LEVERFRAME_TEST_HOME'];
let originalRoutingHome: string | undefined;
let recoveryHome: string;

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function launchInput(sessionId: string, launchId: string, now = Date.now, role: 'router' | 'specialist' = 'specialist') {
  const modelProvider = provider({
    id: target.providerId,
    templateId: 'fixture',
    billing: { kind: 'metered', source: 'fixture-billing', observedAt: '2026-10-01T00:00:00.000Z' },
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', source: 'account', models: [{
      id: target.modelId,
      name: target.modelId,
      upstreamModelId: 'fixture-recovery-upstream',
      modelFormat: 'anthropic',
      reasoning: true,
      contextWindow: 90_000,
      outputTokenLimit: 12_000,
      supportedReasoningEfforts: ['low'],
      pricing: { input: 2, output: 8, source: 'fixture-pricing', observedAt: '2026-10-01T00:00:00.000Z' },
    }] },
  });
  const catalog = buildRoutingCatalog(input([modelProvider], {
    credentials: [observation(target.providerId)],
    discovery: [{ providerId: target.providerId, status: 'live', cacheFetchedAt: '2026-10-01T00:00:00.000Z' }],
  }));
  const config: RoutingConfig = { enabled: true, cheapFallback: target, pool: [target],
    categories: { implementation: { target, effort: 'low' } } };
  return { sessionId, launchId, role, category: 'implementation', task: 'Restore this job',
    config, catalog, workload, now };
}

async function acceptedBinding(sessionId: string, launchId: string, now = Date.now, ttlMs?: number,
  role: 'router' | 'specialist' = 'specialist') {
  return createRoutingBinding({ ...launchInput(sessionId, launchId, now, role), ...(ttlMs === undefined ? {} : { ttlMs }) });
}

beforeEach(() => {
  expect(outerHome).toBeTruthy();
  originalRoutingHome = process.env['LEVERFRAME_HOME'];
  recoveryHome = `${outerHome}/routing-recovery-${globalThis.crypto.randomUUID()}`;
  process.env['LEVERFRAME_HOME'] = recoveryHome;
  expect(inside(outerHome!, getAppHome())).toBe(true);
});

afterEach(() => {
  if (originalRoutingHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = originalRoutingHome;
  expect(inside(outerHome!, recoveryHome)).toBe(true);
  rmSync(recoveryHome, { recursive: true, force: true });
});

it('treats a valid unmarked historical sidecar with no recorded binding as unbound', async () => {
  const result = await resolveRoutingRecovery({ sessionId: 'recovery-history-unbound',
    launchId: 'historical-launch-without-binding', sidecarValid: true });

  expect(result).toEqual({ kind: 'unbound' });
});

it('rejects a valid unmarked sidecar when its launch already has a persisted binding', async () => {
  const input = launchInput('recovery-known-launch', 'known-bound-launch');
  await acceptedBinding(input.sessionId, input.launchId);

  await expect(resolveRoutingRecovery({ sessionId: input.sessionId, launchId: input.launchId, sidecarValid: true }))
    .rejects.toMatchObject({ code: routingBindingErrors.invalid });
});

it('restores the exact binding only when the sidecar marker matches its launch', async () => {
  const input = launchInput('recovery-valid-marker', 'recovery-valid-launch');
  const binding = await acceptedBinding(input.sessionId, input.launchId);

  const result = await resolveRoutingRecovery({ sessionId: input.sessionId, launchId: input.launchId,
    marker: binding.modelId, sidecarValid: true });

  expect(result).toMatchObject({ kind: 'bound', binding: { id: binding.id, modelId: binding.modelId,
    launchId: input.launchId, decision: { target } } });
});

it('rejects a forged marker before it can restore another binding', async () => {
  const input = launchInput('recovery-forged-marker', 'recovery-forged-launch');
  const binding = await acceptedBinding(input.sessionId, input.launchId);

  await expect(resolveRoutingRecovery({ sessionId: input.sessionId, launchId: input.launchId,
    marker: `${binding.modelId}-forged`, sidecarValid: true }))
    .rejects.toMatchObject({ code: routingBindingErrors.invalid });
});

it('rejects a marker that belongs to another session before restoring its binding', async () => {
  const owner = launchInput('recovery-marker-owner', 'recovery-owner-launch');
  const binding = await acceptedBinding(owner.sessionId, owner.launchId);

  await expect(resolveRoutingRecovery({ sessionId: 'recovery-marker-other-session', launchId: owner.launchId,
    marker: binding.modelId, sidecarValid: true }))
    .rejects.toMatchObject({ code: routingBindingErrors.sessionMismatch });
});

it('rejects a binding marker after its saved routing checkpoint expires', async () => {
  const createdAt = Date.now() - 10_000;
  const input = launchInput('recovery-expired-marker', 'recovery-expired-launch', () => createdAt);
  const binding = await acceptedBinding(input.sessionId, input.launchId, () => createdAt, 1_000);

  await expect(resolveRoutingRecovery({ sessionId: input.sessionId, launchId: input.launchId,
    marker: binding.modelId, sidecarValid: true }))
    .rejects.toMatchObject({ code: routingBindingErrors.expired });
});

it('reports an expired-only checkpoint as needing recovery without offering its target', async () => {
  const createdAt = Date.now() - 10_000;
  await acceptedBinding('recovery-expired-scan', 'recovery-expired-scan-launch', () => createdAt, 1_000);
  const result = scanRoutingRecovery();

  expect(result).toEqual({ needed: true, targets: [] });
});

it('omits router-only checkpoints from specialist recovery targets and need', async () => {
  await acceptedBinding('recovery-router-only', 'recovery-router-launch', Date.now, undefined, 'router');

  expect(scanRoutingRecovery()).toEqual({ needed: false, targets: [] });
});

it('rejects corrupt known routing state instead of treating it as absent', async () => {
  const input = launchInput('recovery-corrupt-state', 'recovery-corrupt-launch');
  const binding = await acceptedBinding(input.sessionId, input.launchId);
  const statePath = routingBindingStatePath(input.sessionId);
  expect(inside(outerHome!, statePath)).toBe(true);
  const original = readFileSync(statePath);

  try {
    writeFileSync(statePath, '{', 'utf8');

    await expect(resolveRoutingRecovery({ sessionId: input.sessionId, launchId: input.launchId,
      marker: binding.modelId, sidecarValid: true }))
      .rejects.toMatchObject({ code: routingBindingErrors.stateInvalid });
  } finally {
    expect(inside(outerHome!, statePath)).toBe(true);
    writeFileSync(statePath, original);
  }
});

it('rejects a stored binding whose session scope no longer matches its checkpoint directory', async () => {
  const input = launchInput('recovery-wrong-scope', 'recovery-wrong-scope-launch');
  await acceptedBinding(input.sessionId, input.launchId);
  const statePath = routingBindingStatePath(input.sessionId);
  expect(inside(outerHome!, statePath)).toBe(true);
  const original = readFileSync(statePath);
  const corrupted = JSON.parse(original.toString()) as { bindings: Array<Record<string, unknown>> };
  corrupted.bindings[0]!.sessionId = 'different-recovery-scope';

  try {
    writeFileSync(statePath, JSON.stringify(corrupted), 'utf8');

    expect(() => scanRoutingRecovery()).toThrow(expect.objectContaining({ code: routingBindingErrors.stateInvalid }));
  } finally {
    expect(inside(outerHome!, statePath)).toBe(true);
    writeFileSync(statePath, original);
  }
});

it('rejects a malformed saved sidecar before considering its routing marker', async () => {
  const input = launchInput('recovery-invalid-sidecar', 'recovery-invalid-sidecar-launch');
  const binding = await acceptedBinding(input.sessionId, input.launchId);

  await expect(resolveRoutingRecovery({ sessionId: input.sessionId, launchId: input.launchId,
    marker: binding.modelId, sidecarValid: false }))
    .rejects.toMatchObject({ code: routingBindingErrors.invalid });
});
