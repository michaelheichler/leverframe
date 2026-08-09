import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  isClaudeCodeVersionSupportedForBinaryPatching,
  resolveClaudeInstallation,
  unsupportedClaudeCodeBinaryPatchingMessage,
} from './claude-installation.js';
import { getPatchTargetLockPath } from './patch-lock.js';
import { readPatchJournal, verifyPatchSites, defaultPatchRuntime, type PatchRuntime } from './patch-transaction.js';
import { currentTransformVersion, readManifestV2, type PatchManifestV2 } from './patch-state.js';
import { evaluatePatchStateV2, type PatchStateV2 } from './patch-classify.js';
import {
  inspectLegacyPatchRecovery,
  type LegacyPatchRecoveryInspection,
} from './patch-legacy-recovery.js';
import { readPatchManifest as readLegacyManifest } from './patcher.js';
import { buildDesiredPatchConfig, computePatchConfigHash } from './patcher.js';

function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

export interface PatchDiagnosticsReport {
  resolved: boolean;
  supported: boolean;
  identity: {
    logicalPath: string;
    canonicalPath: string;
    discoverySource: string;
    installationKind: string;
    executableType: string;
    version: string;
  } | null;
  leverframe: {
    schemaVersion: number;
    transformVersion: number;
  };
  manifest: {
    present: boolean;
    generation?: number;
    claudeVersion?: string;
    configHash?: string;
    baselineSha256?: string;
    baselinePath?: string;
    baselinePresent?: boolean;
    patchedSha256?: string;
    patchedSize?: number;
    provenance?: string;
    completedAt?: string;
  };
  drift: {
    observedSha256: string | null;
    expectedPatchedSha256: string | null;
    hashesMatch: boolean | null;
    injectionState: 'present' | 'absent' | 'ambiguous' | null;
    semanticSitesComplete: boolean | null;
  };
  transaction: {
    pending: boolean;
    phase?: string;
    operation?: string;
    startedAt?: string;
    updatedAt?: string;
  };
  lock: {
    path: string;
    held: boolean;
  };
  migration: {
    legacyManifestPresent: boolean;
    eligible: boolean;
    mode?: Extract<LegacyPatchRecoveryInspection['kind'], 'exact-adoption' | 'baseline-recovery'>;
    reason?: string;
  };
  state: PatchStateV2 | 'not_resolved';
  nextAction: string;
}

function nextActionFor(
  state: PatchStateV2 | 'not_resolved',
  legacyRecovery?: LegacyPatchRecoveryInspection,
): string {
  switch (state) {
    case 'not_resolved': return 'Install Claude Code, or set TWEAKCC_CC_INSTALLATION_PATH / LEVERFRAME_CLAUDE_PATH, or pass --target.';
    case 'patched': return 'Nothing to do.';
    case 'unpatched': return 'Run `leverframe patch` to bake in your favorite models.';
    case 'state_missing': {
      if (legacyRecovery?.kind === 'baseline-recovery') {
        return 'Run `leverframe patch` to rebuild from the verified pristine legacy backup and publish V2 state.';
      }
      if (legacyRecovery?.kind === 'exact-adoption') {
        return 'Run `leverframe patch` to adopt the exact legacy state and refresh stale transforms if needed.';
      }
      return 'No safe automatic recovery is available; inspect the migration reason before changing this target.';
    }
    case 'updated': return 'Run `leverframe patch` to re-patch after the claude update.';
    case 'config_stale': return 'Run `leverframe patch` to apply your current favorites/aliases.';
    case 'modified': return 'The binary was replaced or modified outside Leverframe. Run `leverframe patch` to patch it fresh.';
    case 'modified_but_injected': return 'The Leverframe patch sites still verify; no action required, though the exact bytes changed (e.g. re-signing).';
    case 'partially_patched': return 'The patch is damaged. Run `leverframe patch --restore` then `leverframe patch` to repair it.';
    case 'unsupported': return 'Could not confidently classify this target. Run `leverframe patch --diagnose --json` and inspect manually.';
    default: return 'Run `leverframe patch --diagnose` again.';
  }
}

