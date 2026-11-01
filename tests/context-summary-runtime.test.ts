import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { applySummaryStage, type SummaryOptions } from '../src/context/summary-engine.js';
import { groupAnthropicContext } from '../src/context/anthropic-context-groups.js';
import { createEvidenceStore } from '../src/context/evidence-store.js';
import { isLeverframeSummaryMessage, type CompactionMessage } from '../src/context/request-compaction.js';
import { reserveSummarySpend } from '../src/context/summary-spend.js';
import { fixtureEngine, fixtureStore, paidEngine, sourceMessages, stageOptions, synopsis } from './fixtures/context-summary-fixtures.js';

const temporaryHomes: string[] = [];
const originalAppHome = process.env['LEVERFRAME_HOME'];

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalAppHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = originalAppHome;
  temporaryHomes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true }));
});

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-summary-runtime-'));
  temporaryHomes.push(home);
  vi.stubEnv('LEVERFRAME_HOME', home);
  return home;
}

it('summarizes only older completed tool groups and preserves ordinary prose and the recent tail', async () => {
  const home = temporaryHome();
  const request = { model: 'fixture-model', max_tokens: 200, system: sourceMessages()[0].content, messages: sourceMessages().slice(1) };
  const context = groupAnthropicContext(request.messages);
  const oldToolGroup = context.groups.find(group => group.kind === 'tool_pair');
  expect(oldToolGroup).toBeDefined();
  const engine = fixtureEngine(async input => ({
    synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds,
    usage: { inputTokens: 90, outputTokens: 30 },
  }));

  const result = await applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store: fixtureStore(home), signal: new AbortController().signal, options: stageOptions(),
  });

  expect(result.summarized).toBe(true);
  expect(result.request.system).toBe(request.system);
  expect(result.request.messages).toContainEqual(request.messages[0]);
  expect(result.request.messages).toContainEqual(request.messages[1]);
  expect(result.request.messages).toContainEqual(request.messages.at(-1));
  expect(result.request.messages).toContainEqual(request.messages.at(-2));
  expect(JSON.stringify(result.request.messages)).toContain('Recent result stays available.');
  expect(JSON.stringify(result.request.messages)).toContain('opaque provider state');
});

it('passes bounded source text and token limits to the engine without mixing unrelated prose', async () => {
  const home = temporaryHome();
  const request = { model: 'fixture-model', max_tokens: 200, messages: sourceMessages().slice(1) };
  const observed: Array<{ sourceText: string; sourceIds: readonly string[]; maxInputTokens: number; maxOutputTokens: number }> = [];
  const engine = fixtureEngine(async input => {
    observed.push(input);
    return { synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds, usage: { inputTokens: 90, outputTokens: 30 } };
  });

  await applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store: fixtureStore(home), signal: new AbortController().signal, options: stageOptions(),
  });

  expect(observed).toHaveLength(1);
  expect(observed[0].maxInputTokens).toBe(stageOptions().maxInputTokens);
  expect(observed[0].maxOutputTokens).toBe(stageOptions().maxOutputTokens);
  expect(Buffer.byteLength(observed[0].sourceText, 'utf8')).toBeLessThanOrEqual(stageOptions().maxInputTokens * 8);
  expect(observed[0].sourceText).not.toContain('Keep this earlier user prose verbatim.');
  expect(observed[0].sourceIds).toEqual([groupAnthropicContext(request.messages).groups.find(group => group.kind === 'tool_pair')?.sourceDigest]);
});

it('does not dispatch when a selected source exceeds the input token limit', async () => {
  const home = temporaryHome();
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  let calls = 0;
  const engine = fixtureEngine(async input => {
    calls += 1;
    return { synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds, usage: { inputTokens: 1, outputTokens: 1 } };
  });
  const options = { ...stageOptions(), maxInputTokens: 20 };

  const result = await applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store: fixtureStore(home), signal: new AbortController().signal, options,
  });

  expect(result.request).toBe(request);
  expect(calls).toBe(0);
});

it('keeps the incoming request when the engine reports output above its limit', async () => {
  const home = temporaryHome();
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  const engine = fixtureEngine(async input => ({
    synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds,
    usage: { inputTokens: 90, outputTokens: stageOptions().maxOutputTokens + 1 },
  }));

  const result = await applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store: fixtureStore(home), signal: new AbortController().signal, options: stageOptions(),
  });

  expect(result.request).toBe(request);
});

it('keeps the incoming request when the engine returns a malformed synopsis', async () => {
  const home = temporaryHome();
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  const engine = fixtureEngine(async input => ({
    synopsis: { version: 1, taskGoal: 'incomplete' }, sourceIds: input.sourceIds,
    usage: { inputTokens: 90, outputTokens: 30 },
  } as never));

  const result = await applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store: fixtureStore(home), signal: new AbortController().signal, options: stageOptions(),
  });

  expect(result.request).toBe(request);
});

