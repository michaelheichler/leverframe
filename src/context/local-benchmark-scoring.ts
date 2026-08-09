import type { LocalModelBenchmark } from './local-inference-profile.js';
import {
  LOCAL_BENCHMARK_CANDIDATES,
  type LocalBenchmarkCandidate,
} from './local-benchmark-candidates.js';
import type { BenchmarkFixtureContract } from './local-benchmark-fixtures.js';

export const LOCAL_BENCHMARK_INPUT_TIERS = [
  8 * 1024,
  16 * 1024,
  32 * 1024,
  64 * 1024,
  128 * 1024,
] as const;

export type LocalBenchmarkInputTier = (typeof LOCAL_BENCHMARK_INPUT_TIERS)[number];

export interface BoundedBenchmarkRun {
  tier: LocalBenchmarkInputTier;
  passed: boolean;
}

export interface BenchmarkMeasurements {
  maxValidatedInputTokens: number;
  modelArtifactSizeBytes: number;
  modelLoadPeakMemoryBytes: number;
  timeToFirstTokenMs: number;
  totalLatencyMs: number;
  prefillTokensPerSecond: number;
  generationTokensPerSecond: number;
  peakMemoryBytes: number;
  idleUnloadPassed: boolean;
}

export interface BenchmarkPolicy {
  recommendedRollingInputTokens: number;
  recommendedRollingStrideTokens: number;
  recommendedRecentTailTokens: number;
  recommendedConcurrency: number;
  recommendedIdleUnloadMs: number;
}

export interface BenchmarkEvaluation {
  preservedContractIds: readonly string[];
  unsupportedClaims: readonly string[];
  repeatRunDigests: readonly string[];
}

export interface ScoreLocalBenchmarkInput {
  candidate: LocalBenchmarkCandidate;
  fixture: BenchmarkFixtureContract;
  tier: LocalBenchmarkInputTier;
  measurements: BenchmarkMeasurements;
  evaluation: BenchmarkEvaluation;
  policy: BenchmarkPolicy;
}

export type BenchmarkRejectionReason =
  | 'incomplete-measurements'
  | 'invalid-measurements'
  | 'tier-mismatch'
  | 'fixture-contract-mismatch'
  | 'unsupported-claims'
  | 'unstable-repeat-runs'
  | 'invalid-policy';

export interface LocalBenchmarkScore {
  qualityScore: number;
  preservationScore: number;
  unsupportedClaimCount: number;
  repeatRunStable: boolean;
}

export interface LocalBenchmarkScoringResult {
  accepted: boolean;
  score: LocalBenchmarkScore;
  validatedInputTokens: number | undefined;
  rejectionReasons: readonly BenchmarkRejectionReason[];
  benchmark: LocalModelBenchmark | undefined;
}

export function isLocalBenchmarkInputTier(value: number): value is LocalBenchmarkInputTier {
  return (LOCAL_BENCHMARK_INPUT_TIERS as readonly number[]).includes(value);
}

export function verifiedTokenizerCapacity(
  modelMaxLength: number,
  verified: boolean,
): LocalBenchmarkInputTier | undefined {
  if (!verified || !Number.isSafeInteger(modelMaxLength) || !isLocalBenchmarkInputTier(modelMaxLength)) {
    return undefined;
  }
  return modelMaxLength;
}

export function maxSuccessfulBenchmarkTier(
  runs: readonly BoundedBenchmarkRun[],
): LocalBenchmarkInputTier | undefined {
  return runs
    .filter(run => run.passed)
    .map(run => run.tier)
    .sort((left, right) => right - left)[0];
}

function fixtureContractIds(fixture: BenchmarkFixtureContract): readonly string[] {
  return [
    ...fixture.decisions,
    ...fixture.constraints,
    ...fixture.filePaths,
    ...fixture.unresolvedTasks,
    ...fixture.corrections,
    ...fixture.toolCalls.flatMap(call => [call.callId, call.resultId]),
  ];
}