export async function diagnosePatchV2(
  target?: string,
  runtime: PatchRuntime = defaultPatchRuntime,
): Promise<PatchDiagnosticsReport> {
  const installation = resolveClaudeInstallation({ target });

  if (!installation) {
    const legacy = readLegacyManifest();
    const legacyDiag = { legacyManifestPresent: legacy !== null };
    return {
      resolved: false,
      supported: false,
      identity: null,
      leverframe: { schemaVersion: 2, transformVersion: currentTransformVersion() },
      manifest: { present: false },
      drift: { observedSha256: null, expectedPatchedSha256: null, hashesMatch: null, injectionState: null, semanticSitesComplete: null },
      transaction: { pending: false },
      lock: { path: '', held: false },
      migration: { ...legacyDiag, eligible: false, reason: 'No installation resolved.' },
      state: 'not_resolved',
      nextAction: nextActionFor('not_resolved'),
    };
  }

  const supported = isClaudeCodeVersionSupportedForBinaryPatching(installation.version);
  if (!supported) {
    return {
      resolved: true,
      supported,
      identity: {
        logicalPath: installation.logicalPath,
        canonicalPath: installation.canonicalPath,
        discoverySource: installation.discoverySource,
        installationKind: installation.installationKind,
        executableType: installation.executableType,
        version: installation.version,
      },
      leverframe: { schemaVersion: 2, transformVersion: currentTransformVersion() },
      manifest: { present: false },
      drift: { observedSha256: null, expectedPatchedSha256: null, hashesMatch: null, injectionState: null, semanticSitesComplete: null },
      transaction: { pending: false },
      lock: { path: '', held: false },
      migration: { legacyManifestPresent: false, eligible: false, reason: 'Binary patching is not supported for this Claude Code version.' },
      state: 'unsupported',
      nextAction: unsupportedClaudeCodeBinaryPatchingMessage(installation.version),
    };
  }

  const legacy = readLegacyManifest();
  const legacyDiag = { legacyManifestPresent: legacy !== null };

  const manifest: PatchManifestV2 | null = readManifestV2(installation.identity);
  const journal = readPatchJournal(installation.identity);
  const lockPath = getPatchTargetLockPath(installation.identity);
  const legacyRecovery = await inspectLegacyPatchRecovery({ installation, runtime, legacy });

  const observedSha256 = sha256File(installation.canonicalPath);
  const live = await runtime.inspect(installation.canonicalPath, manifest?.patchedSha256);
  const desired = buildDesiredPatchConfig();
  const configHash = computePatchConfigHash(desired.config);

  let semanticSitesComplete: boolean | null = null;
  if (
    live.readable
    && observedSha256
    && live.injection.state === 'present'
    && (!manifest || observedSha256 !== manifest.patchedSha256)
  ) {
    try {
      const content = await runtime.readContent(installation.canonicalPath);
      semanticSitesComplete = verifyPatchSites(content, desired.config).complete;
    } catch {
      semanticSitesComplete = false;
    }
  }

  const state = evaluatePatchStateV2({
    installationVersion: installation.version,
    manifest,
    live: { readable: live.readable, version: live.version, sha256: observedSha256, injectionState: live.injection.state },
    desiredConfigHash: configHash,
    semanticSitesComplete: semanticSitesComplete ?? undefined,
  });

  return {
    resolved: true,
    supported,
    identity: {
      logicalPath: installation.logicalPath,
      canonicalPath: installation.canonicalPath,
      discoverySource: installation.discoverySource,
      installationKind: installation.installationKind,
      executableType: installation.executableType,
      version: installation.version,
    },
    leverframe: { schemaVersion: 2, transformVersion: currentTransformVersion() },
    manifest: manifest ? {
      present: true,
      generation: manifest.generation,
      claudeVersion: manifest.claudeVersion,
      configHash: manifest.configHash,
      baselineSha256: manifest.baselineSha256,
      baselinePath: manifest.baselinePath,
      baselinePresent: existsSync(manifest.baselinePath),
      patchedSha256: manifest.patchedSha256,
      patchedSize: manifest.patchedSize,
      provenance: manifest.provenance,
      completedAt: manifest.completedAt,
    } : { present: false },
    drift: {
      observedSha256,
      expectedPatchedSha256: manifest?.patchedSha256 ?? null,
      hashesMatch: manifest ? observedSha256 === manifest.patchedSha256 : null,
      injectionState: live.injection.state,
      semanticSitesComplete,
    },
    transaction: journal ? {
      pending: journal.phase !== 'completed',
      phase: journal.phase,
      operation: journal.operation,
      startedAt: journal.startedAt,
      updatedAt: journal.updatedAt,
    } : { pending: false },
    lock: { path: lockPath, held: existsSync(lockPath) },
    migration: legacyRecovery.kind === 'unavailable'
      ? {
          ...legacyDiag,
          eligible: false,
          reason: legacyRecovery.reason,
        }
      : {
          ...legacyDiag,
          eligible: true,
          mode: legacyRecovery.kind,
        },
    state,
    nextAction: nextActionFor(state, legacyRecovery),
  };
}

