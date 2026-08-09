import { delimiter, join } from 'node:path';

export const LOCAL_BENCHMARK_MODEL_ROOTS_ENV = 'LEVERFRAME_LOCAL_MODEL_ROOTS';
export const MAX_LOCAL_BENCHMARK_DISCOVERY_ROOTS = 8;

export const LOCAL_BENCHMARK_CANDIDATES = [
  {
    candidateId: 'gemma-4-e4b-it-OptiQ-4bit',
    repository: 'mlx-community/gemma-4-e4b-it-OptiQ-4bit',
    revision: 'main',
    artifactRelativePath: 'gemma-4-e4b-it-OptiQ-4bit',
  },
  {
    candidateId: 'gemma-4-12B-it-qat-OptiQ-4bit',
    repository: 'mlx-community/gemma-4-12B-it-qat-OptiQ-4bit',
    revision: 'main',
    artifactRelativePath: 'gemma-4-12B-it-qat-OptiQ-4bit',
  },
] as const;

export type LocalBenchmarkCandidate = (typeof LOCAL_BENCHMARK_CANDIDATES)[number];

export interface LocalBenchmarkArtifact {
  candidate: LocalBenchmarkCandidate;
  artifactPath: string;
  locationEvidence: 'injected-root' | 'environment-root';
}

export interface LocalBenchmarkDiscoveryDependencies {
  environment: Readonly<Record<string, string | undefined>>;
  rootDirectories: readonly string[];
  directoryExists: (path: string) => boolean;
  pathDelimiter?: string;
}

const defaultDependencies: LocalBenchmarkDiscoveryDependencies = {
  environment: process.env,
  rootDirectories: [],
  directoryExists: () => false,
};

function boundedRoots(dependencies: LocalBenchmarkDiscoveryDependencies): readonly {
  path: string;
  evidence: LocalBenchmarkArtifact['locationEvidence'];
}[] {
  const delimiterValue = dependencies.pathDelimiter ?? delimiter;
  const environmentRoots = (dependencies.environment[LOCAL_BENCHMARK_MODEL_ROOTS_ENV] ?? '')
    .split(delimiterValue)
    .map(root => root.trim())
    .filter(root => root !== '')
    .map(path => ({ path, evidence: 'environment-root' as const }));
  const injectedRoots = dependencies.rootDirectories
    .map(root => root.trim())
    .filter(root => root !== '')
    .map(path => ({ path, evidence: 'injected-root' as const }));

  return [...injectedRoots, ...environmentRoots]
    .filter((root, index, roots) => roots.findIndex(candidate => candidate.path === root.path) === index)
    .slice(0, MAX_LOCAL_BENCHMARK_DISCOVERY_ROOTS);
}

export function discoverLocalBenchmarkArtifacts(
  dependencies: LocalBenchmarkDiscoveryDependencies = defaultDependencies,
): readonly LocalBenchmarkArtifact[] {
  const artifacts: LocalBenchmarkArtifact[] = [];

  for (const root of boundedRoots(dependencies)) {
    for (const candidate of LOCAL_BENCHMARK_CANDIDATES) {
      const artifactPath = join(root.path, candidate.artifactRelativePath);
      if (!dependencies.directoryExists(artifactPath)) continue;
      artifacts.push({ candidate, artifactPath, locationEvidence: root.evidence });
    }
  }

  return artifacts;
}