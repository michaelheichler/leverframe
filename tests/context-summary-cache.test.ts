import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { applySummaryStage, type SummaryEngine } from '../src/context/summary-engine.js';
import type { AnthropicMessage } from '../src/context/anthropic-context-groups.js';
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
  const home = mkdtempSync(join(tmpdir(), 'leverframe-summary-cache-'));
  temporaryHomes.push(home);
  vi.stubEnv('LEVERFRAME_HOME', home);
  return home;
}

it('reuses paid summary usage for the same route, policy, engine, and source identity', async () => {
  const home = temporaryHome();
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  const store = fixtureStore(home);
  let calls = 0;
  const engine = paidEngine(async input => {
    calls += 1;
    return { synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds, usage: { inputTokens: 90, outputTokens: 30 } };
  });
  const options = {
    ...stageOptions(), lifetimeLimitMicros: 2_300,
    pricing: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, provenance: 'fixture-rate-card' },
  };
  const run = () => applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store, signal: new AbortController().signal, options,
  });

  const first = await run();
  const second = await run();

  expect(first.summarized).toBe(true);
  expect(second.reused).toBe(true);
  expect(calls).toBe(1);
  expect(second.usage).toEqual(first.usage);
  expect(first.chargedMicros).toBe(first.usage?.costMicros);
  expect(second.chargedMicros).toBeUndefined();
  expect(reserveSummarySpend({ limitMicros: options.lifetimeLimitMicros!, maximumMicros: 2_180 })).toBeTruthy();
});

it('invalidates cached evidence when a selected source changes', async () => {
  const home = temporaryHome();
  const store = fixtureStore(home);
  let calls = 0;
  const engine = fixtureEngine(async input => {
    calls += 1;
    return { synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds, usage: { inputTokens: 90, outputTokens: 30 } };
  });
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  const run = (messages: AnthropicMessage[]) => applySummaryStage({
    request: { ...request, messages }, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store, signal: new AbortController().signal, options: stageOptions(),
  });

  await run(request.messages);
  const changed = request.messages.map(message => JSON.stringify(message).includes('old result ')
    ? { ...message, content: [{ type: 'tool_result', tool_use_id: 'tool-old', content: 'A changed successful result replaces the selected evidence.' }] }
    : message);
  await run(changed);

  expect(calls).toBe(2);
});

it('does not reuse a summary across a different route identity', async () => {
  const home = temporaryHome();
  const store = fixtureStore(home);
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  let calls = 0;
  const engine = fixtureEngine(async input => {
    calls += 1;
    return { synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds, usage: { inputTokens: 90, outputTokens: 30 } };
  });
  const run = (routeIdentity: string) => applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity, engine,
    store, signal: new AbortController().signal, options: stageOptions(),
  });

  await run('fixture-route');
  await run('another-fixture-route');

  expect(calls).toBe(2);
});

it('does not reuse a summary across a different engine identity', async () => {
  const home = temporaryHome();
  const store = fixtureStore(home);
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  let calls = 0;
  const createEngine = (identity: string): SummaryEngine => ({
    identity, billing: 'local', summarize: async input => {
      calls += 1;
      return { synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds, usage: { inputTokens: 90, outputTokens: 30 } };
    },
  });
  const run = (engine: SummaryEngine) => applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store, signal: new AbortController().signal, options: stageOptions(),
  });

  await run(createEngine('first-fixture-engine'));
  await run(createEngine('second-fixture-engine'));

  expect(calls).toBe(2);
});

it('does not reuse a summary across a different policy version', async () => {
  const home = temporaryHome();
  const store = fixtureStore(home);
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  let calls = 0;
  const engine = fixtureEngine(async input => {
    calls += 1;
    return { synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds, usage: { inputTokens: 90, outputTokens: 30 } };
  });
  const run = (policyVersion: string) => applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store, signal: new AbortController().signal, options: { ...stageOptions(), policyVersion },
  });

  await run('first-fixture-policy');
  await run('second-fixture-policy');

  expect(calls).toBe(2);
});

it('reuses encrypted persistent evidence through a new store instance', async () => {
  const home = temporaryHome();
  const key = randomBytes(32);
  const request = { model: 'fixture-model', messages: sourceMessages().slice(1) };
  let calls = 0;
  const engine = fixtureEngine(async input => {
    calls += 1;
    return { synopsis: synopsis(input.sourceIds[0]), sourceIds: input.sourceIds, usage: { inputTokens: 90, outputTokens: 30 } };
  });
  const options = { ...stageOptions(), persistentCache: true };
  const first = await applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store: fixtureStore(home, key), signal: new AbortController().signal, options,
  });
  const second = await applySummaryStage({
    request, sessionId: 'fixture-session', routeIdentity: 'fixture-route', engine,
    store: fixtureStore(home, key), signal: new AbortController().signal, options,
  });

  expect(first.summarized).toBe(true);
  expect(second.reused).toBe(true);
  expect(second.usage).toEqual(first.usage);
  expect(calls).toBe(1);
});
