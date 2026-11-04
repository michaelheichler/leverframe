import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { expect, it } from 'vitest';
import { buildRoutingCatalog, prepareRoutingHandoff, type RoutingConfig } from '../src/model-routing.js';
import { getAppHome } from '../src/paths.js';
import { MAX_DOCUMENT_BYTES } from '../src/checkpoint-store.js';
import {
  createRoutingBinding,
  resolveRoutingBinding,
  routingBindingErrors,
  routingBindingStatePath,
} from '../src/routing-bindings.js';
import { input, observation, provider } from './model-routing-fixtures.js';

const outerHome = process.env['LEVERFRAME_TEST_HOME'];
const target = { providerId: 'fixture-handoff-binding-provider', modelId: 'fixture-handoff-binding-model' };

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function assertStatePathIsIsolated(sessionId: string): string {
  const statePath = routingBindingStatePath(sessionId);
  expect(outerHome).toBeTruthy();
  expect(inside(outerHome!, getAppHome())).toBe(true);
  expect(inside(outerHome!, dirname(statePath))).toBe(true);
  return statePath;
}

function bindingInput() {
  const registeredProvider = provider({
    id: target.providerId,
    templateId: 'fixture',
    modelsCache: {
      fetchedAt: '2026-10-01T00:00:00.000Z',
      source: 'account',
      models: [{ id: target.modelId, name: target.modelId, upstreamModelId: 'fixture-handoff-upstream',
        modelFormat: 'anthropic', contextWindow: 70_000, outputTokenLimit: 8_192, supportedReasoningEfforts: ['low'],
        pricing: { input: 2, output: 8, source: 'fixture-pricing' } }],
    },
  });
  const catalog = buildRoutingCatalog(input([registeredProvider], {
    credentials: [observation(registeredProvider.id)],
    discovery: [{ providerId: registeredProvider.id, status: 'live', cacheFetchedAt: '2026-10-01T00:00:00.000Z' }],
  }));
  const config: RoutingConfig = {
    enabled: true,
    cheapFallback: target,
    pool: [target],
    defaultCategory: 'review',
    agentCategories: { reviewer: 'review' },
    categories: { review: { target, effort: 'low', instructions: 'Check the requested behavior and its edge cases.' } },
  };
  const prepared = prepareRoutingHandoff({
    policy: { version: 1, defaultCategory: 'review', agentCategories: { reviewer: 'review' },
      categoryInstructions: { review: 'Check the requested behavior and its edge cases.' } },
    agentType: 'reviewer',
    explicitCategory: 'review',
    delegatedTask: 'Review the accepted task.',
    originalTask: 'Keep parser response order stable.',
    requiredConstraints: ['Preserve response order.'],
    toolInstructions: ['Read source before making changes.'],
    evidence: [{ source: 'tool-result', content: 'The parser preserves source order.' }],
    jobState: 'One compatibility case remains open.',
  });
  const reviewedTask = JSON.stringify(prepared.envelope);
  const handoff = { version: 1 as const, agentType: 'reviewer', reviewedTask,
    prefix: prepared.envelope.prefix, provenance: 'explicit' as const };
  return {
    sessionId: randomUUID(),
    launchId: randomUUID(),
    role: 'specialist' as const,
    category: 'review',
    agentType: 'reviewer',
    task: reviewedTask,
    handoff,
    config,
    catalog,
    workload: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
  };
}

function createBinding(input: Parameters<typeof createRoutingBinding>[0]) {
  return createRoutingBinding(input);
}

function findCheckpointFile(directory: string, content: string): string {
  const candidates = readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? [findCheckpointFile(path, content)] : [path];
  });
  return candidates.find(path => readFileSync(path, 'utf8').includes(content)) ?? '';
}

