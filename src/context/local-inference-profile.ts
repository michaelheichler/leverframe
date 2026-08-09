export const LOCAL_INFERENCE_PROFILE_SCHEMA_VERSION = 1;
export const MAX_LOCAL_INFERENCE_WINDOW_TOKENS = 128 * 1024;

export type MemoryPressure = 'normal' | 'warning' | 'critical';

export interface LocalHardwareSnapshot {
  platform: NodeJS.Platform;
  architecture: string;
  appleSilicon: boolean;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  memoryPressure: MemoryPressure;
  pythonAvailable: boolean;
  mlxAvailable: boolean;
  pythonExecutable?: string;
  pythonVersion?: string;
  mlxVersion?: string;
}

export interface LocalBenchmarkEvidence {
  modelArtifactSizeBytes: number;
  modelLoadPeakMemoryBytes: number;
  timeToFirstTokenMs: number;
  totalLatencyMs: number;
  idleUnloadPassed: boolean;
}

export interface LocalModelBenchmark extends LocalBenchmarkEvidence {
  modelId: string;
  modelRevision: string;
  qualityScore: number;
  qualityPassed: boolean;
  maxValidatedInputTokens: number;
  peakMemoryBytes: number;
  prefillTokensPerSecond: number;
  generationTokensPerSecond: number;
  recommendedRollingInputTokens: number;
  recommendedRollingStrideTokens: number;
  recommendedRecentTailTokens: number;
  recommendedConcurrency: number;
  recommendedIdleUnloadMs: number;
}

export interface LocalInferenceLimits {
  rollingInputTokenCap?: number;
  rollingStrideTokenCap?: number;
  recentTailTokenCap?: number;
}

export type LocalInferenceDisabledReason =
  | 'unsupported-platform'
  | 'python-unavailable'
  | 'mlx-unavailable'
  | 'critical-memory-pressure'
  | 'no-passing-benchmark';

export interface DisabledLocalInferenceProfile {
  schemaVersion: typeof LOCAL_INFERENCE_PROFILE_SCHEMA_VERSION;
  status: 'disabled';
  reason: LocalInferenceDisabledReason;
}

export interface ReadyLocalInferenceProfile {
  schemaVersion: typeof LOCAL_INFERENCE_PROFILE_SCHEMA_VERSION;
  status: 'ready';
  modelId: string;
  modelRevision: string;
  rollingInputTokens: number;
  rollingStrideTokens: number;
  recentTailTokens: number;
  concurrency: number;
  idleUnloadMs: number;
  benchmark: {
    qualityScore: number;
    maxValidatedInputTokens: number;
    peakMemoryBytes: number;
    prefillTokensPerSecond: number;
    generationTokensPerSecond: number;
  };
}

export type LocalInferenceProfile = DisabledLocalInferenceProfile | ReadyLocalInferenceProfile;

export interface DeriveLocalInferenceProfileInput {
  hardware: LocalHardwareSnapshot;
  benchmarks: readonly LocalModelBenchmark[];
  limits?: LocalInferenceLimits;
}

const MIN_HEADROOM_RATIO = 1.25;

function positiveInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function cappedTokens(value: number, configuredCap: number | undefined, validatedMaximum: number): number {
  const cap = positiveInteger(configuredCap ?? MAX_LOCAL_INFERENCE_WINDOW_TOKENS, MAX_LOCAL_INFERENCE_WINDOW_TOKENS);
  return Math.min(positiveInteger(value, 1), cap, validatedMaximum, MAX_LOCAL_INFERENCE_WINDOW_TOKENS);
}

function compareBenchmarks(left: LocalModelBenchmark, right: LocalModelBenchmark): number {
  return right.qualityScore - left.qualityScore
    || right.maxValidatedInputTokens - left.maxValidatedInputTokens
    || right.generationTokensPerSecond - left.generationTokensPerSecond
    || left.peakMemoryBytes - right.peakMemoryBytes
    || left.modelId.localeCompare(right.modelId);
}

