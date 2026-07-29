import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(() => '2.1.184 (Claude Code)'),
}));

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: execFileSyncMock,
}));

import { buildClaudeVersionProbe, getInstalledClaudeVersion } from '../src/launch.js';

describe('buildClaudeVersionProbe', () => {
  it('invokes Windows batch wrappers through a fixed cmd command', () => {
    expect(buildClaudeVersionProbe(
      'C:\\Program Files\\Claude\\claude.cmd',
      'win32',
      'C:\\Windows\\System32\\cmd.exe',
    )).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\Program Files\\Claude\\claude.cmd" --version'],
    });
  });

  it('rejects shell-interpretable Windows batch paths', () => {
    expect(buildClaudeVersionProbe('C:\\Claude & whoami\\claude.cmd', 'win32')).toBeNull();
    expect(buildClaudeVersionProbe('C:\\Claude\\%USERNAME%\\claude.bat', 'win32')).toBeNull();
    expect(buildClaudeVersionProbe('C:\\Claude\r\nwhoami\\claude.cmd', 'win32')).toBeNull();
  });

  it('executes Windows native binaries directly', () => {
    expect(buildClaudeVersionProbe('C:\\Claude & Co\\claude.exe', 'win32')).toEqual({
      file: 'C:\\Claude & Co\\claude.exe',
      args: ['--version'],
    });
  });
});

describe('getInstalledClaudeVersion', () => {
  let tempDir: string;
  let previousClaudePath: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'leverframe-version-test-'));
    previousClaudePath = process.env['LEVERFRAME_CLAUDE_PATH'];
    process.env['LEVERFRAME_CLAUDE_PATH'] = join(tempDir, 'claude; touch should-not-run');
    writeFileSync(process.env['LEVERFRAME_CLAUDE_PATH'], '');
    execFileSyncMock.mockClear();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (previousClaudePath === undefined) delete process.env['LEVERFRAME_CLAUDE_PATH'];
    else process.env['LEVERFRAME_CLAUDE_PATH'] = previousClaudePath;
  });

  it('uses literal argv with a bounded timeout', () => {
    expect(getInstalledClaudeVersion()).toBe('2.1.184');
    expect(execFileSyncMock).toHaveBeenCalledWith(
      process.env['LEVERFRAME_CLAUDE_PATH'],
      ['--version'],
      {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5_000,
        killSignal: 'SIGKILL',
      },
    );
  });

  it('preserves the known-good fallback when the probe fails', () => {
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('timed out');
    });
    expect(getInstalledClaudeVersion()).toBe('2.1.183');
  });

  it('probes the explicit path when given an override instead of re-discovering via PATH', () => {
    const explicit = '/opt/explicit/claude';
    expect(getInstalledClaudeVersion(explicit)).toBe('2.1.184');
    expect(execFileSyncMock).toHaveBeenCalledWith(
      explicit,
      ['--version'],
      expect.objectContaining({ timeout: 5_000, killSignal: 'SIGKILL' }),
    );
  });
});