it('does not call the engine when tool topology is unresolved', async () => {
  const home = temporaryHome();
  const request = { model: 'fixture-model', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'unresolved-tool', name: 'search', input: {} }] }] };
  let calls = 0;
  const engine = fixtureEngine(async input => {
    calls += 1;
    return { synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds, usage: { inputTokens: 1, outputTokens: 1 } };
  });

  const result = await applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store: fixtureStore(home), signal: new AbortController().signal, options: stageOptions(),
  });

  expect(result.request).toBe(request);
  expect(calls).toBe(0);
});

it('keeps the incoming request when encrypted evidence cannot be stored', async () => {
  const home = temporaryHome();
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  const engine = fixtureEngine(async input => ({
    synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds,
    usage: { inputTokens: 90, outputTokens: 30 },
  }));
  const store = createEvidenceStore({
    directory: join(home, 'limited-evidence'), key: randomBytes(32),
    workspaceId: createHash('sha256').update(home).digest('hex'), maxBytes: 1,
  });

  const result = await applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store, signal: new AbortController().signal, options: stageOptions(),
  });

  expect(result.request).toBe(request);
});

it('keeps the incoming request when the engine exceeds its deadline', async () => {
  const home = temporaryHome();
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  const engine = fixtureEngine(input => new Promise(resolve => input.signal.addEventListener('abort', () => resolve({
    synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds, usage: { inputTokens: 90, outputTokens: 30 },
  }), { once: true })));
  const options = { ...stageOptions(), deadlineMs: 10 };

  const result = await applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store: fixtureStore(home), signal: new AbortController().signal, options,
  });

  expect(result.summarized).toBe(false);
  expect(result.request).toBe(request);
});

it('rejects synopsis coverage that omits a selected source and leaves the request intact', async () => {
  const home = temporaryHome();
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  const engine = fixtureEngine(async input => ({ synopsis: synopsis('unrelated-source'), sourceIds: input.sourceIds, usage: { inputTokens: 90, outputTokens: 30 } }));

  const result = await applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store: fixtureStore(home), signal: new AbortController().signal, options: stageOptions(),
  });

  expect(result.summarized).toBe(false);
  expect(result.request).toBe(request);
});

it('retains a safe deterministic request when summary usage is missing', async () => {
  const home = temporaryHome();
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  const engine = fixtureEngine(async input => ({ synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds } as never));

  const result = await applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store: fixtureStore(home), signal: new AbortController().signal, options: stageOptions(),
  });

  expect(result.summarized).toBe(false);
  expect(result.request).toBe(request);
});

it('keeps failed tool results verbatim when summarizing successful completed groups', async () => {
  const home = temporaryHome();
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  const engine = fixtureEngine(async input => ({
    synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds,
    usage: { inputTokens: 90, outputTokens: 30 },
  }));

  const result = await applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store: fixtureStore(home), signal: new AbortController().signal, options: stageOptions(),
  });

  expect(JSON.stringify(result.request.messages)).toContain('The failed lookup error must stay visible.');
});

it('does not call a paid engine without a positive limit and complete explicit pricing', async () => {
  const home = temporaryHome();
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  let calls = 0;
  const engine = paidEngine(async input => {
    calls += 1;
    return { synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds, usage: { inputTokens: 90, outputTokens: 30 } };
  });
  const base = stageOptions();
  const attempts = [
    base,
    { ...base, lifetimeLimitMicros: 0, pricing: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, provenance: 'fixture-rate-card' } },
    { ...base, lifetimeLimitMicros: 10_000, pricing: { inputMicrosPerMillion: 1_000_000, provenance: 'fixture-rate-card' } as never },
    { ...base, lifetimeLimitMicros: 2_299, pricing: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, provenance: 'fixture-rate-card' } },
  ] as SummaryOptions[];

  const results = await Promise.all(attempts.map(options => applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store: fixtureStore(home), signal: new AbortController().signal, options,
  })));

  expect(results.map(result => result.request)).toEqual([request, request, request, request]);
  expect(calls).toBe(0);
});

it('settles paid usage at actual cost after reserving the maximum bounded call cost', async () => {
  const home = temporaryHome();
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  const engine = paidEngine(async input => ({
    synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds,
    usage: { inputTokens: 90, outputTokens: 30 },
  }));
  const options = {
    ...stageOptions(), lifetimeLimitMicros: 2_300,
    pricing: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, provenance: 'fixture-rate-card' },
  };

  const result = await applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store: fixtureStore(home), signal: new AbortController().signal, options,
  });

  expect(result.summarized).toBe(true);
  expect(result.chargedMicros).toBe(result.usage?.costMicros);
  expect(reserveSummarySpend({ limitMicros: options.lifetimeLimitMicros!, maximumMicros: 2_180 })).toBeTruthy();
});