function pad(label: string): string {
  return label.padEnd(22, ' ');
}

export function formatPatchDiagnosticsText(report: PatchDiagnosticsReport): string[] {
  const lines: string[] = [];
  lines.push('leverframe patch diagnostics');
  if (!report.resolved || !report.identity) {
    lines.push(`  state: ${report.state}`);
    lines.push(`  next: ${report.nextAction}`);
    return lines;
  }
  lines.push(`${pad('logical path')}${report.identity.logicalPath}`);
  lines.push(`${pad('canonical path')}${report.identity.canonicalPath}`);
  lines.push(`${pad('discovery source')}${report.identity.discoverySource}`);
  lines.push(`${pad('installation kind')}${report.identity.installationKind}`);
  lines.push(`${pad('claude version')}${report.identity.version}`);
  lines.push(`${pad('binary patching')}${report.supported ? 'supported' : 'unsupported'}`);
  lines.push(`${pad('schema / transform')}v${report.leverframe.schemaVersion} / v${report.leverframe.transformVersion}`);
  lines.push(`${pad('manifest')}${report.manifest.present ? `generation ${report.manifest.generation}, ${report.manifest.provenance}` : 'absent'}`);
  if (report.manifest.present) {
    lines.push(`${pad('baseline')}${report.manifest.baselinePath} (${report.manifest.baselinePresent ? 'present' : 'MISSING'})`);
  }
  lines.push(`${pad('observed sha256')}${report.drift.observedSha256 ?? 'unreadable'}`);
  lines.push(`${pad('expected sha256')}${report.drift.expectedPatchedSha256 ?? 'n/a'}`);
  lines.push(`${pad('injection marker')}${report.drift.injectionState ?? 'n/a'}`);
  if (report.drift.semanticSitesComplete !== null) {
    lines.push(`${pad('semantic sites')}${report.drift.semanticSitesComplete ? 'complete' : 'FAILED'}`);
  }
  lines.push(`${pad('transaction')}${report.transaction.pending ? `pending at ${report.transaction.phase} (${report.transaction.operation})` : 'none pending'}`);
  lines.push(`${pad('lock')}${report.lock.held ? `held (${report.lock.path})` : 'free'}`);
  lines.push(`${pad('legacy migration')}${report.migration.eligible ? `eligible - ${report.migration.mode}` : (report.migration.legacyManifestPresent ? `not eligible - ${report.migration.reason}` : 'no legacy state')}`);
  lines.push(`${pad('state')}${report.state}`);
  lines.push(`${pad('next action')}${report.nextAction}`);
  return lines;
}
