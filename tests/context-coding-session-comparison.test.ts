import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { KeyringOperation, KeyringResult } from '../src/keyring-operations.js';
import { estimateAnthropicInputTokens } from '../src/anthropic-endpoints.js';
import { applyRequestContextPolicy } from '../src/context/request-policy.js';
import { openEvidenceStore } from '../src/context/evidence-runtime.js';
import { savePreferences } from '../src/config.js';
import type { AnthropicMessage } from '../src/context/anthropic-context-groups.js';
import { paidEngine, sourceMessages } from './fixtures/context-summary-fixtures.js';

const summaryState = vi.hoisted(() => ({ engine: undefined as unknown }));
const memoryKeyring = vi.hoisted(() => ({ entries: new Map<string, string>() }));

vi.mock('../src/keyring-operations.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/keyring-operations.js')>()),
  runIsolatedKeyringOperation: vi.fn(async (input: KeyringOperation): Promise<KeyringResult> => {
    const key = `${input.service}:${input.account}`;
    if (input.operation === 'read' || input.operation === 'peek') {
      return { ok: true, value: memoryKeyring.entries.get(key) ?? null };
    }
    if (input.operation === 'write') memoryKeyring.entries.set(key, input.value);
    if (input.operation === 'delete') memoryKeyring.entries.delete(key);
    return { ok: true, value: null };
  }),
}));

vi.mock('../src/context/paid-summary-engine.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/context/paid-summary-engine.js')>()),
  configuredPaidSummaryEngine: vi.fn(() => summaryState.engine),
}));

function codingRequest() {
  const messages = sourceMessages().slice(1);
  const lookupResult = 'The search found src/context/request-policy.ts and confirmed the request policy preserves current behavior. '.repeat(200);
  messages[3] = {
    ...messages[3],
    content: [{ type: 'tool_result', tool_use_id: 'tool-old', content: lookupResult }],
  };
  messages.splice(4, 0,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-old-duplicate', name: 'search', input: { query: 'historical result' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-old-duplicate', content: lookupResult }] },
  );
  messages.splice(6, 0,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-middle', name: 'search', input: { query: 'current source context' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-middle', content: 'The source lookup found a second file referencing request context. '.repeat(250) }] },
  );
  return {
    model: 'fixture-model',
    system: 'Instructions: preserve user decisions, unresolved errors, source lookup facts, and tool topology. Objective: inspect context optimization without losing recent instructions.',
    messages: messages as AnthropicMessage[],
  };
}

function synopsis(sourceIds: readonly string[]) {
  const item = (text: string) => ({ text, sourceIds });
  return {
    version: 1 as const,
    taskGoal: 'Objective: inspect context optimization without losing recent instructions.',
    userDecisions: [item('Keep this earlier assistant decision verbatim.')],
    constraints: [item('Preserve the public request behavior and recent context.')],
    verifiedFacts: [item('The search found src/context/request-policy.ts and confirmed the request policy preserves current behavior.')],
    files: [{ path: 'src/context/request-policy.ts', relation: 'referenced' as const, sourceIds }],
    toolOutcomes: [item('Search completed the historical source lookup.') as { text: string; sourceIds: readonly string[]; status?: string }]
      .map(result => ({ ...result, status: 'succeeded' as const })),
    unresolved: [item('The failed lookup error must stay visible.')],
    failedApproaches: [item('Do not claim that the failed lookup verified the source.')],
    nextActions: [item('Review the referenced policy before changing behavior.')],
    chronology: [{ ...item('The source search preceded the failed read.'), order: 0 }],
  };
}

