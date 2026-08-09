import { describe, expect, it } from 'vitest';
import {
  MAX_LOCAL_INFERENCE_WINDOW_TOKENS,
  deriveLocalInferenceProfile,
  type LocalHardwareSnapshot,
  type LocalModelBenchmark,
} from '../src/context/local-inference-profile.js';

const GIB = 1024 ** 3;

const hardware: LocalHardwareSnapshot = {
  platform: 'darwin',
  architecture: 'arm64',
  appleSilicon: true,
  totalMemoryBytes: 32 * GIB,
  availableMemoryBytes: 20 * GIB,
  memoryPressure: 'normal',
  pythonAvailable: true,
  mlxAvailable: true,
};

function benchmark(overrides: Partial<LocalModelBenchmark> = {}): LocalModelBenchmark {
  return {
    modelId: 'mlx-community/gemma-4-e4b-it-OptiQ-4bit',
    modelRevision: 'revision-a',
    qualityScore: 0.96,
    qualityPassed: true,
    modelArtifactSizeBytes: 4 * GIB,
    modelLoadPeakMemoryBytes: 8 * GIB,
    timeToFirstTokenMs: 250,
    totalLatencyMs: 2_000,
    idleUnloadPassed: true,
    maxValidatedInputTokens: 64 * 1024,
    peakMemoryBytes: 8 * GIB,
    prefillTokensPerSecond: 400,
    generationTokensPerSecond: 30,
    recommendedRollingInputTokens: 64 * 1024,
    recommendedRollingStrideTokens: 32 * 1024,
    recommendedRecentTailTokens: 48 * 1024,
    recommendedConcurrency: 1,
    recommendedIdleUnloadMs: 60_000,
    ...overrides,
  };
}

describe('deriveLocalInferenceProfile', () => {
  it('fails closed for automatic compaction on unsupported hardware', () => {
    expect(deriveLocalInferenceProfile({
      hardware: { ...hardware, platform: 'linux' },
      benchmarks: [benchmark()],
    })).toEqual({
      schemaVersion: 1,
      status: 'disabled',
      reason: 'unsupported-platform',
    });
  });

  it('fails closed when Apple Silicon evidence is unavailable', () => {
    expect(deriveLocalInferenceProfile({
      hardware: { ...hardware, appleSilicon: false },
      benchmarks: [benchmark()],
    })).toMatchObject({ status: 'disabled', reason: 'unsupported-platform' });
  });

  it('disables local inference during critical memory pressure', () => {
    expect(deriveLocalInferenceProfile({
      hardware: { ...hardware, memoryPressure: 'critical' },
      benchmarks: [benchmark()],
    })).toMatchObject({ status: 'disabled', reason: 'critical-memory-pressure' });
  });

  it('selects the highest-quality passing model that fits available memory', () => {
    const profile = deriveLocalInferenceProfile({
      hardware,
      benchmarks: [
        benchmark({ modelId: 'fast', qualityScore: 0.95, generationTokensPerSecond: 50 }),
        benchmark({ modelId: 'quality', qualityScore: 0.99, generationTokensPerSecond: 20 }),
        benchmark({ modelId: 'too-large', qualityScore: 1, peakMemoryBytes: 18 * GIB }),
        benchmark({ modelId: 'failed', qualityScore: 1, qualityPassed: false }),
      ],
    });

    expect(profile).toMatchObject({
      status: 'ready',
      modelId: 'quality',
      rollingInputTokens: 64 * 1024,
      rollingStrideTokens: 32 * 1024,
      recentTailTokens: 48 * 1024,
    });
  });

  it('applies independent user caps and the hard 128K limit', () => {
    const profile = deriveLocalInferenceProfile({
      hardware,
      benchmarks: [benchmark({
        maxValidatedInputTokens: 256 * 1024,
        recommendedRollingInputTokens: 256 * 1024,
        recommendedRollingStrideTokens: 192 * 1024,
        recommendedRecentTailTokens: 160 * 1024,
      })],
      limits: {
        rollingInputTokenCap: 96 * 1024,
        rollingStrideTokenCap: 80 * 1024,
        recentTailTokenCap: 112 * 1024,
      },
    });

    expect(profile).toMatchObject({
      status: 'ready',
      rollingInputTokens: 96 * 1024,
      rollingStrideTokens: 80 * 1024,
      recentTailTokens: 112 * 1024,
    });
    if (profile.status === 'ready') {
      expect(profile.rollingInputTokens).toBeLessThanOrEqual(MAX_LOCAL_INFERENCE_WINDOW_TOKENS);
      expect(profile.rollingStrideTokens).toBeLessThanOrEqual(MAX_LOCAL_INFERENCE_WINDOW_TOKENS);
      expect(profile.recentTailTokens).toBeLessThanOrEqual(MAX_LOCAL_INFERENCE_WINDOW_TOKENS);
    }
  });

  it('rejects passing benchmarks that lack memory headroom', () => {
    expect(deriveLocalInferenceProfile({
      hardware: { ...hardware, availableMemoryBytes: 9 * GIB },
      benchmarks: [benchmark()],
    })).toMatchObject({ status: 'disabled', reason: 'no-passing-benchmark' });
  });

  it('keeps the stride and recent tail independent from the rolling input', () => {
    const profile = deriveLocalInferenceProfile({
      hardware,
      benchmarks: [benchmark({
        maxValidatedInputTokens: 128 * 1024,
        recommendedRollingInputTokens: 32 * 1024,
        recommendedRollingStrideTokens: 64 * 1024,
        recommendedRecentTailTokens: 96 * 1024,
      })],
    });

    expect(profile).toMatchObject({
      status: 'ready',
      rollingInputTokens: 32 * 1024,
      rollingStrideTokens: 64 * 1024,
      recentTailTokens: 96 * 1024,
    });
  });

  it('fails open when benchmark evidence is incomplete or non-finite', () => {
    expect(deriveLocalInferenceProfile({
      hardware,
      benchmarks: [benchmark({
        totalLatencyMs: Number.NaN,
        modelLoadPeakMemoryBytes: 9 * GIB,
      })],
    })).toMatchObject({ status: 'disabled', reason: 'no-passing-benchmark' });
  });
});