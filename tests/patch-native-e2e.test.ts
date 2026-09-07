import { chmodSync, copyFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { resolveClaudeInstallation } from '../src/claude-installation.js';
import {
  defaultPatchRuntime,
  isVerifiedPristineBaselineInspection,
} from '../src/patch-transaction.js';
import { buildDesiredPatchConfig } from '../src/patcher.js';
import { readManifestV2 } from '../src/patch-state.js';

const installation = resolveClaudeInstallation();
const canonical = installation?.canonicalPath ?? null;

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

it.skipIf(!canonical || !existsSync(canonical))(
  'patches the real claude binary with the full favorites config and it still runs',
  async () => {
    const config = buildDesiredPatchConfig().config;
    if (Object.keys(config).length < 6) return;

    const stage = join(tmpdir(), `claude-e2e-patched-${process.pid}`);
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
