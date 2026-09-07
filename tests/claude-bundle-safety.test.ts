import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const extractClaudeJsFromNativeInstallation = vi.hoisted(() => vi.fn());
const repackNativeInstallation = vi.hoisted(() => vi.fn());
const resolveNixBinaryWrapper = vi.hoisted(() => vi.fn());

vi.mock('../src/claude-bundle-native.js', () => ({
  extractClaudeJsFromNativeInstallation,
  repackNativeInstallation,
  resolveNixBinaryWrapper,
}));

import { readClaudeContent, writeClaudeContent } from '../src/claude-bundle.js';

const tempDirectories: string[] = [];

afterEach(() => {
  extractClaudeJsFromNativeInstallation.mockReset();
  repackNativeInstallation.mockReset();
  resolveNixBinaryWrapper.mockReset();
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function nativeFixture(): { launcherPath: string; payloadPath: string; original: Buffer } {
  const directory = mkdtempSync(join(tmpdir(), 'leverframe-native-safety-'));
  tempDirectories.push(directory);
  const launcherPath = join(directory, 'claude');
  const payloadPath = join(directory, 'payload');
  const original = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01, 0x02, 0x03, 0x04]);
  writeFileSync(launcherPath, original);
  return { launcherPath, payloadPath, original };
}

describe('native Claude bundle safety', () => {
  it('passes the verified installation version to native extraction', async () => {
    const { launcherPath, payloadPath } = nativeFixture();
    resolveNixBinaryWrapper.mockReturnValue(payloadPath);
    extractClaudeJsFromNativeInstallation.mockReturnValue({
      data: Buffer.from('extracted source'),
      clearBytecode: false,
    });

    await expect(readClaudeContent(launcherPath, '2.1.263')).resolves.toBe('extracted source');

    expect(resolveNixBinaryWrapper).toHaveBeenCalledWith(launcherPath);
    expect(extractClaudeJsFromNativeInstallation).toHaveBeenCalledWith(payloadPath, '2.1.263');
  });

  it('refuses to replace a Nix launcher with its extracted payload', async () => {
    const { launcherPath, payloadPath, original } = nativeFixture();
    resolveNixBinaryWrapper.mockReturnValue(payloadPath);

    await expect(writeClaudeContent(launcherPath, 'patched source')).rejects.toThrow(/Nix wrapper/i);

    expect(repackNativeInstallation).not.toHaveBeenCalled();
    expect(readFileSync(launcherPath)).toEqual(original);
  });
});