function features(text: string) {
  return {
    instructions: text.includes('Instructions: preserve user decisions'),
    objective: text.includes('Objective: inspect context optimization'),
    decision: text.includes('Keep this earlier assistant decision verbatim.'),
    unresolvedError: text.includes('The failed lookup error must stay visible.'),
    sourceLookup: text.includes('src/context/request-policy.ts'),
    recentContext: text.includes('Keep this latest user prose verbatim.'),
    searchTopology: (text.includes('tool-old') && text.includes('tool-old-duplicate'))
      || text.includes('Search completed the historical source lookup.'),
    failedToolPair: text.includes('tool-error') && text.includes('failed lookup error'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function duplicateEvidence(request: ReturnType<typeof codingRequest>, sessionId: string): Promise<string> {
  const block = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .find(item => isRecord(item) && item.type === 'tool_result' && item.tool_use_id === 'tool-old-duplicate');
  const content = isRecord(block) ? block.content : undefined;
  const reference = typeof content === 'string' ? content.match(/lfe1_[a-f0-9]{48}/)?.[0] : undefined;
  return reference ? (await (await openEvidenceStore()).get(sessionId, reference) ?? '') : '';
}

async function runPolicy(request: ReturnType<typeof codingRequest>, sessionId: string) {
  return applyRequestContextPolicy({
    request, sessionId, routeIdentity: 'fixture-route', contextWindow: 128_000,
    signal: new AbortController().signal,
  });
}

async function runModes(request: ReturnType<typeof codingRequest>) {
  savePreferences({ summarySettings: { enabled: false } });
  const deterministic = await runPolicy(request, 'coding-deterministic-session');
  const auxiliarySource = { bytes: 0, sourceOnlyTokenEstimate: 0 };
  const summaryCalls = { count: 0 };
  summaryState.engine = paidEngine(async input => {
    summaryCalls.count += 1;
    auxiliarySource.bytes = Buffer.byteLength(input.sourceText);
    auxiliarySource.sourceOnlyTokenEstimate = Math.ceil(auxiliarySource.bytes / 4);
    return { synopsis: synopsis(input.sourceIds), sourceIds: input.sourceIds, usage: { inputTokens: 90, outputTokens: 30 } };
  });
  savePreferences({ summarySettings: {
    enabled: true, engineId: 'fixture:paid-summary', lifetimeLimitMicros: 100_000,
    pricing: { inputMicrosPerMillion: 1_000, outputMicrosPerMillion: 1_000, provenance: 'fictional offline rate card' },
  } });
  const summary = await runPolicy(request, 'coding-summary-session');
  return { deterministic, summary, auxiliarySource, summaryCalls };
}

async function assertProtectedContext(request: ReturnType<typeof codingRequest>, modes: Awaited<ReturnType<typeof runModes>>): Promise<void> {
  const originalFacts = features(JSON.stringify(request));
  const deterministicFacts = features(JSON.stringify(modes.deterministic.request)
    + await duplicateEvidence(modes.deterministic.request, 'coding-deterministic-session'));
  const summaryFacts = features(JSON.stringify(modes.summary.request));
  const expected = {
    instructions: true, objective: true, decision: true, unresolvedError: true,
    sourceLookup: true, recentContext: true, searchTopology: true, failedToolPair: true,
  };
  expect(originalFacts).toEqual(expected);
  expect(deterministicFacts).toEqual(expected);
  expect(summaryFacts).toEqual(expected);
}

function assertUsageAccounting(
  request: ReturnType<typeof codingRequest>,
  modes: Awaited<ReturnType<typeof runModes>>,
  cachedSummary: Awaited<ReturnType<typeof runPolicy>>,
): void {
  const taskOneFakeMainOutput = 12;
  const mainOffEstimate = estimateAnthropicInputTokens(request);
  const deterministicEstimate = estimateAnthropicInputTokens(modes.deterministic.request);
  const summaryMainEstimate = estimateAnthropicInputTokens(modes.summary.request);
  const cachedSummaryMainEstimate = estimateAnthropicInputTokens(cachedSummary.request);
  const syntheticSummaryOutput = modes.summary.summaryUsage?.outputTokens ?? 0;
  const firstSummarySourceOnlyLowerBound = summaryMainEstimate + modes.auxiliarySource.sourceOnlyTokenEstimate
    + syntheticSummaryOutput + taskOneFakeMainOutput;
  const twoTurnSummarySourceOnlyLowerBound = firstSummarySourceOnlyLowerBound + cachedSummaryMainEstimate + taskOneFakeMainOutput;
  const twoTurnDeterministicTotal = 2 * (deterministicEstimate + taskOneFakeMainOutput);
  const twoTurnUnchangedTotal = 2 * (mainOffEstimate + taskOneFakeMainOutput);

  expect(modes.deterministic.outcome).toBe('reduced');
  expect(modes.deterministic.summaryUsage).toBeUndefined();
  expect(modes.summary.outcome).toBe('reduced');
  expect(modes.summary.summaryUsage).toMatchObject({ inputTokens: 90, outputTokens: 30, costMicros: 1 });
  expect(modes.summary.summaryChargedMicros).toBe(modes.summary.summaryUsage?.costMicros);
  expect(cachedSummary.summaryUsage).toBeUndefined();
  expect(cachedSummary.summaryChargedMicros).toBeUndefined();
  expect(modes.summaryCalls.count).toBe(1);
  expect(modes.auxiliarySource.sourceOnlyTokenEstimate).toBeGreaterThan(modes.summary.summaryUsage!.inputTokens);
  expect(deterministicEstimate).toBeLessThan(mainOffEstimate);
  expect(summaryMainEstimate).toBeLessThan(deterministicEstimate);
  expect(firstSummarySourceOnlyLowerBound).toBeGreaterThan(deterministicEstimate + taskOneFakeMainOutput);
  expect(firstSummarySourceOnlyLowerBound).toBeLessThan(mainOffEstimate + taskOneFakeMainOutput);
  expect(cachedSummaryMainEstimate).toBe(summaryMainEstimate);
  expect(twoTurnSummarySourceOnlyLowerBound).toBeLessThan(twoTurnDeterministicTotal);
  expect(twoTurnDeterministicTotal).toBeLessThan(twoTurnUnchangedTotal);
}

it('compares coding context and estimated net usage across unchanged, deterministic, and summary modes', async () => {
  const previousHome = process.env.LEVERFRAME_HOME;
  const home = mkdtempSync(join(tmpdir(), 'leverframe-coding-comparison-'));
  process.env.LEVERFRAME_HOME = home;
  const request = codingRequest();
  memoryKeyring.entries.clear();

  try {
    const modes = await runModes(request);
    expect(modes.summary.summaryUsage).toMatchObject({ inputTokens: 90, outputTokens: 30 });
    const cachedSummary = await runPolicy(request, 'coding-summary-session');
    expect(cachedSummary.request).toEqual(modes.summary.request);
    expect(features(JSON.stringify(cachedSummary.request))).toEqual(features(JSON.stringify(modes.summary.request)));
    await assertProtectedContext(request, modes);
    assertUsageAccounting(request, modes, cachedSummary);
  } finally {
    summaryState.engine = undefined;
    memoryKeyring.entries.clear();
    if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
    else process.env.LEVERFRAME_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
