import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveClaudeInstallation } from '../src/claude-installation.js';
import { launchClaude } from '../src/launch.js';
import { runLaunchPatchCheckV2 } from '../src/patch-reconcile.js';
import type { PatchPresenter } from '../src/patch-presenter.js';
import { currentTransformVersion, writeManifestV2 } from '../src/patch-state.js';
import { buildDesiredPatchConfig, computePatchConfigHash } from '../src/patcher.js';
import type { PatchRuntime } from '../src/patch-transaction.js';

const dirs: string[] = [];
const originalClaudePath = process.env['LEVERFRAME_CLAUDE_PATH'];
const originalHome = process.env['LEVERFRAME_HOME'];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalClaudePath === undefined) delete process.env['LEVERFRAME_CLAUDE_PATH'];
  else process.env['LEVERFRAME_CLAUDE_PATH'] = originalClaudePath;
  if (originalHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = originalHome;
});

const silentPresenter: PatchPresenter = {
  error() {},
  warn() {},
  success() {},
  detail() {},
  notice() {},
  async confirm() { return false; },
};

function writeCandidate(path: string, label: string): void {
  writeFileSync(path, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '2.1.223 (Claude Code)\\n'
  exit 0
fi
printf '${label}' > "$LEVERFRAME_TEST_LAUNCH_MARKER"
`, { mode: 0o755 });
}

describe('resolved Claude installation launch invariant', () => {
  const posixIt = process.platform === 'win32' ? it.skip : it;

  posixIt('spawns the exact canonical target whose patch state was verified, despite a competing candidate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-launch-installation-'));
    const home = mkdtempSync(join(tmpdir(), 'leverframe-launch-home-'));
    dirs.push(dir, home);
    const candidateA = join(dir, 'claude-a');
    const candidateB = join(dir, 'claude-b');
    const marker = join(dir, 'spawned-candidate');
    writeCandidate(candidateA, 'candidate-a');
    writeCandidate(candidateB, 'candidate-b');

    process.env['LEVERFRAME_HOME'] = home;
    process.env['LEVERFRAME_CLAUDE_PATH'] = candidateA;
    const installation = resolveClaudeInstallation();
    expect(installation).not.toBeNull();
    if (!installation) throw new Error('fixture candidate A did not resolve');

    const desired = buildDesiredPatchConfig();
    const patchedSha256 = 'fixture-patched-a';
    writeManifestV2(installation.identity, {
      schemaVersion: 2,
      transformVersion: currentTransformVersion(),
      generation: 1,
      logicalPath: installation.logicalPath,
      canonicalPath: installation.canonicalPath,
      installationKind: installation.installationKind,
      claudeVersion: installation.version,
      baselineSha256: 'fixture-baseline-a',
      baselinePath: join(home, 'fixture-baseline-a.orig'),
      patchedSha256,
      patchedSize: 1,
      semanticFingerprint: 'fixture-semantic-fingerprint',
      configHash: computePatchConfigHash(desired.config),
      provenance: 'live',
      completedAt: new Date().toISOString(),
    });

    const inspectedPaths: string[] = [];
    const runtime: PatchRuntime = {
      async inspect(path) {
        inspectedPaths.push(path);
        return {
          path,
          readable: true,
          version: installation.version,
          sha256: patchedSha256,
          injection: { state: 'present', evidence: 'manifest-hash' },
        };
      },
      async patch() {
        throw new Error('patch must not run during verification');
      },
      async readContent() {
        throw new Error('content read is unnecessary for an exact patched hash');
      },
    };

    await runLaunchPatchCheckV2(
      { installation, runtime, dryRun: true, agentStdout: true },
      silentPresenter,
    );
    expect(inspectedPaths).toEqual([installation.canonicalPath]);

    process.env['LEVERFRAME_CLAUDE_PATH'] = candidateB;
    expect(resolveClaudeInstallation()?.canonicalPath).not.toBe(installation.canonicalPath);

    const exitCode = await launchClaude({
      installation,
      env: { ...process.env, LEVERFRAME_TEST_LAUNCH_MARKER: marker },
      model: undefined,
      extraArgs: [],
    });
    expect(exitCode).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('candidate-a');
  });

  posixIt('spawns an explicit launch path without changing the resolved installation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverframe-launch-wrapper-'));
    dirs.push(dir);
    const claude = join(dir, 'claude');
    const wrapper = join(dir, 'claude-wrapper');
    const marker = join(dir, 'spawned-candidate');
    writeCandidate(claude, 'claude');
    writeCandidate(wrapper, 'wrapper');

    process.env['LEVERFRAME_CLAUDE_PATH'] = claude;
    const installation = resolveClaudeInstallation();
    expect(installation).not.toBeNull();
    if (!installation) throw new Error('fixture Claude installation did not resolve');

    const exitCode = await launchClaude({
      installation,
      env: {
        ...process.env,
        LEVERFRAME_CLAUDE_LAUNCH_PATH: wrapper,
        LEVERFRAME_TEST_LAUNCH_MARKER: marker,
      },
      model: undefined,
      extraArgs: [],
    });

    expect(exitCode).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('wrapper');
    expect(installation.canonicalPath).toBe(realpathSync(claude));
  });
});