function validBenchmark(benchmark: LocalModelBenchmark, availableMemoryBytes: number): boolean {
  return benchmark.qualityPassed
    && Number.isFinite(benchmark.qualityScore)
    && benchmark.qualityScore >= 0
    && Number.isSafeInteger(benchmark.maxValidatedInputTokens)
    && benchmark.maxValidatedInputTokens > 0
    && Number.isFinite(benchmark.modelArtifactSizeBytes)
    && benchmark.modelArtifactSizeBytes > 0
    && Number.isFinite(benchmark.modelLoadPeakMemoryBytes)
    && benchmark.modelLoadPeakMemoryBytes > 0
    && Number.isFinite(benchmark.timeToFirstTokenMs)
    && benchmark.timeToFirstTokenMs >= 0
    && Number.isFinite(benchmark.totalLatencyMs)
    && benchmark.totalLatencyMs >= benchmark.timeToFirstTokenMs
    && Number.isFinite(benchmark.peakMemoryBytes)
    && benchmark.peakMemoryBytes > 0
    && benchmark.modelLoadPeakMemoryBytes <= benchmark.peakMemoryBytes
    && benchmark.idleUnloadPassed
    && availableMemoryBytes >= benchmark.peakMemoryBytes * MIN_HEADROOM_RATIO;
}

export function selectLocalModelBenchmark(
  benchmarks: readonly LocalModelBenchmark[],
  availableMemoryBytes: number,
): LocalModelBenchmark | undefined {
  return benchmarks.filter(benchmark => validBenchmark(benchmark, availableMemoryBytes)).sort(compareBenchmarks)[0];
}

function disabled(reason: LocalInferenceDisabledReason): DisabledLocalInferenceProfile {
  return {
    schemaVersion: LOCAL_INFERENCE_PROFILE_SCHEMA_VERSION,
    status: 'disabled',
    reason,
  };
}

export function deriveLocalInferenceProfile(input: DeriveLocalInferenceProfileInput): LocalInferenceProfile {
  const { hardware } = input;
  if (!hardware.appleSilicon || hardware.platform !== 'darwin' || hardware.architecture !== 'arm64') {
    return disabled('unsupported-platform');
  }
  if (!hardware.pythonAvailable) return disabled('python-unavailable');
  if (!hardware.mlxAvailable) return disabled('mlx-unavailable');
  if (hardware.memoryPressure === 'critical') return disabled('critical-memory-pressure');

  const selected = selectLocalModelBenchmark(input.benchmarks, hardware.availableMemoryBytes);
  if (!selected) return disabled('no-passing-benchmark');

  const rollingInputTokens = cappedTokens(
    selected.recommendedRollingInputTokens,
    input.limits?.rollingInputTokenCap,
    selected.maxValidatedInputTokens,
  );
  const rollingStrideTokens = cappedTokens(
    selected.recommendedRollingStrideTokens,
    input.limits?.rollingStrideTokenCap,
    selected.maxValidatedInputTokens,
  );
  const recentTailTokens = cappedTokens(
    selected.recommendedRecentTailTokens,
    input.limits?.recentTailTokenCap,
    selected.maxValidatedInputTokens,
  );

  return {
    schemaVersion: LOCAL_INFERENCE_PROFILE_SCHEMA_VERSION,
    status: 'ready',
    modelId: selected.modelId,
    modelRevision: selected.modelRevision,
    rollingInputTokens,
    rollingStrideTokens,
    recentTailTokens,
    concurrency: positiveInteger(selected.recommendedConcurrency, 1),
    idleUnloadMs: positiveInteger(selected.recommendedIdleUnloadMs, 30_000),
    benchmark: {
      qualityScore: selected.qualityScore,
      maxValidatedInputTokens: selected.maxValidatedInputTokens,
      peakMemoryBytes: selected.peakMemoryBytes,
      prefillTokensPerSecond: selected.prefillTokensPerSecond,
      generationTokensPerSecond: selected.generationTokensPerSecond,
    },
  };
}