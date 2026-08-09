import { describe, expect, it } from 'vitest';
import {
  classifyMemoryPressure,
  detectLocalHardware,
  type LocalHardwareProbeDependencies,
} from '../src/context/local-hardware-probe.js';

const GIB = 1024 ** 3;

function dependencies(
  runCommand: LocalHardwareProbeDependencies['runCommand'],
): LocalHardwareProbeDependencies {
  return {
    platform: () => 'darwin',
    architecture: () => 'arm64',
    totalMemoryBytes: () => 32 * GIB,
    availableMemoryBytes: () => 12 * GIB,
    runCommand,
  };
}

describe('classifyMemoryPressure', () => {
  it.each([
    { available: 8, expected: 'normal' },
    { available: 5, expected: 'warning' },
    { available: 2, expected: 'critical' },
  ] as const)('classifies $available GiB as $expected', ({ available, expected }) => {
    expect(classifyMemoryPressure(32 * GIB, available * GIB)).toBe(expected);
  });

  it('treats invalid capacity data as critical', () => {
    expect(classifyMemoryPressure(0, 0)).toBe('critical');
    expect(classifyMemoryPressure(Number.NaN, Number.POSITIVE_INFINITY)).toBe('critical');
  });
});

describe('detectLocalHardware', () => {
  it('records Python and MLX versions from the first compatible interpreter', () => {
    const snapshot = detectLocalHardware(dependencies((command, args) => ({
      status: command === 'python3' && args[1]?.includes('import mlx') ? 0 : 1,
      stdout: command === 'python3'
        ? JSON.stringify({ pythonVersion: '3.13.5', mlxVersion: '0.28.0' })
        : '',
    })));

    expect(snapshot).toMatchObject({
      platform: 'darwin',
      architecture: 'arm64',
      appleSilicon: true,
      memoryPressure: 'normal',
      pythonAvailable: true,
      mlxAvailable: true,
      pythonExecutable: 'python3',
      pythonVersion: '3.13.5',
      mlxVersion: '0.28.0',
    });
  });

  it('distinguishes Python availability from MLX availability', () => {
    const snapshot = detectLocalHardware(dependencies((_command, args) => ({
      status: args[1]?.includes('import mlx') ? 1 : 0,
      stdout: args[1]?.includes('import mlx') ? '' : '3.12.8\n',
    })));

    expect(snapshot).toMatchObject({
      pythonAvailable: true,
      mlxAvailable: false,
      pythonExecutable: 'python3',
    });
    expect(snapshot).not.toHaveProperty('mlxVersion');
  });

  it('reports unavailable runtimes without throwing on malformed output', () => {
    const snapshot = detectLocalHardware(dependencies((_command, args) => ({
      status: args[1]?.includes('import mlx') ? 0 : 1,
      stdout: args[1]?.includes('import mlx') ? 'not-json' : '',
    })));

    expect(snapshot).toMatchObject({ pythonAvailable: false, mlxAvailable: false });
  });

  it('does not treat an unknown MLX version as capability evidence', () => {
    const snapshot = detectLocalHardware(dependencies((_command, args) => ({
      status: 0,
      stdout: args[1]?.includes('import mlx')
        ? JSON.stringify({ pythonVersion: '3.13.5', mlxVersion: 'unknown' })
        : '3.13.5\n',
    })));

    expect(snapshot).toMatchObject({
      appleSilicon: true,
      pythonAvailable: true,
      mlxAvailable: false,
    });
  });
});