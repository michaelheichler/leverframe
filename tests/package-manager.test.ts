import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('repository package manager', () => {
  it('runs a package executable through the pinned pnpm workspace', () => {
    const version = spawnSync('corepack', ['pnpm', '--version'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(version.status, version.stderr).toBe(0);
    expect(version.stderr).toBe('');
    expect(version.stdout.trim()).toBe('10.34.5');

    const result = spawnSync('corepack', ['pnpm', 'exec', 'node', '-e', "process.stdout.write('workspace-smoke')"], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('workspace-smoke');
  });
});
