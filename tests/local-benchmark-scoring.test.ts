import { describe, expect, it } from 'vitest';
import { LOCAL_BENCHMARK_CANDIDATES } from '../src/context/local-benchmark-candidates.js';
import { PHASE_0_BENCHMARK_FIXTURE } from '../src/context/local-benchmark-fixtures.js';
import {
  LOCAL_BENCHMARK_INPUT_TIERS,
  isKnownLocalBenchmarkCandidate,
  maxSuccessfulBenchmarkTier,
  scoreLocalBenchmark,
  verifiedTokenizerCapacity,
  type BenchmarkMeasurements,
  type BenchmarkPolicy,
} from '../src/context/local-benchmark-scoring.js';

const measurements: BenchmarkMeasurements = {
  maxValidatedInputTokens: 64 * 1024,
  modelArtifactSizeBytes: 4 * 1024 ** 3,
  modelLoadPeakMemoryBytes: 8 * 1024 ** 3,
  timeToFirstTokenMs: 250,
  totalLatencyMs: 2_000,
  prefillTokensPerSecond: 400,
  generationTokensPerSecond: 30,
  peakMemoryBytes: 8 * 1024 ** 3,
  idleUnloadPassed: true,
};

const policy: BenchmarkPolicy = {
  recommendedRollingInputTokens: 64 * 1024,
  recommendedRollingStrideTokens: 32 * 1024,
  recommendedRecentTailTokens: 48 * 1024,
  recommendedConcurrency: 1,
  recommendedIdleUnloadMs: 60_000,
};

function evaluation(overrides: Partial<Parameters<typeof scoreLocalBenchmark>[0]['evaluation']> = {}) {
  const contractIds = [
    ...PHASE_0_BENCHMARK_FIXTURE.decisions,
    ...PHASE_0_BENCHMARK_FIXTURE.constraints,
    ...PHASE_0_BENCHMARK_FIXTURE.filePaths,
    ...PHASE_0_BENCHMARK_FIXTURE.unresolvedTasks,
    ...PHASE_0_BENCHMARK_FIXTURE.corrections,
    ...PHASE_0_BENCHMARK_FIXTURE.toolCalls.flatMap(call => [call.callId, call.resultId]),
  ];
  return {
    preservedContractIds: contractIds,
    unsupportedClaims: [],
    repeatRunDigests: ['digest-a', 'digest-a'],
    ...overrides,
  };
}

describe('local benchmark scoring boundary', () => {
  it('defines exactly the bounded input tiers', () => {
    expect(LOCAL_BENCHMARK_INPUT_TIERS).toEqual([8 * 1024, 16 * 1024, 32 * 1024, 64 * 1024, 128 * 1024]);
  });

  it('covers each required deterministic fixture contract category in chronology', () => {
    expect(PHASE_0_BENCHMARK_FIXTURE.decisions).not.toHaveLength(0);
    expect(PHASE_0_BENCHMARK_FIXTURE.constraints).not.toHaveLength(0);
    expect(PHASE_0_BENCHMARK_FIXTURE.filePaths).not.toHaveLength(0);
    expect(PHASE_0_BENCHMARK_FIXTURE.unresolvedTasks).not.toHaveLength(0);
    expect(PHASE_0_BENCHMARK_FIXTURE.corrections).not.toHaveLength(0);
    expect(PHASE_0_BENCHMARK_FIXTURE.toolCalls).not.toHaveLength(0);
    expect(PHASE_0_BENCHMARK_FIXTURE.chronology.map(event => event.order)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rejects sentinel, oversized, and unverified tokenizer metadata', () => {
    expect(verifiedTokenizerCapacity(Number.MAX_SAFE_INTEGER, true)).toBeUndefined();
    expect(verifiedTokenizerCapacity(1_000_000_000, true)).toBeUndefined();
    expect(verifiedTokenizerCapacity(128 * 1024, false)).toBeUndefined();
    expect(verifiedTokenizerCapacity(128 * 1024, true)).toBe(128 * 1024);
  });

  it('takes capacity from successful bounded runs', () => {
    expect(maxSuccessfulBenchmarkTier([
      { tier: 8 * 1024, passed: true },
      { tier: 32 * 1024, passed: false },
      { tier: 16 * 1024, passed: true },
    ])).toBe(16 * 1024);
  });

  it('accepts complete deterministic evidence and exposes LocalModelBenchmark fields', () => {
    const result = scoreLocalBenchmark({
      candidate: LOCAL_BENCHMARK_CANDIDATES[0],
      fixture: PHASE_0_BENCHMARK_FIXTURE,
      tier: 64 * 1024,
      measurements: { ...measurements, maxValidatedInputTokens: 64 * 1024 },
      evaluation: evaluation(),
      policy,
    });

    expect(result).toMatchObject({ accepted: true, validatedInputTokens: 64 * 1024, rejectionReasons: [] });
    expect(result.benchmark).toMatchObject({
      modelId: 'mlx-community/gemma-4-e4b-it-OptiQ-4bit',
      modelRevision: 'main',
      qualityPassed: true,
      modelArtifactSizeBytes: measurements.modelArtifactSizeBytes,
      peakMemoryBytes: measurements.peakMemoryBytes,
      recommendedIdleUnloadMs: policy.recommendedIdleUnloadMs,
    });
  });

  it('rejects unsupported claims, unstable repeats, and incomplete evidence', () => {
    const result = scoreLocalBenchmark({
      candidate: LOCAL_BENCHMARK_CANDIDATES[1],
      fixture: PHASE_0_BENCHMARK_FIXTURE,
      tier: 32 * 1024,
      measurements: { ...measurements, maxValidatedInputTokens: 16 * 1024, totalLatencyMs: Number.NaN },
      evaluation: evaluation({ unsupportedClaims: ['claim-001'], repeatRunDigests: ['digest-a', 'digest-b'] }),
      policy,
    });

    expect(result.accepted).toBe(false);
    expect(result.benchmark).toBeUndefined();
    expect(result.rejectionReasons).toEqual(expect.arrayContaining([
      'incomplete-measurements',
      'tier-mismatch',
      'unsupported-claims',
      'unstable-repeat-runs',
    ]));
  });

  it('rejects a runtime object missing a required measurement field', () => {
    const { peakMemoryBytes: _peakMemoryBytes, ...incompleteMeasurements } = measurements;
    const result = scoreLocalBenchmark({
      candidate: LOCAL_BENCHMARK_CANDIDATES[0],
      fixture: PHASE_0_BENCHMARK_FIXTURE,
      tier: 64 * 1024,
      measurements: incompleteMeasurements as BenchmarkMeasurements,
      evaluation: evaluation(),
      policy,
    });

    expect(result.rejectionReasons).toContain('incomplete-measurements');
  });

  it('recognizes only the two declared candidates', () => {
    expect(isKnownLocalBenchmarkCandidate('gemma-4-e4b-it-OptiQ-4bit')).toBe(true);
    expect(isKnownLocalBenchmarkCandidate('other-model')).toBe(false);
  });
});