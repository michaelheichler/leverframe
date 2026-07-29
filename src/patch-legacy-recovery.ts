// src/patch-legacy-recovery.ts — read-only verification and conservative
// recovery planning for pre-V2 global patch manifests.
//
// This module owns the boundary between untrusted legacy state and V2 patch
// transactions. It never rewrites the live binary. Exact legacy/live matches
// may be adopted as V2 metadata; divergent injected binaries expose only a
// verified pristine baseline that the V2 transaction must revalidate and patch.

import { existsSync, statSync } from 'node:fs';
import type { ClaudeInstallation } from './claude-installation.js';
import {
  currentTransformVersion,
  ensureBaselineStored,
  readManifestV2,
  writeManifestV2,
} from './patch-state.js';
import {
  computeSemanticFingerprint,
  defaultPatchRuntime,
  verifyPatchSites,
  type PatchRuntime,
  type VerifiedRecoveryBaseline,
} from './patch-transaction.js';
import {
  buildDesiredPatchConfig,
  computePatchConfigHash,
  readPatchManifest,
  type PatchManifest as LegacyPatchManifest,
} from './patcher.js';

interface LegacyPatchRecoveryBase {
  legacyManifestPresent: true;
  legacy: LegacyPatchManifest;
  baseline: VerifiedRecoveryBaseline;
  liveSha256: string;
}

export type LegacyPatchRecoveryInspection =
  | ({ kind: 'exact-adoption' } & LegacyPatchRecoveryBase)
  | ({ kind: 'baseline-recovery' } & LegacyPatchRecoveryBase)
  | {
      kind: 'unavailable';
      legacyManifestPresent: boolean;
      reason: string;
    };

export interface LegacyPatchRecoveryInput {
  installation: ClaudeInstallation;
  runtime?: PatchRuntime;
  /** Omit to read global legacy state; pass null to test/declare its absence. */
  legacy?: LegacyPatchManifest | null;
}

function unavailable(legacyManifestPresent: boolean, reason: string): LegacyPatchRecoveryInspection {
  return { kind: 'unavailable', legacyManifestPresent, reason };
}

function validateLegacyPaths(
  installation: ClaudeInstallation,
  legacy: LegacyPatchManifest,
): string | null {
  if (legacy.binaryPath !== installation.canonicalPath) {
    return 'Legacy manifest target does not match the live canonical target.';
  }
  if (!legacy.baselineSha256) return 'Legacy manifest does not record a pristine baseline hash.';
  if (!existsSync(installation.canonicalPath)) return 'Live target does not exist.';
  if (!legacy.backupPath || !existsSync(legacy.backupPath)) return 'Legacy backup is missing.';
  return null;
}

/**
 * Verify legacy target ownership plus its pristine backup without writing any
 * V2 state. A divergent live hash is recoverable only when the live target is
 * still injected and the legacy backup independently verifies as pristine.
 */
export async function inspectLegacyPatchRecovery(
  input: LegacyPatchRecoveryInput,
): Promise<LegacyPatchRecoveryInspection> {
  const { installation } = input;
  const runtime = input.runtime ?? defaultPatchRuntime;
  const legacy = Object.hasOwn(input, 'legacy') ? input.legacy ?? null : readPatchManifest();
  if (readManifestV2(installation.identity)) return unavailable(legacy !== null, 'V2 state already exists.');
  if (!legacy) return unavailable(false, 'No legacy manifest found.');
  const pathError = validateLegacyPaths(installation, legacy);
  if (pathError) return unavailable(true, pathError);

  const live = await runtime.inspect(installation.canonicalPath, legacy.patchedSha256);
  if (!live.readable || live.version !== installation.version || !live.sha256) {
    return unavailable(true, 'Live target is unreadable or version-mismatched.');
  }
  const backup = await runtime.inspect(legacy.backupPath);
  if (!backup.readable || backup.version !== legacy.claudeVersion) {
    return unavailable(true, 'Legacy backup is unreadable or version-mismatched.');
  }
  if (backup.injection.state !== 'absent') {
    return unavailable(true, 'Legacy backup carries injection markers and is not pristine.');
  }
  if (backup.sha256 !== legacy.baselineSha256) {
    return unavailable(true, 'Legacy baseline hash does not match the backup bytes.');
  }

  const common: LegacyPatchRecoveryBase = {
    legacyManifestPresent: true,
    legacy,
    baseline: {
      sourcePath: legacy.backupPath,
      sha256: legacy.baselineSha256,
      version: legacy.claudeVersion,
      provenance: 'legacy-migrated',
    },
    liveSha256: live.sha256,
  };
  if (live.sha256 === legacy.patchedSha256) return { kind: 'exact-adoption', ...common };
  if (live.injection.state === 'present') return { kind: 'baseline-recovery', ...common };
  return unavailable(true, 'Live hash differs from legacy state and the target is not recognizably injected.');
}

export interface LegacyMigrationResult {
  migrated: boolean;
  reason?: string;
}

export interface LegacyMigrationInput extends LegacyPatchRecoveryInput {
  /** Reuse a read-only inspection to avoid hashing a large Claude binary twice. */
  inspection?: LegacyPatchRecoveryInspection;
}

/**
 * Adopt an exact legacy/live match into V2 without rewriting the target.
 * When current transforms are not byte-idempotent, the adopted manifest is
 * deliberately marked transform-stale so the next explicit patch rebuilds it
 * from the verified baseline rather than claiming the old injection is current.
 */
export async function migrateLegacyStateIfVerified(
  input: LegacyMigrationInput,
): Promise<LegacyMigrationResult> {
  const { installation } = input;
  const runtime = input.runtime ?? defaultPatchRuntime;
  const inspection = input.inspection ?? await inspectLegacyPatchRecovery(input);
  if (inspection.kind !== 'exact-adoption') {
    const reason = inspection.kind === 'baseline-recovery'
      ? 'Live injected hash differs from legacy state; verified baseline recovery is required.'
      : inspection.reason;
    return { migrated: false, reason };
  }

  const baselinePath = ensureBaselineStored({
    identity: installation.identity,
    version: inspection.baseline.version,
    baselineSha256: inspection.baseline.sha256,
    sourcePath: inspection.baseline.sourcePath,
  });
  const desired = buildDesiredPatchConfig();
  const content = await runtime.readContent(installation.canonicalPath);
  const semantic = verifyPatchSites(content, desired.config);
  const desiredConfigHash = computePatchConfigHash(desired.config);

  writeManifestV2(installation.identity, {
    schemaVersion: 2,
    transformVersion: semantic.complete ? currentTransformVersion() : 0,
    generation: 1,
    logicalPath: installation.logicalPath,
    canonicalPath: installation.canonicalPath,
    installationKind: installation.installationKind,
    claudeVersion: inspection.legacy.claudeVersion,
    baselineSha256: inspection.baseline.sha256,
    baselinePath,
    patchedSha256: inspection.liveSha256,
    patchedSize: statSync(installation.canonicalPath).size,
    semanticFingerprint: computeSemanticFingerprint(semantic.results),
    configHash: semantic.complete ? desiredConfigHash : inspection.legacy.configHash,
    provenance: 'legacy-migrated',
    completedAt: new Date().toISOString(),
  });
  return { migrated: true };
}
