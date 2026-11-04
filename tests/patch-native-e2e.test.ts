import { chmodSync, copyFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { expect, it, vi } from 'vitest';
import { resolveClaudeInstallation } from '../src/claude-installation.js';
import {
  defaultPatchRuntime,
  isVerifiedPristineBaselineInspection,
} from '../src/patch-transaction.js';
import { buildDesiredPatchConfig } from '../src/patcher.js';
import { readManifestV2 } from '../src/patch-state.js';

const safety = vi.hoisted(() => ({
  enabled: process.env['LEVERFRAME_RUN_INSTALLED_CLAUDE_PATCH_E2E'] === '1' && !!process.env['LEVERFRAME_TEST_HOME'],
  discoveryCalls: 0,
  executionCalls: 0,
}));

vi.mock('../src/claude-installation.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/claude-installation.js')>();
  return {
    ...original,
    resolveClaudeInstallation: (...args: Parameters<typeof original.resolveClaudeInstallation>) => {
      safety.discoveryCalls++;
      return safety.enabled ? original.resolveClaudeInstallation(...args) : null;
    },
  };
});

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    execFileSync: ((...args: Parameters<typeof original.execFileSync>) => {
      safety.executionCalls++;
      if (!safety.enabled) throw new Error('Installed Claude execution is disabled.');
      return original.execFileSync(...args);
    }) as typeof original.execFileSync,
  };
});

const testHome = process.env['LEVERFRAME_TEST_HOME'];
const installation = safety.enabled ? resolveClaudeInstallation() : null;
const canonical = installation?.canonicalPath ?? null;
const canRunInstalledClaude = safety.enabled && !!testHome && !!canonical && existsSync(canonical);

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

async function selectPristinePatchSource(
  resolved: NonNullable<typeof installation>,
): Promise<string> {
  const live = await defaultPatchRuntime.inspect(resolved.canonicalPath);
  if (!live.readable) {
    throw new Error(`Could not inspect the Claude binary before staging: ${live.error ?? 'unknown reason'}`);
  }
  if (live.injection.state !== 'present') return resolved.canonicalPath;

  const manifest = readManifestV2(resolved.identity);
  if (
    !manifest
    || manifest.canonicalPath !== resolved.canonicalPath
    || manifest.claudeVersion !== resolved.version
    || !existsSync(manifest.baselinePath)
  ) {
    throw new Error('The installed Claude binary is already injected but has no matching pristine baseline.');
  }

  const baseline = await defaultPatchRuntime.inspect(manifest.baselinePath);
  if (!isVerifiedPristineBaselineInspection(baseline, resolved.version, manifest.baselineSha256)) {
    throw new Error('The installed Claude patch manifest does not identify a verified pristine baseline.');
  }
  return manifest.baselinePath;
}

it.skipIf(safety.enabled)('does not discover or execute installed Claude in default test runs', () => {
  expect(safety.discoveryCalls).toBe(0);
  expect(safety.executionCalls).toBe(0);
});

it.skipIf(!canRunInstalledClaude)(
  'patches the real claude binary with the full favorites config and it still runs',
  async () => {
    const config = buildDesiredPatchConfig().config;
    if (Object.keys(config).length < 6) return;

    const stage = join(testHome!, `claude-e2e-patched-${process.pid}`);
    expect(inside(testHome!, stage)).toBe(true);
    try {
      const sourcePath = await selectPristinePatchSource(installation!);
      copyFileSync(sourcePath, stage);
      chmodSync(stage, statSync(sourcePath).mode & 0o777);
      await defaultPatchRuntime.patch(stage, config, installation!.version);

      const version = execFileSync(stage, ['--version'], { encoding: 'utf8', timeout: 30000 });
      expect(version).toMatch(/\d+\.\d+\.\d+/);

      const inspected = await defaultPatchRuntime.inspect(stage);
      expect(inspected.readable).toBe(true);
      expect(inspected.injection.evidence).toBe('marker-v1');
    } finally {
      try { unlinkSync(stage); } catch {}
    }
  },
  300000,
);