function checkpointFileSnapshot(directory: string) {
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => ({ name: entry.name, digest: createHash('sha256').update(readFileSync(join(directory, entry.name))).digest('hex') }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function largeBindingInput(sessionId: string, index: number) {
  const launch = bindingInput();
  const delegatedTask = `delegated-${index}-`.padEnd(26_000, 'd');
  const originalTask = `original-${index}-`.padEnd(26_000, 'o');
  const jobState = `state-${index}-`.padEnd(26_000, 's');
  const prepared = prepareRoutingHandoff({
    policy: { version: 1, defaultCategory: 'review', agentCategories: { reviewer: 'review' },
      categoryInstructions: { review: 'Check the requested behavior and its edge cases.' } },
    agentType: 'reviewer', explicitCategory: 'review', delegatedTask, originalTask,
    requiredConstraints: ['Preserve response order.'], toolInstructions: ['Read source before making changes.'],
    evidence: [{ source: 'tool-result', content: 'The parser preserves source order.' }], jobState,
  });
  const reviewedTask = JSON.stringify(prepared.envelope);
  return { ...launch, sessionId, launchId: randomUUID(), task: reviewedTask,
    handoff: { version: 1 as const, agentType: 'reviewer', reviewedTask, prefix: prepared.envelope.prefix,
      provenance: 'explicit' as const } };
}

function capacityBindingInput(sessionId: string, index: number) {
  const launch = bindingInput();
  const category = 'c'.repeat(4096);
  const launchId = `launch-${index}-`.padEnd(4096, 'l');
  const policy = { version: 1 as const, defaultCategory: category, agentCategories: { reviewer: category },
    categoryInstructions: { [category]: 'Review the accepted task.' } };
  const prepared = prepareRoutingHandoff({ policy, agentType: 'reviewer', explicitCategory: category,
    delegatedTask: `Review the bounded task ${index}.`, originalTask: `Preserve the accepted behavior ${index}.`,
    requiredConstraints: ['Keep the existing response order.'], toolInstructions: ['Read source before changes.'],
    evidence: [{ source: 'tool-result', content: `The fixture records current behavior ${index}.` }],
    jobState: `No open subtask ${index}.` });
  const reviewedTask = JSON.stringify(prepared.envelope);
  return { ...launch, sessionId, launchId, category, task: reviewedTask,
    handoff: { version: 1 as const, agentType: 'reviewer', reviewedTask, prefix: prepared.envelope.prefix,
      provenance: 'explicit' as const },
    config: { ...launch.config, defaultCategory: category, agentCategories: { reviewer: category },
      categories: { [category]: { target, effort: 'low' as const, instructions: 'Review the accepted task.' } } } };
}

type SavedBinding = Record<string, unknown>;

function writeCorruptedBinding(statePath: string, bindingId: string, handoff: ReturnType<typeof bindingInput>['handoff'],
  corrupt: (binding: SavedBinding) => void): string {
  const original = readFileSync(statePath, 'utf8');
  const state = JSON.parse(original) as { bindings: SavedBinding[] };
  const binding = state.bindings.find(item => item['id'] === bindingId);
  if (!binding) throw new Error('Expected fixture binding is unavailable.');
  binding['handoff'] = structuredClone(handoff);
  corrupt(binding);
  writeFileSync(statePath, JSON.stringify(state), 'utf8');
  return original;
}

it('persists the reviewed task, frozen prefix, and category provenance with the binding', async () => {
  const launch = bindingInput();
  assertStatePathIsIsolated(launch.sessionId);

  const binding = await createBinding(launch);

  expect((binding as unknown as { handoff?: unknown }).handoff).toEqual(launch.handoff);
  expect(binding.taskDigest).toBe(createHash('sha256').update(launch.handoff.reviewedTask).digest('hex'));
  expect(JSON.stringify(binding.decision.events)).not.toContain(launch.handoff.reviewedTask);
});

it('keeps generic binding callers without a saved handoff', async () => {
  const launch = bindingInput();
  const { handoff: _handoff, ...genericLaunch } = launch;
  assertStatePathIsIsolated(launch.sessionId);

  const binding = await createRoutingBinding(genericLaunch as unknown as Parameters<typeof createRoutingBinding>[0]);

  expect((binding as unknown as { handoff?: unknown }).handoff).toBeUndefined();
});

it('resumes with a changed task and policy while keeping the original frozen handoff', async () => {
  const launch = bindingInput();
  assertStatePathIsIsolated(launch.sessionId);
  const accepted = await createBinding(launch);
  const changedConfig = { ...launch.config, enabled: false, defaultCategory: 'implementation',
    agentCategories: { reviewer: 'implementation' }, categories: {
      implementation: { target, effort: 'high' as const, instructions: 'The current configuration changed.' },
    } };
  const { handoff: _handoff, ...resumeLaunch } = launch;

  const resumed = await createBinding({ ...resumeLaunch, task: 'Continue with the compatibility follow-up.',
    category: 'implementation', config: changedConfig, resume: true });

  expect({ resumedId: resumed.id, acceptedId: accepted.id, resumedDigest: resumed.taskDigest,
    acceptedDigest: accepted.taskDigest, handoff: (resumed as unknown as { handoff?: unknown }).handoff })
    .toEqual({ resumedId: accepted.id, acceptedId: accepted.id, resumedDigest: accepted.taskDigest,
      acceptedDigest: accepted.taskDigest, handoff: launch.handoff });
});

it('stores and hydrates several large handoffs without exhausting the session index', async () => {
  const sessionId = randomUUID();
  const launches = Array.from({ length: 7 }, (_, index) => largeBindingInput(sessionId, index));
  assertStatePathIsIsolated(sessionId);

  const created = await Promise.all(launches.map(createBinding));
  const hydrated = await Promise.all(created.map(binding => resolveRoutingBinding({ sessionId, modelId: binding.id })));

  expect(hydrated.map(binding => binding.handoff?.reviewedTask)).toEqual(launches.map(launch => launch.handoff.reviewedTask));
});

it('resumes a large saved handoff with a follow-up task without changing its reviewed contract', async () => {
  const launch = largeBindingInput(randomUUID(), 1);
  assertStatePathIsIsolated(launch.sessionId);

  const accepted = await createBinding(launch);
  const resumed = await createBinding({ ...launch, task: 'Continue from the saved review.', resume: true } as ReturnType<typeof bindingInput>);

  expect({ id: resumed.id, taskDigest: resumed.taskDigest, handoff: resumed.handoff }).toEqual({
    id: accepted.id, taskDigest: accepted.taskDigest, handoff: launch.handoff,
  });
});

it('returns the same accepted handoff when identical launches race', async () => {
  const launch = largeBindingInput(randomUUID(), 2);
  assertStatePathIsIsolated(launch.sessionId);

  const [first, retry] = await Promise.all([createBinding(launch), createBinding(launch)]);

  expect({ firstId: first.id, retryId: retry.id, firstHandoff: first.handoff, retryHandoff: retry.handoff })
    .toEqual({ firstId: retry.id, retryId: first.id, firstHandoff: launch.handoff, retryHandoff: launch.handoff });
});

it('rejects an index-overflowing launch without changing prior bytes or hiding accepted bindings', async () => {
  const sessionId = randomUUID();
  const statePath = assertStatePathIsIsolated(sessionId);
  try {
    const firstLaunch = capacityBindingInput(sessionId, 0);
    const accepted = await createRoutingBinding(firstLaunch as unknown as Parameters<typeof createRoutingBinding>[0]);
    const additionalCount = Math.ceil(MAX_DOCUMENT_BYTES / (2 * 4096)) + 5;
    const launches = Array.from({ length: additionalCount }, (_, index) => capacityBindingInput(sessionId, index + 1));
    await Promise.allSettled(launches.map(launch => createRoutingBinding(launch as unknown as Parameters<typeof createRoutingBinding>[0])));
    const previousBytes = readFileSync(statePath);
    const previousDocuments = checkpointFileSnapshot(dirname(statePath));
    const overflowing = capacityBindingInput(sessionId, additionalCount + 1);

    await expect(createRoutingBinding(overflowing as unknown as Parameters<typeof createRoutingBinding>[0]))
      .rejects.toMatchObject({ code: routingBindingErrors.capacity });
    expect(readFileSync(statePath)).toEqual(previousBytes);
    expect(checkpointFileSnapshot(dirname(statePath))).toEqual(previousDocuments);
    const resumeLaunch = { ...firstLaunch, task: 'Continue the accepted compatibility review.', resume: true } as unknown as Parameters<typeof createRoutingBinding>[0];
    const resumed = await createRoutingBinding(resumeLaunch);
    expect({ id: resumed.id, handoff: resumed.handoff }).toEqual({ id: accepted.id, handoff: accepted.handoff });
    await expect(resolveRoutingBinding({ sessionId, modelId: accepted.id })).resolves.toMatchObject({ id: accepted.id });
  } finally {
    rmSync(dirname(statePath), { recursive: true, force: true });
  }
});

it('rejects a missing saved handoff document before resolving its model', async () => {
  const launch = largeBindingInput(randomUUID(), 3);
  const statePath = assertStatePathIsIsolated(launch.sessionId);
  const binding = await createBinding(launch);
  const checkpointFile = findCheckpointFile(dirname(statePath), 'original-3-');
  const original = readFileSync(checkpointFile);

  try {
    expect(inside(outerHome!, checkpointFile)).toBe(true);
    expect(checkpointFile).not.toBe(statePath);
    unlinkSync(checkpointFile);

    await expect(resolveRoutingBinding({ sessionId: launch.sessionId, modelId: binding.id }))
      .rejects.toMatchObject({ code: routingBindingErrors.stateInvalid });
  } finally {
    writeFileSync(checkpointFile, original);
  }
});

it('rejects a changed saved handoff document before resolving its model', async () => {
  const launch = largeBindingInput(randomUUID(), 4);
  const statePath = assertStatePathIsIsolated(launch.sessionId);
  const binding = await createBinding(launch);
  const checkpointFile = findCheckpointFile(dirname(statePath), 'original-4-');
  const original = readFileSync(checkpointFile);

  try {
    expect(inside(outerHome!, checkpointFile)).toBe(true);
    expect(checkpointFile).not.toBe(statePath);
    writeFileSync(checkpointFile, Buffer.concat([original, Buffer.from('changed')]));

    await expect(resolveRoutingBinding({ sessionId: launch.sessionId, modelId: binding.id }))
      .rejects.toMatchObject({ code: routingBindingErrors.stateInvalid });
  } finally {
    writeFileSync(checkpointFile, original);
  }
});

it('rejects checkpoint state that embeds a handoff and also references one', async () => {
  const launch = largeBindingInput(randomUUID(), 5);
  const statePath = assertStatePathIsIsolated(launch.sessionId);
  const binding = await createBinding(launch);
  const original = readFileSync(statePath, 'utf8');
  const state = JSON.parse(original) as { bindings: Array<Record<string, unknown>> };
  const savedBinding = state.bindings.find(item => item['id'] === binding.id)!;

  try {
    expect(inside(outerHome!, statePath)).toBe(true);
    savedBinding['handoff'] = launch.handoff;
    writeFileSync(statePath, JSON.stringify(state), 'utf8');

    await expect(resolveRoutingBinding({ sessionId: launch.sessionId, modelId: binding.id }))
      .rejects.toMatchObject({ code: routingBindingErrors.stateInvalid });
  } finally {
    writeFileSync(statePath, original, 'utf8');
  }
});

it.each([
  { label: 'reviewed task', corrupt: (binding: SavedBinding) => {
    const handoff = binding['handoff'] as Record<string, unknown>;
    const envelope = JSON.parse(String(handoff['reviewedTask'])) as Record<string, unknown>;
    const task = envelope['task'] as Record<string, unknown>;
    handoff['reviewedTask'] = JSON.stringify({ ...envelope, task: { ...task, originalTask: 'Changed original task.' } });
  } },
  { label: 'frozen prefix', corrupt: (binding: SavedBinding) => {
    const handoff = binding['handoff'] as Record<string, unknown>;
    handoff['prefix'] = { ...(handoff['prefix'] as Record<string, unknown>), stableInstructions: [] };
  } },
  { label: 'task digest', corrupt: (binding: SavedBinding) => {
    binding['taskDigest'] = createHash('sha256').update('different reviewed task').digest('hex');
  } },
  { label: 'category', corrupt: (binding: SavedBinding) => { binding['category'] = 'implementation'; } },
])('rejects a saved binding with a tampered $label before resolving it', async ({ corrupt }) => {
  const launch = bindingInput();
  const statePath = assertStatePathIsIsolated(launch.sessionId);
  const binding = await createBinding(launch);
  const original = writeCorruptedBinding(statePath, binding.id, launch.handoff, corrupt);

  try {
    await expect(resolveRoutingBinding({ sessionId: launch.sessionId, modelId: binding.id }))
      .rejects.toMatchObject({ code: routingBindingErrors.stateInvalid });
  } finally {
    writeFileSync(statePath, original, 'utf8');
  }
});
