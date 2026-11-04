import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Because HOME is a temp directory here, its empty cache prints a download notice.
function realUserCorepackHome(): string {
  return process.env.COREPACK_HOME ?? join(process.env.XDG_CACHE_HOME ?? join(userInfo().homedir, '.cache'), 'node', 'corepack');
}

describe('repository package manager', () => {
  it('runs a package executable through the pinned pnpm workspace', () => {
    const env = { ...process.env, COREPACK_HOME: realUserCorepackHome() };
    const version = spawnSync('corepack', ['pnpm', '--version'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env,
    });
    expect(version.status, version.stderr).toBe(0);
    expect(version.stderr).toBe('');
    expect(version.stdout.trim()).toBe('10.34.5');

    const result = spawnSync('corepack', ['pnpm', 'exec', 'node', '-e', "process.stdout.write('workspace-smoke')"], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('workspace-smoke');
  });
});
