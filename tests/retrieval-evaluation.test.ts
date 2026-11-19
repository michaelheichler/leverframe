import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { evaluateRetrieval } from '../src/retrieval/evaluation.js';

function arm(observedSpend: number | null = 10, resolved = true) {
  return {
    resolved,
    attempts: resolved ? 1 : 2,
    freshInput: 1_000,
    cacheReadInput: 2_000,
    cacheWriteInput: 1_000,
    output: 0,
    toolCalls: 4,
    repeatReads: 1,
    firstTextMs: 250,
    observedSpend,
  };
}

function pair(index: number, baseline = arm(), retrieval = arm(8)) {
  return { taskId: `task-${index}`, revision: 'fixture-revision', fixture: 'coding-tasks-v1', baseline, retrieval };
}

function experiment(pairs = Array.from({ length: 30 }, (_, index) => pair(index))) {
  return {
    provider: 'fixture-provider',
    route: 'fixture-route',
    model: 'fixture-model',
    effort: 'medium',
    cacheIsolation: 'verified',
    metric: { kind: 'actual-usd' },
    pairs,
  };
}

it('includes failed task spend in cost per resolved task', () => {
  const input = experiment([pair(1, arm(4)), pair(2, arm(6, false))]);

  const result = evaluateRetrieval(input);

  expect(result.baseline.spendPerResolved).toBe(10);
});

it('keeps missing allowance unknown across an otherwise complete pilot', () => {
  const known = Array.from({ length: 29 }, (_, index) => pair(index));
  const input = {
    ...experiment([...known, pair(29, arm(), arm(null))]),
    metric: { kind: 'allowance', unit: 'quota points' },
  };

  const result = evaluateRetrieval(input);

  expect(result.retrieval.spendPerResolved).toBeNull();
  expect(result.outcome).toBe('inconclusive');
});

it('charges each cache write at the write rate once', () => {
  const input = {
    ...experiment([pair(1, arm(null), arm(null))]),
    metric: { kind: 'modeled-usd', ratesPerMillion: { fresh: 1, read: 0.5, write: 2, output: 1 } },
  };

  const result = evaluateRetrieval(input);

  expect(result.baseline.spendPerResolved).toBeCloseTo(0.004);
});

it.each([
  ['9 percent less spend', () => Array.from({ length: 30 }, (_, index) => pair(index, arm(), arm(9.1)))],
  ['six additional unresolved tasks', () => Array.from({ length: 30 }, (_, index) => pair(index, arm(), arm(6, index < 24)))],
  ['uncertain savings', () => Array.from({ length: 30 }, (_, index) => pair(index, arm(), arm(index < 15 ? 0 : 17)))],
] as const)('fails the pilot with %s', (_, createPairs) => {
  const input = experiment(createPairs());

  const result = evaluateRetrieval(input);

  expect(result.outcome).toBe('pilot-fail');
});

it.each([
  ['unverified cache isolation', () => ({ ...experiment(), cacheIsolation: 'unknown' })],
  ['29 complete pairs', () => experiment(Array.from({ length: 29 }, (_, index) => pair(index)))],
  ['zero baseline successes', () => experiment(Array.from({ length: 30 }, (_, index) => pair(index, arm(10, false))))],
  ['zero baseline spend', () => experiment(Array.from({ length: 30 }, (_, index) => pair(index, arm(0))))],
] as const)('keeps the pilot inconclusive with %s', (_, makeInput) => {
  const result = evaluateRetrieval(makeInput());

  expect(result.outcome).toBe('inconclusive');
});

it('passes thirty independent pairs with equal success and twenty percent lower spend', () => {
  const input = experiment();

  const result = evaluateRetrieval(input);

  expect(result.baseline.spendPerResolved).toBe(10);
  expect(result.retrieval.spendPerResolved).toBe(8);
  expect(result.outcome).toBe('pilot-pass');
});

it('reproduces the paired bootstrap for the same observations', () => {
  const input = experiment(Array.from({ length: 30 }, (_, index) => pair(index, arm(), arm(index < 15 ? 6 : 9))));
  const previous = evaluateRetrieval(input);

  const result = evaluateRetrieval(input);

  expect(result).toEqual(previous);
});

it.each([
  ['duplicate task IDs', () => experiment([pair(1), pair(1)])],
  ['a negative cost', () => experiment([pair(1, arm(-10))])],
  ['fractional cache-write tokens', () => experiment([pair(1, { ...arm(), cacheWriteInput: 0.5 })])],
  ['zero attempts', () => experiment([pair(1, { ...arm(), attempts: 0 })])],
] as const)('rejects %s', (_, makeInput) => {
  expect(() => evaluateRetrieval(makeInput())).toThrow();
});

it('reads paired observations and prints an offline evaluation report', () => {
  const home = homedir();
  expect(home).toBe(process.env['HOME']);
  expect(process.env['LEVERFRAME_HOME']).toBe(join(home, 'leverframe'));
  const directory = mkdtempSync(join(home, 'retrieval-evaluation-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const inputPath = join(directory, 'observations.json');
  writeFileSync(inputPath, JSON.stringify(experiment()));
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const rejectFetch = 'globalThis.fetch=()=>Promise.reject(new Error("Fixture forbids network"))';
  const env = { ...process.env, NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(rejectFetch)}` };

  const result = spawnSync(process.execPath, [cli, 'retrieval', 'evaluate', '--input', inputPath], {
    encoding: 'utf8', env, timeout: 5_000,
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'pilot-pass' });
});