it('keeps the summary at user level and embeds retrievable encrypted source evidence', async () => {
  const home = temporaryHome();
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  const store = fixtureStore(home);
  const engine = fixtureEngine(async input => ({
    synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds,
    usage: { inputTokens: 90, outputTokens: 30 },
  }));

  const result = await applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store, signal: new AbortController().signal, options: stageOptions(),
  });
  const summary = result.request.messages.find(message => isLeverframeSummaryMessage(message as CompactionMessage));
  const textBlock = (summary?.content as Array<{ type: string; text?: string }> | undefined)?.find(block => block.type === 'text');
  const envelope = JSON.parse(textBlock!.text!.slice(textBlock!.text!.indexOf(':') + 1)) as { synopsis: { text: string } };
  const evidence = JSON.parse(envelope.synopsis.text) as { evidence: Array<{ reference: string }> };

  expect(summary?.role).toBe('user');
  expect(await store.get('fixture-session', evidence.evidence[0].reference)).toContain('old result');
});

it('conservatively charges a paid call that returns no actual usage', async () => {
  const home = temporaryHome();
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  const engine = paidEngine(async input => ({ synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds } as never));
  const options = {
    ...stageOptions(), lifetimeLimitMicros: 2_300,
    pricing: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, provenance: 'fixture-rate-card' },
  };

  const result = await applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store: fixtureStore(home), signal: new AbortController().signal, options,
  });

  expect(result.request).toBe(request);
  expect(result.chargedMicros).toBe(2_300);
  expect(reserveSummarySpend({ limitMicros: options.lifetimeLimitMicros!, maximumMicros: 1 })).toBeUndefined();
});

it('settles actual paid usage when synopsis validation rejects malformed output', async () => {
  const home = temporaryHome();
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  const engine = paidEngine(async input => ({
    synopsis: null, sourceIds: input.sourceIds, usage: { inputTokens: 90, outputTokens: 30 },
  }));
  const options = {
    ...stageOptions(), lifetimeLimitMicros: 2_300,
    pricing: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, provenance: 'fixture-rate-card' },
  };

  const result = await applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store: fixtureStore(home), signal: new AbortController().signal, options,
  });

  expect(result.request).toBe(request);
  expect(result.usage).toMatchObject({ inputTokens: 90, outputTokens: 30, costMicros: 120 });
  expect(result.chargedMicros).toBe(120);
  expect(reserveSummarySpend({ limitMicros: options.lifetimeLimitMicros!, maximumMicros: 2_180 })).toBeTruthy();
});

it('settles actual paid usage when evidence storage rejects an accepted synopsis', async () => {
  const home = temporaryHome();
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  const engine = paidEngine(async input => ({
    synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds, usage: { inputTokens: 90, outputTokens: 30 },
  }));
  const store = createEvidenceStore({
    directory: join(home, 'limited-evidence'), key: randomBytes(32),
    workspaceId: createHash('sha256').update(home).digest('hex'), maxBytes: 1,
  });
  const options = {
    ...stageOptions(), lifetimeLimitMicros: 2_300,
    pricing: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, provenance: 'fixture-rate-card' },
  };

  const result = await applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store, signal: new AbortController().signal, options,
  });

  expect(result.request).toBe(request);
  expect(result.usage).toMatchObject({ inputTokens: 90, outputTokens: 30, costMicros: 120 });
  expect(result.chargedMicros).toBe(120);
  expect(reserveSummarySpend({ limitMicros: options.lifetimeLimitMicros!, maximumMicros: 2_180 })).toBeTruthy();
});

it('conservatively settles a cancelled paid call and blocks another dispatch', async () => {
  const home = temporaryHome();
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  const controller = new AbortController();
  let started: (() => void) | undefined;
  const invoked = new Promise<void>(resolve => { started = resolve; });
  const engine = paidEngine(() => new Promise(() => {
    started?.();
  }));
  const options = {
    ...stageOptions(), lifetimeLimitMicros: 2_300,
    pricing: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, provenance: 'fixture-rate-card' },
  };
  const running = applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store: fixtureStore(home), signal: controller.signal, options,
  });
  await invoked;
  controller.abort();
  const result = await running;

  expect(result.request).toBe(request);
  expect(result.chargedMicros).toBe(options.lifetimeLimitMicros);
  expect(reserveSummarySpend({ limitMicros: options.lifetimeLimitMicros!, maximumMicros: 1 })).toBeUndefined();
});
