import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildRoutingCatalog } from '../src/model-routing.js';
import { getAppHome } from '../src/paths.js';
import {
  advanceRoutingFallback,
  createRoutingBinding,
  ensureRoutingLaunchNotices,
  listRoutingNotices,
  resolveRoutingBinding,
  resolveRoutingRecovery,
  routingBindingErrors,
  routingBindingStatePath,
  withRoutingLease,
} from '../src/routing-bindings.js';
import type { RoutingConfig } from '../src/model-routing.js';
import type { RoutingWorkload } from '../src/routing-estimate.js';
import type { SelectorPayload } from '../src/routing-selector.js';
import { input, observation, provider } from './model-routing-fixtures.js';

const modelA = { providerId: 'fixture-provider-a', modelId: 'fixture-model-a' };
const modelB = { providerId: 'fixture-provider-b', modelId: 'fixture-model-b' };
const workload: RoutingWorkload = { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0 };
const tempHome = process.env['LEVERFRAME_TEST_HOME'];

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function launchInput(sessionId: string, launchId: string, task = 'Review the current implementation') {
  const providers = [modelA, modelB].map(ref => provider({
    id: ref.providerId,
    templateId: 'fixture',
    billing: { kind: 'metered', source: 'fixture-billing', observedAt: '2026-10-01T00:00:00.000Z' },
    modelsCache: {
      fetchedAt: '2026-10-01T00:00:00.000Z',
      source: 'account',
      models: [{
        id: ref.modelId,
        name: ref.modelId,
        upstreamModelId: `upstream-${ref.modelId}`,
        modelFormat: 'anthropic',
        supportedReasoningEfforts: ['low', 'high'],
        reasoning: true,
        pricing: { input: 2, output: 8, source: 'fixture-pricing' },
      }],
    },
  }));
  const snapshotInput = input(providers, {
    credentials: providers.map(item => observation(item.id)),
    discovery: providers.map(item => ({
      providerId: item.id,
      status: 'live' as const,
      cacheFetchedAt: '2026-10-01T00:00:00.000Z',
    })),
  });
  const config: RoutingConfig = {
    enabled: true,
    cheapFallback: modelA,
    pool: [modelA, modelB],
    categories: {
      deep_research: {
        alternatingTargets: [
          { ...modelA, effort: 'low' },
          { ...modelB, effort: 'high' },
        ],
      },
      implementation: { target: modelA, effort: 'low' },
    },
  };
  return {
    sessionId,
    launchId,
    role: 'specialist' as const,
    category: 'deep_research',
    task,
    config,
    catalog: buildRoutingCatalog(snapshotInput),
    workload,
    now: () => Date.parse('2026-10-02T00:00:00.000Z'),
  };
}

function selectorLaunchInput(sessionId: string, launchId: string, task: string,
  capture?: { payload?: SelectorPayload; calls?: number }) {
  const launch = launchInput(sessionId, launchId, task);
  launch.config.selector = {
    enabled: true,
    target: modelA,
    maxExtraCallsPerTask: 1,
    maxOutputTokens: 128,
    evaluationEvidence: [{
      category: 'default',
      effort: 'low',
      candidateSetVersion: 'fixture-candidate-set',
      signatureVersion: 'fixture-signature',
      sampleSize: 4,
      sourceEvaluationId: 'fixture-evaluation',
      measuredAt: '2026-10-01T00:00:00.000Z',
      expiresAt: '2026-10-03T00:00:00.000Z',
      avoidedTokens: { input: 5000 },
    }],
  };
  return {
    ...launch,
    category: undefined,
    effort: 'low',
    selector: {
      features: { size: 'small' as const, turns: 'few' as const, tools: 'few' as const, recentFailures: 0 },
      candidateSetVersion: 'fixture-candidate-set',
      signatureVersion: 'fixture-signature',
      selectorWorkload: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 },
      call: async (_target: typeof modelA, payload: SelectorPayload) => {
        if (capture) {
          capture.payload = payload;
          capture.calls = (capture.calls ?? 0) + 1;
        }
        return payload.candidates[1]!.ref;
      },
    },
  };
}

