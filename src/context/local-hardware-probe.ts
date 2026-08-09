import { spawnSync } from 'node:child_process';
import { arch, freemem, platform, totalmem } from 'node:os';
import type { LocalHardwareSnapshot, MemoryPressure } from './local-inference-profile.js';

interface CommandResult {
  status: number | null;
  stdout: string;
}

export interface LocalHardwareProbeDependencies {
  platform: () => NodeJS.Platform;
  architecture: () => string;
  totalMemoryBytes: () => number;
  availableMemoryBytes: () => number;
  runCommand: (command: string, args: readonly string[]) => CommandResult;
}

const defaultDependencies: LocalHardwareProbeDependencies = {
  platform,
  architecture: arch,
  totalMemoryBytes: totalmem,
  availableMemoryBytes: freemem,
  runCommand(command, args) {
    const result = spawnSync(command, [...args], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
    };
  },
};

interface PythonCapability {
  executable: string;
  pythonVersion: string;
  mlxVersion: string;
}

const PYTHON_CAPABILITY_SCRIPT = [
  'import json',
  'import platform',
  'import mlx',
  'print(json.dumps({"pythonVersion": platform.python_version(), "mlxVersion": getattr(mlx, "__version__", "unknown")}))',
].join('; ');

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function classifyMemoryPressure(totalMemoryBytes: number, availableMemoryBytes: number): MemoryPressure {
  const total = finiteNonNegative(totalMemoryBytes);
  const available = Math.min(finiteNonNegative(availableMemoryBytes), total);
  if (total === 0 || available / total < 0.1) return 'critical';
  if (available / total < 0.2) return 'warning';
  return 'normal';
}

function detectPythonCapability(runCommand: LocalHardwareProbeDependencies['runCommand']): PythonCapability | undefined {
  for (const executable of ['python3', 'python']) {
    const result = runCommand(executable, ['-c', PYTHON_CAPABILITY_SCRIPT]);
    if (result.status !== 0) continue;
    try {
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      if (
        typeof parsed.pythonVersion !== 'string'
        || parsed.pythonVersion.trim() === ''
        || typeof parsed.mlxVersion !== 'string'
        || parsed.mlxVersion.trim() === ''
        || parsed.mlxVersion === 'unknown'
      ) continue;
      return {
        executable,
        pythonVersion: parsed.pythonVersion,
        mlxVersion: parsed.mlxVersion,
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

function detectPythonWithoutMlx(runCommand: LocalHardwareProbeDependencies['runCommand']): string | undefined {
  for (const executable of ['python3', 'python']) {
    const result = runCommand(executable, ['-c', 'import platform; print(platform.python_version())']);
    if (result.status === 0 && result.stdout.trim()) return executable;
  }
  return undefined;
}

export function detectLocalHardware(
  dependencies: LocalHardwareProbeDependencies = defaultDependencies,
): LocalHardwareSnapshot {
  const detectedPlatform = dependencies.platform();
  const detectedArchitecture = dependencies.architecture();
  const totalMemoryBytes = finiteNonNegative(dependencies.totalMemoryBytes());
  const availableMemoryBytes = Math.min(
    finiteNonNegative(dependencies.availableMemoryBytes()),
    totalMemoryBytes,
  );
  const capability = detectPythonCapability(dependencies.runCommand);
  const pythonExecutable = capability?.executable ?? detectPythonWithoutMlx(dependencies.runCommand);

  return {
    platform: detectedPlatform,
    architecture: detectedArchitecture,
    appleSilicon: detectedPlatform === 'darwin' && detectedArchitecture === 'arm64',
    totalMemoryBytes,
    availableMemoryBytes,
    memoryPressure: classifyMemoryPressure(totalMemoryBytes, availableMemoryBytes),
    pythonAvailable: pythonExecutable !== undefined,
    mlxAvailable: capability !== undefined,
    ...(pythonExecutable ? { pythonExecutable } : {}),
    ...(capability ? {
      pythonVersion: capability.pythonVersion,
      mlxVersion: capability.mlxVersion,
    } : {}),
  };
}