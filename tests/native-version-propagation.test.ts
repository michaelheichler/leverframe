import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaudeInstallation } from '../src/claude-installation.js';
import { migrateLegacyStateIfVerified } from '../src/patch-legacy-recovery.js';
import { diagnosePatchV2 } from '../src/patch-diagnostics.js';
import { checkResolvedPatchState } from '../src/patch-reconcile.js';
import type { PatchRuntime } from '../src/patch-transaction.js';
import type { PatchManifest as LegacyPatchManifest } from '../src/patcher.js';

const VERSION = '2.1.263';
const roots: string[] = [];
let previousHome: string | undefined;

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeInstallation(path: string): ClaudeInstallation {
  return {
    logicalPath: path,
    canonicalPath: path,
    installationPath: path,
    discoverySource: 'explicit-target',
    installationKind: 'custom',
    identity: sha256(path),
    version: VERSION,
    executableType: 'binary',
  };
}

function makeRuntime(
  readVersions: Array<string | undefined>,
  injectionState: 'absent' | 'present' = 'absent',
): PatchRuntime {
  return {
    async inspect(path, _knownPatchedSha256) {
      const content = readFileSync(path);
      const hash = sha256(content);
      return {
        path,
        readable: true,
        version: VERSION,
        sha256: hash,
        injection: {
          state: injectionState,
          evidence: injectionState === 'present' ? 'marker-v1' : 'none',
        },
      };
    },
    async patch() {
      throw new Error('patch is not used by this regression fixture');
    },
    async readContent(path, version) {
      readVersions.push(version);
      return readFileSync(path, 'utf8');
    },
  };
}

function writeClaudeScript(path: string, content = 'unpatched source'): void {
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${VERSION} (Claude Code)"; exit 0; fi\n${content}\n`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
}

beforeEach(() => {
  previousHome = process.env['LEVERFRAME_HOME'];
  const root = mkdtempSync(join(tmpdir(), 'leverframe-native-version-'));
  roots.push(root);
  process.env['LEVERFRAME_HOME'] = join(root, 'state');
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousHome;
});

describe('native extraction version propagation', () => {
  it('passes the verified version through legacy migration semantic reads', async () => {
    const root = roots[0]!;
    const livePath = join(root, 'claude');
    const baselinePath = join(root, 'claude.orig');
    const baseline = 'pristine source';
    const patched = 'patched source';
    writeClaudeScript(livePath, patched);
    writeFileSync(baselinePath, baseline, { mode: 0o755 });

    const legacy: LegacyPatchManifest = {
      binaryPath: livePath,
      claudeVersion: VERSION,
      configHash: 'legacy-config',
      patchedSize: Buffer.byteLength(patched),
      patchedSha256: sha256(patched),
      backupPath: baselinePath,
      baselineSha256: sha256(baseline),
      patchedAt: '2026-09-07T00:00:00.000Z',
    };
    const readVersions: Array<string | undefined> = [];
    const installation = makeInstallation(livePath);

    const result = await migrateLegacyStateIfVerified({
      installation,
      runtime: makeRuntime(readVersions),
      inspection: {
        kind: 'exact-adoption',
        legacyManifestPresent: true,
        legacy,
        baseline: {
          sourcePath: baselinePath,
          sha256: sha256(baseline),
          version: VERSION,
          provenance: 'legacy-migrated',
        },
        liveSha256: sha256(patched),
      },
    });

    expect(result.migrated).toBe(true);
    expect(readVersions).toEqual([VERSION]);
  });

  it('passes the verified version through diagnostics semantic reads', async () => {
    const path = join(roots[0]!, 'claude');
    writeClaudeScript(path);
    const readVersions: Array<string | undefined> = [];

    const report = await diagnosePatchV2(path, makeRuntime(readVersions));

    expect(report.resolved).toBe(true);
    expect(readVersions).toEqual([VERSION]);
  });

  it('passes the verified version through resolved-state semantic reads', async () => {
    const path = join(roots[0]!, 'claude');
    writeClaudeScript(path, 'injected source');
    const readVersions: Array<string | undefined> = [];

    await checkResolvedPatchState(makeInstallation(path), makeRuntime(readVersions, 'present'));

    expect(readVersions).toEqual([VERSION]);
  });
});
