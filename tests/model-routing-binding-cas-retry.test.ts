import { randomUUID } from 'node:crypto';
import { dirname, relative, sep } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildRoutingCatalog, prepareRoutingHandoff, type RoutingConfig } from '../src/model-routing.js';
import { getAppHome } from '../src/paths.js';
import { createRoutingBinding, resolveRoutingBinding, routingBindingStatePath } from '../src/routing-bindings.js';
import { input, observation, provider } from './model-routing-fixtures.js';

const state = vi.hoisted(() => ({ indexPath: '', remainingConflicts: 0, conflictsInjected: 0, conflictAfterBlob: false,
  indexWrites: 0, documentWrites: 0 }));

vi.mock('../src/checkpoint-store.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/checkpoint-store.js')>();
  return {
    ...actual,
    writeDocumentCAS: (path: string, ...args: unknown[]) => {
      if (path === state.indexPath) {
        state.indexWrites++;
        if (state.remainingConflicts > 0) {
          state.remainingConflicts--;
          state.conflictsInjected++;
          state.conflictAfterBlob = state.documentWrites > 0;
          return { ok: false, reason: 'conflict' };
        }
      } else {
        state.documentWrites++;
      }
      return actual.writeDocumentCAS(...[path, ...args] as Parameters<typeof actual.writeDocumentCAS>);
    },
  };
});

const outerHome = process.env['LEVERFRAME_TEST_HOME'];
const target = { providerId: 'fixture-cas-provider', modelId: 'fixture-cas-model' };
const observedAt = '2026-10-01T00:00:00.000Z';

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function launchInput(sessionId: string, launchId: string, task: string) {
  const registeredProvider = provider({
    id: target.providerId,
    templateId: 'fixture',
    modelsCache: { fetchedAt: observedAt, source: 'account', models: [{ id: target.modelId, name: target.modelId,
      upstreamModelId: 'fixture-cas-upstream', modelFormat: 'anthropic', contextWindow: 70_000,
      outputTokenLimit: 8_192, supportedReasoningEfforts: ['low', 'high'], reasoning: true,
      pricing: { input: 2, output: 8, source: 'fixture-pricing', observedAt } }] },
  });
  const catalog = buildRoutingCatalog(input([registeredProvider], {
    credentials: [observation(registeredProvider.id)],
    discovery: [{ providerId: registeredProvider.id, status: 'live', cacheFetchedAt: observedAt }],
  }));
  const instructions = 'Review the requested behavior and preserve its constraints.';
  const config: RoutingConfig = { enabled: true, cheapFallback: target, pool: [target], defaultCategory: 'review',
    categories: { review: { target, effort: 'low', instructions,
      alternatingTargets: [{ ...target, effort: 'low' }, { ...target, effort: 'high' }] } } };
  const policy = { version: 1 as const, defaultCategory: 'review', agentCategories: { reviewer: 'review' },
    categoryInstructions: { review: instructions } };
  const prepared = prepareRoutingHandoff({ policy, agentType: 'reviewer', explicitCategory: 'review',
    delegatedTask: task, originalTask: task, requiredConstraints: ['Preserve response order.'],
    toolInstructions: ['Read source before changes.'], evidence: [{ source: 'tool-result', content: `Evidence for ${task}.` }],
    jobState: 'No open subtask.' });
  const reviewedTask = JSON.stringify(prepared.envelope);
  return { sessionId, launchId, role: 'specialist' as const, category: 'review', agentType: 'reviewer', task: reviewedTask,
    handoff: { version: 1 as const, agentType: 'reviewer', reviewedTask, prefix: prepared.envelope.prefix,
      provenance: 'explicit' as const }, config, catalog, workload: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 } };
}

it('retries a routing index conflict without duplicating the handoff or consuming another arm', async () => {
  const sessionId = randomUUID();
  const path = routingBindingStatePath(sessionId);
  expect(outerHome).toBeTruthy();
  expect(inside(outerHome!, getAppHome())).toBe(true);
  expect(inside(outerHome!, dirname(path))).toBe(true);
  state.indexPath = path;
  state.remainingConflicts = 1;
  const firstInput = launchInput(sessionId, randomUUID(), 'Review the parser response order.');

  const first = await createRoutingBinding(firstInput);
  const retry = await createRoutingBinding({ ...firstInput, resume: true });
  const next = await createRoutingBinding(launchInput(sessionId, randomUUID(), 'Review the next parser change.'));
  const resolved = await resolveRoutingBinding({ sessionId, modelId: first.id });

  expect({ conflictsInjected: state.conflictsInjected, conflictAfterBlob: state.conflictAfterBlob,
    indexWrites: state.indexWrites, handoffWrites: state.documentWrites, firstArm: first.arm, retryId: retry.id,
    nextArm: next.arm, resolvedHandoff: resolved.handoff }).toEqual({
    conflictsInjected: 1,
    conflictAfterBlob: true,
    indexWrites: 4,
    handoffWrites: 2,
    firstArm: 0,
    retryId: first.id,
    nextArm: 1,
    resolvedHandoff: firstInput.handoff,
  });
});
