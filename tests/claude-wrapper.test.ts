import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execIntoClaude, looksLikeWrapperContractPath } from '../src/claude-wrapper.js';

describe('looksLikeWrapperContractPath', () => {
  let temp = '';

  afterEach(() => {
    if (temp) rmSync(temp, { recursive: true, force: true });
    temp = '';
  });

  it('classifies an existing non-executable file as a wrapper contract path', () => {
    temp = mkdtempSync(join(tmpdir(), 'leverframe-wrapper-'));
    const target = join(temp, 'claude-lostexec');
    writeFileSync(target, 'binary-ish', { mode: 0o600 });
    chmodSync(target, 0o600); // explicitly not executable
    expect(looksLikeWrapperContractPath(target)).toBe(true);
  });

  it('classifies a path-like string (with separator) even when it does not exist', () => {
    expect(looksLikeWrapperContractPath('/usr/local/bin/claude')).toBe(true);
    expect(looksLikeWrapperContractPath('./claude')).toBe(true);
    expect(looksLikeWrapperContractPath('bin/claude')).toBe(true);
  });

  it('classifies the bare basename "claude" as a wrapper path (not a CLI flag)', () => {
    expect(looksLikeWrapperContractPath('claude')).toBe(true);
    expect(looksLikeWrapperContractPath('claude.exe')).toBe(true);
  });

  it('does not classify ordinary Claude CLI flags as wrapper paths', () => {
    expect(looksLikeWrapperContractPath('-p')).toBe(false);
    expect(looksLikeWrapperContractPath('--help')).toBe(false);
    expect(looksLikeWrapperContractPath('sonnet')).toBe(false);
    expect(looksLikeWrapperContractPath('continue')).toBe(false);
  });

  it('rejects empty input', () => {
    expect(looksLikeWrapperContractPath('')).toBe(false);
  });
});


describe('execIntoClaude', () => {
  it.skipIf(process.platform === 'win32' || typeof process.execve !== 'function')(
    'replaces the wrapper image with the validated Claude executable',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'leverframe-exec-'));
      const executable = join(root, 'claude');
      writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const execve = vi.spyOn(
        process as unknown as { execve: (file: string, args: string[], env: NodeJS.ProcessEnv) => void },
        'execve',
      ).mockImplementation(() => {
        throw new Error('pre-syscall test stop');
      });
      try {
        execIntoClaude(executable, ['--version'], { TEST_SENTINEL: 'yes' });
        expect(execve).toHaveBeenCalledWith(
          executable,
          [executable, '--version'],
          { TEST_SENTINEL: 'yes' },
        );
      } finally {
        execve.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32' || typeof process.execve !== 'function')(
    'preserves the wrapper PID and process-group identity in a detached launch',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'leverframe-exec-integration-'));
      const marker = join(root, 'identity.json');
      const helper = join(root, 'identity.mjs');
      writeFileSync(helper, [
        "import { execFileSync } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());",
        `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, pgid }));`,
      ].join('\n'));
      const wrapperPath = join(process.cwd(), 'dist', 'claude-wrapper.js');
      const child = spawn(process.execPath, [wrapperPath, process.execPath, helper], {
        env: { ...process.env, LEVERFRAME_HOME: join(root, 'home') },
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      });
      const wrapperPid = child.pid;
      try {
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', () => resolve());
        });
        const identity = JSON.parse(readFileSync(marker, 'utf8')) as {
          pid: number;
          pgid: number;
        };
        expect(identity.pid).toBe(wrapperPid);
        expect(identity.pgid).toBe(identity.pid);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32' || typeof process.execve !== 'function')(
    'leaves an unlaunchable binary to the safe spawn fallback',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'leverframe-exec-'));
      const executable = join(root, 'claude');
      writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
      const execve = vi.spyOn(
        process as unknown as { execve: (file: string, args: string[], env: NodeJS.ProcessEnv) => void },
        'execve',
      );
      try {
        execIntoClaude(executable, [], {});
        expect(execve).not.toHaveBeenCalled();
      } finally {
        execve.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