function completeMeasurements(measurements: BenchmarkMeasurements): boolean {
  return typeof measurements.maxValidatedInputTokens === 'number'
    && Number.isFinite(measurements.maxValidatedInputTokens)
    && typeof measurements.modelArtifactSizeBytes === 'number'
    && Number.isFinite(measurements.modelArtifactSizeBytes)
    && typeof measurements.modelLoadPeakMemoryBytes === 'number'
    && Number.isFinite(measurements.modelLoadPeakMemoryBytes)
    && typeof measurements.timeToFirstTokenMs === 'number'
    && Number.isFinite(measurements.timeToFirstTokenMs)
    && typeof measurements.totalLatencyMs === 'number'
    && Number.isFinite(measurements.totalLatencyMs)
    && typeof measurements.prefillTokensPerSecond === 'number'
    && Number.isFinite(measurements.prefillTokensPerSecond)
    && typeof measurements.generationTokensPerSecond === 'number'
    && Number.isFinite(measurements.generationTokensPerSecond)
    && typeof measurements.peakMemoryBytes === 'number'
    && Number.isFinite(measurements.peakMemoryBytes)
    && typeof measurements.idleUnloadPassed === 'boolean';
}

function validMeasurements(measurements: BenchmarkMeasurements): boolean {
  return measurements.modelArtifactSizeBytes > 0
    && measurements.modelLoadPeakMemoryBytes > 0
    && measurements.timeToFirstTokenMs >= 0
    && measurements.totalLatencyMs >= measurements.timeToFirstTokenMs
    && measurements.prefillTokensPerSecond > 0
    && measurements.generationTokensPerSecond > 0
    && measurements.peakMemoryBytes >= measurements.modelLoadPeakMemoryBytes
    && measurements.idleUnloadPassed;
}

function validPolicy(policy: BenchmarkPolicy): boolean {
  return Object.values(policy).every(value => Number.isSafeInteger(value) && value > 0);
}

function stableRepeats(digests: readonly string[]): boolean {
  return digests.length >= 2 && digests.every(digest => digest !== '' && digest === digests[0]);
}

export function scoreLocalBenchmark(input: ScoreLocalBenchmarkInput): LocalBenchmarkScoringResult {
  const expectedIds = new Set(fixtureContractIds(input.fixture));
  const preservedIds = new Set(input.evaluation.preservedContractIds);
  const preservationScore = expectedIds.size === 0
    ? 0
    : [...expectedIds].filter(id => preservedIds.has(id)).length / expectedIds.size;
  const unsupportedClaimCount = input.evaluation.unsupportedClaims.length;
  const repeatRunStable = stableRepeats(input.evaluation.repeatRunDigests);
  const qualityScore = Math.max(0, preservationScore - unsupportedClaimCount * 0.1) * (repeatRunStable ? 1 : 0.5);
  const rejectionReasons: BenchmarkRejectionReason[] = [];

  if (!completeMeasurements(input.measurements)) rejectionReasons.push('incomplete-measurements');
  else if (!validMeasurements(input.measurements)) rejectionReasons.push('invalid-measurements');
  if (input.tier !== input.measurements.maxValidatedInputTokens) rejectionReasons.push('tier-mismatch');
  if (preservationScore < 1) rejectionReasons.push('fixture-contract-mismatch');
  if (unsupportedClaimCount > 0) rejectionReasons.push('unsupported-claims');
  if (!repeatRunStable) rejectionReasons.push('unstable-repeat-runs');
  if (!validPolicy(input.policy)) rejectionReasons.push('invalid-policy');

  const accepted = rejectionReasons.length === 0;
  const benchmark = accepted
    ? {
      modelId: input.candidate.repository,
      modelRevision: input.candidate.revision,
      qualityScore,
      qualityPassed: true,
      ...input.measurements,
      maxValidatedInputTokens: input.tier,
      ...input.policy,
    }
    : undefined;

  return {
    accepted,
    score: { qualityScore, preservationScore, unsupportedClaimCount, repeatRunStable },
    validatedInputTokens: accepted ? input.tier : undefined,
    rejectionReasons,
    benchmark,
  };
}

export function isKnownLocalBenchmarkCandidate(candidateId: string): boolean {
  return LOCAL_BENCHMARK_CANDIDATES.some(candidate => candidate.candidateId === candidateId);
}