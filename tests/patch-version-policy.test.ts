import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isClaudeCodeVersionSupportedForBinaryPatching,
  resolveClaudeInstallation,
  type ClaudeInstallation,
} from '../src/claude-installation.js';
import { runPatchCommandV2 } from '../src/patch-reconcile.js';
import type { PatchPresenter } from '../src/patch-presenter.js';
import type { PatchRuntime } from '../src/patch-transaction.js';
import { currentTransformVersion, readManifestV2, writeManifestV2 } from '../src/patch-state.js';

const dirs: string[] = [];
const previousHome = process.env['LEVERFRAME_HOME'];
const unsupportedVersion = '2.1.220';

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousHome;
});

function installation(version = unsupportedVersion): ClaudeInstallation {
  return {
    logicalPath: '/tmp/claude',
    canonicalPath: '/tmp/claude',
    installationPath: '/tmp/claude',
    discoverySource: 'explicit-target',
    installationKind: 'custom',
    identity: `fixture-${version}`,
    version,
    executableType: 'binary',
  };
}

function recorder(): { presenter: PatchPresenter; errors: string[]; notices: string[]; confirmations: string[] } {
  const errors: string[] = [];
  const notices: string[] = [];
  const confirmations: string[] = [];
  return {
    errors,
    notices,
    confirmations,
    presenter: {
      error: message => errors.push(message),
      warn: () => undefined,
      success: () => undefined,
      detail: () => undefined,
      notice: message => notices.push(message),
      confirm: async message => {
        confirmations.push(message);
        return true;
      },
    },
  };
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function writeVersionProbe(dir: string, name: string, output: string): string {
  const target = join(dir, name);
  writeFileSync(target, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' '${output}'; exit 0; fi\n`, { mode: 0o755 });
  chmodSync(target, 0o755);
  return target;
}

function restoreRuntime(version: string): PatchRuntime {
  return {
    async inspect(path) {
      const content = readFileSync(path, 'utf8');
      return {
        path,
        readable: true,
        version,
        sha256: sha256(content),
        injection: content === 'patched'
          ? { state: 'present', evidence: 'manifest-hash' }
          : { state: 'absent', evidence: 'none' },
      };
    },
    async patch() {
      throw new Error('restore must not apply a patch');
    },
    async readContent(path) {
      return readFileSync(path, 'utf8');
    },
  };
}

describe('Claude Code binary patch version policy', () => {
  it('resolves the full normal version probe output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-version-probe-'));
    dirs.push(dir);
    const target = writeVersionProbe(dir, 'claude', '2.1.226 (Claude Code)');

    expect(resolveClaudeInstallation({ target })?.version).toBe('2.1.226');
  });

  it('resolves a Claude version probe with the optional tweakcc marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-version-probe-'));
    dirs.push(dir);
    const target = writeVersionProbe(dir, 'claude-tweakcc', '2.1.226 (Claude Code)\n2.7.16 (tweakcc-fixed)');

    expect(resolveClaudeInstallation({ target })?.version).toBe('2.1.226');
  });

  it('rejects invalid extra version probe lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-version-probe-'));
    dirs.push(dir);

    expect(resolveClaudeInstallation({ target: writeVersionProbe(dir, 'claude-arbitrary', '2.1.226 (Claude Code)\npatched') })).toBeNull();
    expect(resolveClaudeInstallation({ target: writeVersionProbe(dir, 'claude-tweakcc-malformed', '2.1.226 (Claude Code)\n2.7 (tweakcc-fixed)') })).toBeNull();
    expect(resolveClaudeInstallation({ target: writeVersionProbe(dir, 'claude-third-line', '2.1.226 (Claude Code)\n2.7.16 (tweakcc-fixed)\nextra') })).toBeNull();
    expect(resolveClaudeInstallation({ target: writeVersionProbe(dir, 'claude-prerelease', '2.1.226-beta (Claude Code)') })).toBeNull();
    expect(resolveClaudeInstallation({ target: writeVersionProbe(dir, 'claude-numeric-suffix', '2.1.226.1 (Claude Code)') })).toBeNull();
  });

  it('rejects version probe output with a suffix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-version-probe-'));
    dirs.push(dir);

    expect(resolveClaudeInstallation({ target: writeVersionProbe(dir, 'claude-build', '2.1.223.1 (Claude Code)') })).toBeNull();
    expect(resolveClaudeInstallation({ target: writeVersionProbe(dir, 'claude-beta', '2.1.223-beta (Claude Code)') })).toBeNull();
  });

  it('accepts every exact numeric semver for structural compatibility probing', () => {
    expect(isClaudeCodeVersionSupportedForBinaryPatching('1.0.0')).toBe(true);
    expect(isClaudeCodeVersionSupportedForBinaryPatching('2.1.223')).toBe(true);
    expect(isClaudeCodeVersionSupportedForBinaryPatching('2.1.224')).toBe(true);
    expect(isClaudeCodeVersionSupportedForBinaryPatching('2.2.0')).toBe(true);
    expect(isClaudeCodeVersionSupportedForBinaryPatching('3.0.0')).toBe(true);
  });

  it('rejects malformed versions without imposing a release floor', () => {
    expect(isClaudeCodeVersionSupportedForBinaryPatching('2.1.222')).toBe(true);
    expect(isClaudeCodeVersionSupportedForBinaryPatching('2.1.223.1')).toBe(false);
    expect(isClaudeCodeVersionSupportedForBinaryPatching('2.01.223')).toBe(false);
    expect(isClaudeCodeVersionSupportedForBinaryPatching('not-a-version')).toBe(false);
  });

  it('restores a valid V2 state for an unsupported version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-version-restore-'));
    dirs.push(dir);
    process.env['LEVERFRAME_HOME'] = join(dir, 'home');
    const target = join(dir, 'claude');
    const baselinePath = join(dir, 'claude.orig');
    writeFileSync(target, 'patched', { mode: 0o755 });
    writeFileSync(baselinePath, 'baseline', { mode: 0o600 });
    const restoreInstallation = {
      ...installation(),
      logicalPath: target,
      canonicalPath: target,
      installationPath: target,
      identity: 'unsupported-version-restore',
    };
    writeManifestV2(restoreInstallation.identity, {
      schemaVersion: 2,
      transformVersion: currentTransformVersion(),
      generation: 1,
      logicalPath: target,
      canonicalPath: target,
      installationKind: 'custom',
      claudeVersion: unsupportedVersion,
      baselineSha256: sha256('baseline'),
      baselinePath,
      patchedSha256: sha256('patched'),
      patchedSize: Buffer.byteLength('patched'),
      semanticFingerprint: 'fixture',
      configHash: 'fixture',
      provenance: 'live',
      completedAt: new Date().toISOString(),
    });
    const output = recorder();

    const exitCode = await runPatchCommandV2(
      { restore: true, installation: restoreInstallation, runtime: restoreRuntime(unsupportedVersion) },
      output.presenter,
    );

    expect(exitCode).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('baseline');
    expect(readManifestV2(restoreInstallation.identity)).toBeNull();
    expect(output.errors).toEqual([]);
    expect(output.notices).toEqual([]);
    expect(existsSync(baselinePath)).toBe(true);
  });

});
