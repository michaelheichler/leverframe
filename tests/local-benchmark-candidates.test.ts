import { describe, expect, it } from 'vitest';
import {
  LOCAL_BENCHMARK_CANDIDATES,
  LOCAL_BENCHMARK_MODEL_ROOTS_ENV,
  MAX_LOCAL_BENCHMARK_DISCOVERY_ROOTS,
  discoverLocalBenchmarkArtifacts,
} from '../src/context/local-benchmark-candidates.js';

describe('local benchmark candidates', () => {
  it('keeps the exact candidate identities and repository evidence', () => {
    expect(LOCAL_BENCHMARK_CANDIDATES.map(candidate => candidate.candidateId)).toEqual([
      'gemma-4-e4b-it-OptiQ-4bit',
      'gemma-4-12B-it-qat-OptiQ-4bit',
    ]);
    expect(LOCAL_BENCHMARK_CANDIDATES.every(candidate => (
      candidate.repository.startsWith('mlx-community/')
      && !candidate.artifactRelativePath.startsWith('/')
    ))).toBe(true);
  });

  it('discovers only bounded, injected or environment-rooted artifacts', () => {
    const roots = Array.from({ length: MAX_LOCAL_BENCHMARK_DISCOVERY_ROOTS + 2 }, (_, index) => `/root-${index}`);
    const present = new Set([
      '/injected/gemma-4-e4b-it-OptiQ-4bit',
      '/root-0/gemma-4-12B-it-qat-OptiQ-4bit',
    ]);
    const artifacts = discoverLocalBenchmarkArtifacts({
      rootDirectories: ['/injected'],
      environment: { [LOCAL_BENCHMARK_MODEL_ROOTS_ENV]: roots.join(':') },
      directoryExists: path => present.has(path),
      pathDelimiter: ':',
    });

    expect(artifacts).toEqual([
      expect.objectContaining({
        artifactPath: '/injected/gemma-4-e4b-it-OptiQ-4bit',
        locationEvidence: 'injected-root',
      }),
      expect.objectContaining({
        artifactPath: '/root-0/gemma-4-12B-it-qat-OptiQ-4bit',
        locationEvidence: 'environment-root',
      }),
    ]);
  });

  it('does not infer artifacts from a user-specific default path', () => {
    expect(discoverLocalBenchmarkArtifacts({
      rootDirectories: [],
      environment: {},
      directoryExists: () => true,
    })).toEqual([]);
  });
});