function expectSessionStorageIsIsolated(sessionId: string): void {
  const path = routingBindingStatePath(sessionId);
  expect(tempHome).toBeTruthy();
  expect(inside(tempHome!, getAppHome())).toBe(true);
  expect(inside(tempHome!, dirname(path))).toBe(true);
}

  it('allocates concurrent alternating jobs in launch acceptance order', async () => {
    const firstInput = launchInput('session-concurrent-launches', 'launch-first');
    const secondInput = launchInput('session-concurrent-launches', 'launch-second');
    expectSessionStorageIsIsolated(firstInput.sessionId);

    const [first, second] = await Promise.all([
      createRoutingBinding(firstInput),
      createRoutingBinding(secondInput),
    ]);

    expect(first.arm).toBe(0);
    expect(first.decision.target).toEqual(modelA);
    expect(second.arm).toBe(1);
    expect(second.decision.target).toEqual(modelB);
  });

  it('keeps an accepted arm when that launch is canceled before inference', async () => {
    const firstLaunch = launchInput('session-canceled-launch', 'launch-canceled-first');
    const nextLaunch = launchInput('session-canceled-launch', 'launch-canceled-next');
    expectSessionStorageIsIsolated(firstLaunch.sessionId);

    const canceled = await createRoutingBinding(firstLaunch);
    const next = await createRoutingBinding(nextLaunch);

    expect(canceled.arm).toBe(0);
    expect(next.arm).toBe(1);
    expect(next.decision.target).toEqual(modelB);
  });

  it('restores the accepted model, effort, and consumed selector budget for an idempotent retry', async () => {
    const task = 'Choose the better implementation model';
    const captured: { payload?: SelectorPayload; calls?: number } = {};
    const launch = selectorLaunchInput('session-idempotent-launch', 'launch-idempotent', task, captured);
    expectSessionStorageIsIsolated(launch.sessionId);
    const accepted = await createRoutingBinding(launch);
    const resumed = await createRoutingBinding({ ...launch, resume: true });

    expect(resumed.id).toBe(accepted.id);
    expect(accepted.decision.target).toEqual(modelB);
    expect(accepted.decision.effort).toBe('low');
    expect(resumed.decision.target).toEqual(modelB);
    expect(resumed.decision.effort).toBe('low');
    expect(resumed.selectorCalls).toBe(accepted.selectorCalls);
    expect(resumed.selectorCalls).toBe(1);
    expect(captured.calls).toBe(1);
    expect(accepted.taskDigest).toBe(createHash('sha256').update(task).digest('hex'));
  });

  it('resumes an existing binding after routing is disabled even when task and category inputs changed', async () => {
    const launch = launchInput('session-disabled-resume', 'launch-disabled-resume');
    expectSessionStorageIsIsolated(launch.sessionId);
    const accepted = await createRoutingBinding(launch);
    const resumeConfig = {
      ...launch.config,
      enabled: false,
      categories: { ...launch.config.categories, implementation: { target: modelB, effort: 'high' } },
    };
    const resumed = await createRoutingBinding({
      ...launch,
      category: 'implementation',
      task: 'Updated work for a new category',
      config: resumeConfig,
      resume: true,
    });

    expect(resumed.id).toBe(accepted.id);
    expect(resumed.decision.target).toEqual(modelA);
    expect(resumed.decision.effort).toBe('low');
  });

  it('rejects a new launch after routing has been disabled', async () => {
    const launch = launchInput('session-disabled-new-launch', 'launch-disabled-new');
    expectSessionStorageIsIsolated(launch.sessionId);

    await expect(createRoutingBinding({ ...launch, config: { ...launch.config, enabled: false } }))
      .rejects.toMatchObject({ code: routingBindingErrors.disabled });
  });

  it('rejects a new binding before selector work when fresh preferences disable routing', async () => {
    const captured: { payload?: SelectorPayload; calls?: number } = {};
    const launch = selectorLaunchInput('session-fresh-disabled-launch', 'launch-fresh-disabled', 'Review the implementation', captured);
    expectSessionStorageIsIsolated(launch.sessionId);

    await expect(createRoutingBinding({ ...launch, acceptNewBinding: () => false }))
      .rejects.toMatchObject({ code: routingBindingErrors.disabled });

    expect(captured.calls).toBeUndefined();
  });

  it('does not recheck fresh preferences for an already accepted matching binding', async () => {
    const launch = launchInput('session-existing-disabled-binding', 'launch-existing-disabled');
    expectSessionStorageIsIsolated(launch.sessionId);
    const accepted = await createRoutingBinding(launch);

    const retried = await createRoutingBinding({
      ...launch,
      config: { ...launch.config, enabled: false },
      acceptNewBinding: () => { throw new Error('new binding gate should not run for a stored binding'); },
    });

    expect(retried.id).toBe(accepted.id);
    expect(retried.decision).toEqual(accepted.decision);
  });

  it('propagates a fresh preference read failure without spending selector calls', async () => {
    const captured: { payload?: SelectorPayload; calls?: number } = {};
    const launch = selectorLaunchInput('session-disabled-read-failure', 'launch-disabled-read-failure', 'Review the implementation', captured);
    expectSessionStorageIsIsolated(launch.sessionId);
    const failure = new Error('preference read failed');

    await expect(createRoutingBinding({ ...launch, acceptNewBinding: () => { throw failure; } }))
      .rejects.toBe(failure);

    expect(captured.calls).toBeUndefined();
  });

  it('binds only a digest of the trusted task before returning the selected model identity', async () => {
    const task = 'Inspect cache behavior for the current implementation';
    const launch = launchInput('session-task-digest', 'launch-task-digest', task);
    expectSessionStorageIsIsolated(launch.sessionId);
    const binding = await createRoutingBinding(launch);

    expect(binding.taskDigest).toBe(createHash('sha256').update(task).digest('hex'));
    expect(binding.decision.target).toEqual(modelA);
    expect(binding.decision.target.modelId).not.toBe(binding.id);
  });

  it('sends the selector a task digest and source model references without the task text', async () => {
    const task = 'Keep this task text inside the host process';
    const captured: { payload?: SelectorPayload } = {};
    const launch = selectorLaunchInput('session-selector-payload', 'launch-selector-payload', task, captured);
    expectSessionStorageIsIsolated(launch.sessionId);

    await createRoutingBinding(launch);

    expect(captured.payload?.taskSignature).toBe(createHash('sha256').update(task).digest('hex'));
    expect(captured.payload?.candidates).toContainEqual({ ref: modelA, amount: expect.any(Number) });
    expect(captured.payload?.candidates).toContainEqual({ ref: modelB, amount: expect.any(Number) });
    expect(JSON.stringify(captured.payload)).not.toContain(task);
  });

  it('does not reuse a selector decision across sessions with the same task signature', async () => {
    const captured: { payload?: SelectorPayload; calls?: number } = {};
    const task = 'Select a worker for the same private task';
    const first = selectorLaunchInput('session-selector-cache-a', 'launch-selector-cache-a', task, captured);
    const second = selectorLaunchInput('session-selector-cache-b', 'launch-selector-cache-b', task, captured);
    expectSessionStorageIsIsolated(first.sessionId);
    expectSessionStorageIsIsolated(second.sessionId);

    const firstBinding = await createRoutingBinding(first);
    const secondBinding = await createRoutingBinding(second);

    expect(firstBinding.decision.target).toEqual(modelB);
    expect(secondBinding.decision.target).toEqual(modelB);
    expect(captured.calls).toBe(2);
  });

  it('runs selector evaluation again after its session cache expires', async () => {
    const captured: { payload?: SelectorPayload; calls?: number } = {};
    const acceptedAt = Date.parse('2026-10-02T00:00:00.000Z');
    const first = {
      ...selectorLaunchInput('session-selector-cache-expiry', 'launch-selector-cache-before-expiry', 'Select an eligible worker', captured),
      now: () => acceptedAt,
      ttlMs: 1000,
    };
    expectSessionStorageIsIsolated(first.sessionId);
    await createRoutingBinding(first);
    const later = {
      ...selectorLaunchInput(first.sessionId, 'launch-selector-cache-after-expiry', 'Select an eligible worker', captured),
      now: () => acceptedAt + 2000,
      ttlMs: 1000,
    };

    const secondBinding = await createRoutingBinding(later);

    expect(secondBinding.decision.target).toEqual(modelB);
    expect(captured.calls).toBe(2);
  });

  it('rejects a binding that belongs to another session', async () => {
    const launch = launchInput('session-owner', 'launch-owner');
    expectSessionStorageIsIsolated(launch.sessionId);
    const binding = await createRoutingBinding(launch);

    await expect(resolveRoutingBinding({
      sessionId: 'session-other',
      modelId: binding.id,
      now: launch.now,
    })).rejects.toMatchObject({ code: routingBindingErrors.sessionMismatch });
  });

  it('rejects a model identity that is not a persisted binding', async () => {
    const launch = launchInput('session-forged-model', 'launch-forged-model');
    expectSessionStorageIsIsolated(launch.sessionId);

    await expect(resolveRoutingBinding({
      sessionId: launch.sessionId,
      modelId: 'unissued-binding-identity',
      now: launch.now,
    })).rejects.toMatchObject({ code: routingBindingErrors.invalid });
  });

  it('rejects a well-formed binding identity that has no persisted launch', async () => {
    const launch = launchInput('session-missing-binding', 'launch-missing-binding');
    expectSessionStorageIsIsolated(launch.sessionId);
    const binding = await createRoutingBinding(launch);
    const missingModelId = binding.id.replace(/:[a-f0-9]{64}$/, `:${createHash('sha256').update('never-issued').digest('hex')}`);

    await expect(resolveRoutingBinding({
      sessionId: binding.sessionId,
      modelId: missingModelId,
      now: launch.now,
    })).rejects.toMatchObject({ code: routingBindingErrors.invalid });
  });

  it('rejects a binding after its persisted expiration time', async () => {
    const launch = launchInput('session-expired-binding', 'launch-expired-binding');
    expectSessionStorageIsIsolated(launch.sessionId);
    const binding = await createRoutingBinding({ ...launch, ttlMs: 1 });

    await expect(resolveRoutingBinding({
      sessionId: launch.sessionId,
      modelId: binding.id,
      now: () => Date.parse(binding.expiresAt) + 1,
    })).rejects.toMatchObject({ code: routingBindingErrors.expired });
  });

  it('keeps an expired binding leased until its active inference finishes', async () => {
    const launch = launchInput('session-expired-active-inference', 'launch-expired-active-inference');
    expectSessionStorageIsIsolated(launch.sessionId);
    const binding = await createRoutingBinding({ ...launch, ttlMs: 1 });
    const request = { sessionId: binding.sessionId, modelId: binding.id, now: launch.now };
    let markStarted!: () => void;
    let finishRequest!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const pending = new Promise<void>(resolve => { finishRequest = resolve; });
    const active = withRoutingLease(request, async () => {
      markStarted();
      await pending;
    });
    await started;

    await expect(withRoutingLease({
      ...request,
      now: () => Date.parse(binding.expiresAt) + 1,
    }, async () => undefined)).rejects.toMatchObject({ retryable: true });
    finishRequest();
    await expect(active).resolves.toBeUndefined();
  });

  it('does not replay inference or take over a lease after its owner is gone', async () => {
    const launch = launchInput('session-abandoned-inference', 'launch-abandoned-inference');
    expectSessionStorageIsIsolated(launch.sessionId);
    const binding = await createRoutingBinding(launch);
    const statePath = routingBindingStatePath(launch.sessionId);
    const originalState = readFileSync(statePath, 'utf8');
    const abandonedLease = 'fixture-lease-with-unknown-outcome';
    const abandonedOwner = 2_147_483_647;
    const state = JSON.parse(originalState) as {
      bindings: Array<Record<string, unknown>>;
    };
    state.bindings[0]!['lease'] = abandonedLease;
    state.bindings[0]!['leaseOwner'] = abandonedOwner;
    let inferenceStarted = false;
    let rejection: unknown;
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    });

    try {
      expect(inside(tempHome!, dirname(statePath))).toBe(true);
      writeFileSync(statePath, JSON.stringify(state), 'utf8');
      await withRoutingLease({ sessionId: launch.sessionId, modelId: binding.id }, async () => {
        inferenceStarted = true;
        return binding.id;
      }).then(() => undefined, error => { rejection = error; });

      const failure = rejection as Error & { code?: string; retryable?: boolean };
      expect(failure).toMatchObject({ code: 'routing_lease_abandoned' });
      expect(failure.retryable).not.toBe(true);
      expect(failure.message).toMatch(/known outcome|unknown.*outcome|outcome.*unknown/i);
      expect(failure.message).toMatch(/recover/i);
      expect(inferenceStarted).toBe(false);
      expect(processKill).toHaveBeenCalledOnce();
      expect(processKill).toHaveBeenCalledWith(abandonedOwner, 0);

      const retainedState = JSON.parse(readFileSync(statePath, 'utf8')) as {
        bindings: Array<Record<string, unknown>>;
      };
      expect(retainedState.bindings[0]).toMatchObject({
        id: binding.id,
        lease: abandonedLease,
        leaseOwner: abandonedOwner,
        decision: { target: binding.decision.target, reason: binding.decision.reason, effort: binding.decision.effort },
      });
    } finally {
      processKill.mockRestore();
      expect(inside(tempHome!, dirname(statePath))).toBe(true);
      writeFileSync(statePath, originalState, 'utf8');
    }
  });

  it('keeps an expired lease retryable when the owner liveness check is uncertain', async () => {
    const launch = launchInput('session-uncertain-inference-owner', 'launch-uncertain-inference-owner');
    expectSessionStorageIsIsolated(launch.sessionId);
    const binding = await createRoutingBinding({ ...launch, ttlMs: 1 });
    const statePath = routingBindingStatePath(launch.sessionId);
    const originalState = readFileSync(statePath, 'utf8');
    const lease = 'fixture-lease-with-uncertain-owner';
    const ownerPid = 2_147_483_647;
    const state = JSON.parse(originalState) as { bindings: Array<Record<string, unknown>> };
    state.bindings[0]!['lease'] = lease;
    state.bindings[0]!['leaseOwner'] = ownerPid;
    let inferenceStarted = false;
    let rejection: unknown;
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
    });

    try {
      expect(inside(tempHome!, dirname(statePath))).toBe(true);
      writeFileSync(statePath, JSON.stringify(state), 'utf8');
      await withRoutingLease({ sessionId: launch.sessionId, modelId: binding.id,
        now: () => Date.parse(binding.expiresAt) + 1 }, async () => {
        inferenceStarted = true;
        return binding.id;
      }).then(() => undefined, error => { rejection = error; });

      expect(rejection).toMatchObject({ code: routingBindingErrors.leaseConflict, retryable: true });
      expect(inferenceStarted).toBe(false);
      expect(processKill).toHaveBeenCalledOnce();
      expect(processKill).toHaveBeenCalledWith(ownerPid, 0);
      const retainedState = JSON.parse(readFileSync(statePath, 'utf8')) as { bindings: Array<Record<string, unknown>> };
      expect(retainedState.bindings[0]).toMatchObject({ id: binding.id, lease, leaseOwner: ownerPid,
        decision: { target: binding.decision.target, reason: binding.decision.reason, effort: binding.decision.effort } });
    } finally {
      processKill.mockRestore();
      expect(inside(tempHome!, dirname(statePath))).toBe(true);
      writeFileSync(statePath, originalState, 'utf8');
    }
  });

  it('rejects launch identity reuse when the task has changed', async () => {
    const launch = launchInput('session-launch-mismatch', 'launch-reused-id');
    expectSessionStorageIsIsolated(launch.sessionId);
    await createRoutingBinding(launch);

    await expect(createRoutingBinding({ ...launch, task: 'A different accepted task' }))
      .rejects.toMatchObject({ code: routingBindingErrors.launchMismatch });
  });

  it('requires stored state before resuming a missing binding', async () => {
    const launch = launchInput('session-missing-resume', 'launch-not-persisted');
    expectSessionStorageIsIsolated(launch.sessionId);

    await expect(createRoutingBinding({ ...launch, resume: true }))
      .rejects.toMatchObject({ code: routingBindingErrors.resumeMissing });
  });

  it('rejects corrupted persisted binding state instead of allocating from it', async () => {
    const launch = launchInput('session-corrupt-binding-state', 'launch-corrupt-binding-state');
    expectSessionStorageIsIsolated(launch.sessionId);
    const statePath = routingBindingStatePath(launch.sessionId);

    await expect(createRoutingBinding(launch)).resolves.toMatchObject({ launchId: launch.launchId });
    const originalState = readFileSync(statePath, 'utf8');
    try {
      expect(inside(tempHome!, dirname(statePath))).toBe(true);
      writeFileSync(statePath, '{');

      await expect(createRoutingBinding({ ...launch, task: 'Do not use corrupted state' }))
        .rejects.toMatchObject({ code: routingBindingErrors.stateInvalid });
    } finally {
      writeFileSync(statePath, originalState);
    }
  });

  it('recovers a crashed selector reservation without changing its target or spending another call', async () => {
    const captured: { payload?: SelectorPayload; calls?: number } = {};
    const launch = selectorLaunchInput('session-stale-selector', 'launch-stale-selector', 'Select a worker', captured);
    expectSessionStorageIsIsolated(launch.sessionId);
    const statePath = routingBindingStatePath(launch.sessionId);
    const staleOwner = spawnSync(process.execPath, ['-e', '']).pid;
    expect(staleOwner).toBeGreaterThan(0);
    let markSelectorStarted!: () => void;
    let finishSelector!: (target: { providerId: string; modelId: string }) => void;
    const selectorStarted = new Promise<void>(resolve => { markSelectorStarted = resolve; });
    const selectorResult = new Promise<{ providerId: string; modelId: string }>(resolve => { finishSelector = resolve; });
    launch.selector.call = async (_target, payload) => {
      captured.payload = payload;
      captured.calls = (captured.calls ?? 0) + 1;
      markSelectorStarted();
      return selectorResult;
    };
    const accepted = createRoutingBinding(launch);
    await selectorStarted;
    const originalState = readFileSync(statePath, 'utf8');

    try {
      expect(inside(tempHome!, dirname(statePath))).toBe(true);
      const state = JSON.parse(originalState) as { bindings: Array<Record<string, unknown>> };
      state.bindings[0]!.pendingOwner = staleOwner;
      writeFileSync(statePath, JSON.stringify(state));

      const resumed = await createRoutingBinding({ ...launch, resume: true });

      expect(resumed.decision.target).toEqual(modelA);
      expect(resumed.selectorCalls).toBe(1);
      expect(captured.calls).toBe(1);
      finishSelector(modelA);
      await expect(accepted).resolves.toMatchObject({ decision: { target: modelA } });
    } finally {
      finishSelector(modelA);
      await accepted.catch(() => undefined);
      writeFileSync(statePath, originalState);
    }
  });

  it('keeps duplicate launches pending until the selector commits one binding', async () => {
    const captured: { payload?: SelectorPayload; calls?: number } = {};
    const launch = selectorLaunchInput('session-pending-selector', 'launch-pending-selector', 'Choose a worker', captured);
    expectSessionStorageIsIsolated(launch.sessionId);
    let markSelectorStarted!: () => void;
    let finishSelector!: (target: { providerId: string; modelId: string }) => void;
    const selectorStarted = new Promise<void>(resolve => { markSelectorStarted = resolve; });
    const selectorResult = new Promise<{ providerId: string; modelId: string }>(resolve => { finishSelector = resolve; });
    launch.selector.call = async (_target, payload) => {
      captured.payload = payload;
      captured.calls = (captured.calls ?? 0) + 1;
      markSelectorStarted();
      return selectorResult;
    };
    const accepted = createRoutingBinding(launch);

    try {
      await selectorStarted;
      await expect(createRoutingBinding(launch)).rejects.toMatchObject({ code: routingBindingErrors.pending });
      expect(captured.calls).toBe(1);
      finishSelector(modelB);
      const binding = await accepted;
      const resumed = await createRoutingBinding({ ...launch, resume: true });

      expect(binding.decision.target).toEqual(modelB);
      expect(binding.selectorCalls).toBe(1);
      expect(resumed.decision.target).toEqual(modelB);
      expect(resumed.selectorCalls).toBe(1);
      expect(captured.calls).toBe(1);
    } finally {
      finishSelector(modelB);
      await accepted.catch(() => undefined);
    }
  });

  it('rejects overlapping inference and allows a retry after the active request completes', async () => {
    const launch = launchInput('session-concurrent-inference', 'launch-concurrent-inference');
    expectSessionStorageIsIsolated(launch.sessionId);
    const binding = await createRoutingBinding(launch);
    const request = { sessionId: binding.sessionId, modelId: binding.id, now: launch.now };
    let markStarted!: () => void;
    let finishRequest!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const pending = new Promise<void>(resolve => { finishRequest = resolve; });
    const active = withRoutingLease(request, async current => {
      markStarted();
      await pending;
      return current.id;
    });
    await started;

    await expect(withRoutingLease(request, async current => current.id))
      .rejects.toMatchObject({ code: routingBindingErrors.leaseConflict, retryable: true });
    finishRequest();
    await expect(active).resolves.toBe(binding.id);
    await expect(withRoutingLease(request, async current => current.id)).resolves.toBe(binding.id);
  });

  it('keeps launch and selector notices ordered and deduplicated when recovery repeats the ensure step', async () => {
    const launch = { ...selectorLaunchInput('session-notice-recovery', 'launch-notice-recovery', 'Select a worker'),
      now: () => Date.now() };
    expectSessionStorageIsIsolated(launch.sessionId);
    const binding = await createRoutingBinding(launch);

    await withRoutingLease({ sessionId: binding.sessionId, modelId: binding.id, now: launch.now }, async leased => {
      const first = await ensureRoutingLaunchNotices({ sessionId: binding.sessionId, modelId: binding.id,
        leaseId: leased.lease!, revision: leased.revision });
      const recovery = await resolveRoutingRecovery({ sessionId: binding.sessionId, launchId: binding.launchId,
        marker: binding.id, sidecarValid: true });
      const repeated = await ensureRoutingLaunchNotices({ sessionId: binding.sessionId, modelId: binding.id,
        leaseId: leased.lease!, revision: leased.revision });
      const stored = listRoutingNotices(binding.sessionId, 0);

      expect(recovery).toMatchObject({ kind: 'bound', binding: { id: binding.id } });
      expect(first.map(notice => notice.kind)).toEqual(['launch', 'selector']);
      expect(first[0]!.sequence).toBeLessThan(first[1]!.sequence);
      expect(repeated).toEqual(first);
      expect(stored).toEqual(first);
    });
  });

  it('rejects an informational notice with an unrecognized stored field', async () => {
    const launch = { ...launchInput('session-unknown-informational-field', 'launch-unknown-informational-field'),
      now: () => Date.now() };
    expectSessionStorageIsIsolated(launch.sessionId);
    const binding = await createRoutingBinding(launch);
    const statePath = routingBindingStatePath(binding.sessionId);

    await withRoutingLease({ sessionId: binding.sessionId, modelId: binding.id, now: launch.now }, async leased => {
      await ensureRoutingLaunchNotices({ sessionId: binding.sessionId, modelId: binding.id,
        leaseId: leased.lease!, revision: leased.revision });
      const originalState = readFileSync(statePath, 'utf8');

      try {
        expect(inside(tempHome!, dirname(statePath))).toBe(true);
        const state = JSON.parse(originalState) as { notices: Array<Record<string, unknown>> };
        state.notices[0]!['unexpectedField'] = true;
        writeFileSync(statePath, JSON.stringify(state), 'utf8');

        await expect(resolveRoutingBinding({ sessionId: binding.sessionId, modelId: binding.id, now: launch.now }))
          .rejects.toMatchObject({ code: routingBindingErrors.stateInvalid });
      } finally {
        expect(inside(tempHome!, dirname(statePath))).toBe(true);
        writeFileSync(statePath, originalState, 'utf8');
      }
    });
  });

  it('loads a persisted fallback notice in its legacy public form', async () => {
    const requirements = { capabilities: [], contextTokens: 1_000 };
    const launch = { ...launchInput('session-legacy-fallback-notice', 'launch-legacy-fallback-notice'),
      now: () => Date.now(), requirements };
    launch.category = 'implementation';
    launch.config.categories = { ...launch.config.categories,
      implementation: { target: modelA, effort: 'low', fallbacks: [{ ...modelB, effort: 'low' }] } };
    for (const model of launch.catalog.models) {
      model.contextWindow = 90_000;
      model.contextWindowConfirmed = true;
      model.maxOutputTokens = 12_000;
    }
    expectSessionStorageIsIsolated(launch.sessionId);
    const binding = await createRoutingBinding(launch);

    await withRoutingLease({ sessionId: binding.sessionId, modelId: binding.id, now: launch.now }, async leased => {
      const fallback = await advanceRoutingFallback({ sessionId: binding.sessionId, modelId: binding.id,
        leaseId: leased.lease!, revision: leased.revision,
        failure: { reason: 'quota_exhausted', acceptance: 'rejected', response: 'clear', output: 'none', tool: 'none' },
        catalog: launch.catalog, workload, requirements, maxOutputTokens: workload.output!,
        deadline: Date.parse(binding.expiresAt), signal: new AbortController().signal, now: launch.now });
      const recovered = await resolveRoutingBinding({ sessionId: binding.sessionId, modelId: binding.id, now: launch.now });
      const notices = listRoutingNotices(binding.sessionId, 0);

      expect(recovered.pendingNotice).toMatchObject({ previous: modelA, target: modelB,
        sequence: fallback.pendingNotice!.sequence, acknowledged: false });
      expect(notices).toContainEqual(expect.objectContaining({ previous: modelA, target: modelB,
        sequence: fallback.pendingNotice!.sequence }));
    });
  });

  it('releases the inference lease when the active action is canceled', async () => {
    const launch = launchInput('session-canceled-inference', 'launch-canceled-inference');
    expectSessionStorageIsIsolated(launch.sessionId);
    const binding = await createRoutingBinding(launch);
    const request = { sessionId: binding.sessionId, modelId: binding.id, now: launch.now };

    await expect(withRoutingLease(request, async () => {
      throw Object.assign(new Error('fixture cancellation'), { name: 'AbortError' });
    })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(withRoutingLease(request, async current => current.id)).resolves.toBe(binding.id);
  });
