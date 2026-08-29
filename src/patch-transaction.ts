import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { ensurePrivateDirectory, readFileStrict } from './durable-io.js';
import {
  atomicWriteJsonSync,
  commitSameDirectoryStageSync,
  copyImmutableFileSync,
  sameDirectoryStagePath,
} from './atomic-file.js';
import {
  isClaudeCodeVersionSupportedForBinaryPatching,
  resolveClaudeInstallation,
  unsupportedClaudeCodeBinaryPatchingMessage,
  type ClaudeInstallation,
} from './claude-installation.js';
import {
  currentTransformVersion,
  ensureBaselineExecutable,
  ensureBaselineStored,
  getPatchTargetDir,
  getPatchTransactionPathV2,
  removeManifestV2,
  writeManifestV2,
  type BaselineProvenance,
  type PatchManifestV2,
} from './patch-state.js';
import {
  addLeverframeInjectionMarker,
  classifyLeverframeInjectionByHash,
  type InjectionClassification,
} from './patch-injection.js';
import { readClaudeContent, writeClaudeContent } from './claude-bundle.js';
import { applyLeverframeIntegration, ClaudeIntegrationCompatibilityError } from './claude-model-integration.js';
import {
  PatchApplyError,
  type PatchScriptModelConfig,
  type PatchSiteResult,
} from './patch-transforms.js';

export const PATCH_JOURNAL_SCHEMA_VERSION = 1;

export type PatchTransactionPhase =
  | 'prepared'
  | 'baseline_committed'
  | 'binary_committed'
  | 'manifest_committed'
  | 'completed';

export interface PatchTransactionJournal {
  schemaVersion: typeof PATCH_JOURNAL_SCHEMA_VERSION;
  operation: 'patch' | 'restore';
  identity: string;
  canonicalPath: string;
  generation: number;
  phase: PatchTransactionPhase;
  expectedPreHash: string;
  claudeVersion: string;
  baselineSha256: string;
  baselinePath: string;
  patchedSha256?: string;
  patchedSize?: number;
  configHash: string;
  transformVersion: number;
  provenance: BaselineProvenance;
  startedAt: string;
  updatedAt: string;
}

export function getPatchJournalPath(identity: string): string {
  return getPatchTransactionPathV2(identity);
}

export function readPatchJournal(identity: string): PatchTransactionJournal | null {
  const path = getPatchJournalPath(identity);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileStrict(path, { maxBytes: 64 * 1024, description: 'Patch transaction journal' });
    const parsed = JSON.parse(raw) as Partial<PatchTransactionJournal>;
    if (parsed.schemaVersion !== PATCH_JOURNAL_SCHEMA_VERSION || !parsed.phase) return null;
    return parsed as PatchTransactionJournal;
  } catch {
    return null;
  }
}

function writeJournal(journal: PatchTransactionJournal): void {
  ensurePrivateDirectory(getPatchTargetDir(journal.identity));
  atomicWriteJsonSync(getPatchJournalPath(journal.identity), journal);
}

export function clearPatchJournal(identity: string): void {
  try {
    unlinkSync(getPatchJournalPath(identity));
  } catch {
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface PatchRuntimeInspection {
  path: string;
  readable: boolean;
  version: string | null;
  sha256: string | null;
  injection: InjectionClassification;
  /** Why inspection failed, when `readable` is false. */
  error?: string;
}

export function describeInspectFailure(live: PatchRuntimeInspection): string {
  return live.error
    ? `Cannot inspect the live claude binary: ${live.error}`
    : 'Cannot inspect the live claude binary.';
}

export interface PatchRuntime {
  inspect(path: string, knownPatchedSha256?: string): Promise<PatchRuntimeInspection>;
  patch(path: string, config: PatchScriptModelConfig): Promise<PatchSiteResult[]>;
  readContent(path: string): Promise<string>;
}

export const defaultPatchRuntime: PatchRuntime = {
  async inspect(path, knownPatchedSha256) {
    try {
      if (!statSync(path).isFile()) throw new Error('not a file');
      const sha256 = sha256File(path);
      const installation = resolveClaudeInstallation({ target: path });
      const version = installation?.version ?? null;
      if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('embedded version unavailable');
      const content = await readClaudeContent(path);
      return {
        path,
        readable: true,
        version,
        sha256,
        injection: classifyLeverframeInjectionByHash(content, sha256, knownPatchedSha256),
      };
    } catch (err) {
      return {
        path,
        readable: false,
        version: null,
        sha256: null,
        injection: { state: 'ambiguous', evidence: 'inspect-failed' },
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
  async patch(path, config) {
    const source = await readClaudeContent(path);
    const patched = applyLeverframeIntegration(source, config);
    await writeClaudeContent(path, addLeverframeInjectionMarker(patched.content));
    return patched.results;
  },
  async readContent(path) {
    return readClaudeContent(path);
  },
};

export function verifyPatchSites(
  content: string,
  config: PatchScriptModelConfig,
): { complete: boolean; results: PatchSiteResult[] } {
  try {
    const patched = applyLeverframeIntegration(content, config);
    return {
      complete: patched.content === content && patched.results.every(result => result.status !== 'FAIL'),
      results: patched.results,
    };
  } catch (err) {
    if (err instanceof ClaudeIntegrationCompatibilityError) return { complete: false, results: err.results };
    if (err instanceof PatchApplyError) return { complete: false, results: err.results };
    return { complete: false, results: [] };
  }
}

export function computeSemanticFingerprint(results: PatchSiteResult[]): string {
  const canonical = [...results].map(r => [r.name, r.status]).sort((a, b) => a[0]!.localeCompare(b[0]!));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface ApplyOutcome {
  ok: boolean;
  message: string;
  detailLines?: string[];
}

export interface VerifiedRecoveryBaseline {
  sourcePath: string;
  sha256: string;
  version: string;
  provenance: Extract<BaselineProvenance, 'legacy-migrated'>;
}

export interface ApplyPatchInput {
  installation: ClaudeInstallation;
  desiredConfig: PatchScriptModelConfig;
  configHash: string;
  manifest: PatchManifestV2 | null;
  /**
   * Allows an injected target with missing V2 state to be rebuilt from a
   * separately verified pristine baseline, never from its injected live bytes.
   */
  recoveryBaseline?: VerifiedRecoveryBaseline;
  trace: boolean;
}

interface BaselineCandidate {
  sourcePath: string;
  sha256: string;
  provenance: BaselineProvenance;
}

/**
 * Revalidate a purported pristine baseline immediately before a transaction.
 * This closes the gap between read-only recovery inspection and the first
 * write: a missing, replaced, injected, or hash-mismatched baseline is rejected.
 */
async function validatePristineBaseline(input: {
  candidate: BaselineCandidate;
  version: string;
  runtime: PatchRuntime;
}): Promise<string | null> {
  const { candidate, version, runtime } = input;
  if (!existsSync(candidate.sourcePath)) return 'The verified recovery baseline is missing.';
  ensureBaselineExecutable(candidate.sourcePath);
  const inspected = await runtime.inspect(candidate.sourcePath);
  if (!inspected.readable) {
    return `The recovery baseline could not be read: ${inspected.error ?? 'unknown reason'}`;
  }
  if (inspected.version !== version) {
    return `The recovery baseline is Claude Code ${inspected.version ?? 'unknown'}, not ${version}.`;
  }
  if (inspected.injection.state !== 'absent') {
    return `The recovery baseline is already injected (${inspected.injection.evidence}).`;
  }
  if (inspected.sha256 !== candidate.sha256) {
    return 'The recovery baseline hash changed after verification.';
  }
  return null;
}

/**
 * Patch the live binary in a crash-safe, journaled sequence:
 *   1. journal `prepared`               (no destructive write yet)
 *   2. commit the baseline copy         -> journal `baseline_committed`
 *   3. same-directory stage, patch, validate, rename onto the live binary
 *                                        -> journal `binary_committed`
 *   4. publish the V2 manifest          -> journal `manifest_committed`
 *   5. journal `completed`
 */
export async function applyPatchTransactionV2(
  input: ApplyPatchInput,
  runtime: PatchRuntime = defaultPatchRuntime,
): Promise<ApplyOutcome> {
  const { installation, desiredConfig, configHash, manifest, recoveryBaseline } = input;
  const { identity, canonicalPath, version } = installation;
  if (!isClaudeCodeVersionSupportedForBinaryPatching(version)) {
    return { ok: false, message: unsupportedClaudeCodeBinaryPatchingMessage(version) };
  }
  const now = () => new Date().toISOString();

  const live = await runtime.inspect(canonicalPath, manifest?.patchedSha256);
  if (!live.readable || !live.sha256 || !live.version) {
    return { ok: false, message: describeInspectFailure(live) };
  }
  if (live.version !== version) {
    return { ok: false, message: 'The live claude version changed during inspection.' };
  }
  if (live.injection.state === 'ambiguous') {
    return { ok: false, message: 'The live claude injection marker is ambiguous.' };
  }

  let baselineSourcePath = canonicalPath;
  let provenance: BaselineProvenance = 'live';
  if (live.injection.state === 'present') {
    const candidate: BaselineCandidate | null = manifest
      ? {
          sourcePath: manifest.baselinePath,
          sha256: manifest.baselineSha256,
          provenance: 'backup',
        }
      : recoveryBaseline
        ? {
            sourcePath: recoveryBaseline.sourcePath,
            sha256: recoveryBaseline.sha256,
            provenance: recoveryBaseline.provenance,
          }
        : null;
    if (!candidate) {
      return {
        ok: false,
        message: 'Injected claude has no patch manifest or verified pristine recovery baseline for this target.',
      };
    }
    if (recoveryBaseline && recoveryBaseline.version !== version) {
      return { ok: false, message: 'The verified recovery baseline version does not match the live target.' };
    }
    const baselineError = await validatePristineBaseline({ candidate, version, runtime });
    if (baselineError) return { ok: false, message: baselineError };
    baselineSourcePath = candidate.sourcePath;
    provenance = candidate.provenance;
  }

  const generation = (manifest?.generation ?? 0) + 1;
  const journalBase = {
    schemaVersion: PATCH_JOURNAL_SCHEMA_VERSION as typeof PATCH_JOURNAL_SCHEMA_VERSION,
    operation: 'patch' as const,
    identity,
    canonicalPath,
    generation,
    expectedPreHash: live.sha256,
    claudeVersion: version,
    configHash,
    transformVersion: currentTransformVersion(),
    provenance,
    startedAt: now(),
  };

  writeJournal({ ...journalBase, phase: 'prepared', baselineSha256: '', baselinePath: '', updatedAt: now() });

  let baselineSha256: string;
  let baselinePath: string;
  try {
    baselineSha256 = sha256File(baselineSourcePath);
    baselinePath = ensureBaselineStored({ identity, version, baselineSha256, sourcePath: baselineSourcePath });
  } catch (err) {
    clearPatchJournal(identity);
    return { ok: false, message: `Could not store the pristine baseline: ${err instanceof Error ? err.message : String(err)}` };
  }
  writeJournal({ ...journalBase, phase: 'baseline_committed', baselineSha256, baselinePath, updatedAt: now() });

  const stage = sameDirectoryStagePath(canonicalPath, 'patch');
  let results: PatchSiteResult[] = [];
  try {
    copyImmutableFileSync(baselinePath, stage, { mode: statSync(canonicalPath).mode & 0o777 });
    results = await runtime.patch(stage, desiredConfig);
    const stagedPatched = await runtime.inspect(stage);
    if (
      !stagedPatched.readable
      || stagedPatched.version !== version
      || stagedPatched.injection.evidence !== 'marker-v1'
      || !stagedPatched.sha256
    ) {
      return { ok: false, message: 'Patched candidate failed staged validation.' };
    }
    const patchedSize = statSync(stage).size;
    writeJournal({
      ...journalBase,
      phase: 'binary_committed',
      baselineSha256,
      baselinePath,
      patchedSha256: stagedPatched.sha256,
      patchedSize,
      updatedAt: now(),
    });
    commitSameDirectoryStageSync(stage, canonicalPath);

    const manifestV2: PatchManifestV2 = {
      schemaVersion: 2,
      transformVersion: currentTransformVersion(),
      generation,
      logicalPath: installation.logicalPath,
      canonicalPath,
      installationKind: installation.installationKind,
      claudeVersion: version,
      baselineSha256,
      baselinePath,
      patchedSha256: stagedPatched.sha256,
      patchedSize,
      semanticFingerprint: computeSemanticFingerprint(results),
      configHash,
      provenance,
      completedAt: now(),
    };
    writeManifestV2(identity, manifestV2);
    writeJournal({
      ...journalBase,
      phase: 'completed',
      baselineSha256,
      baselinePath,
      patchedSha256: stagedPatched.sha256,
      patchedSize: manifestV2.patchedSize,
      updatedAt: now(),
    });
  } catch (err) {
    const detailLines = err instanceof PatchApplyError
      ? err.results.map(r => `${r.status} ${r.name}${r.extra ? ` (${r.extra})` : ''}`)
      : [];
    return {
      ok: false,
      message: `Patch failed: ${err instanceof Error ? err.message : String(err)}`,
      detailLines,
    };
  } finally {
    try {
      unlinkSync(stage);
    } catch {
    }
  }

  const modelCount = Object.keys(desiredConfig).length;
  return {
    ok: true,
    message: `Patched claude ${version}: ${modelCount} model${modelCount === 1 ? '' : 's'} configured.`,
    detailLines: results.map(r => `${r.status} ${r.name}${r.extra ? ` (${r.extra})` : ''}`),
  };
}

export interface RestorePatchInput {
  installation: ClaudeInstallation;
  manifest: PatchManifestV2 | null;
}

/**
 * Restore the pristine baseline over the live binary and clear this target's
 * patch state, in the same journaled sequence as apply (no separate baseline
 * step is needed: the baseline is already immutable content-addressed
 * storage, so the transaction goes straight to `binary_committed`, then
 * `manifest_committed` removes the manifest).
 */
export async function restorePatchTransactionV2(
  input: RestorePatchInput,
  runtime: PatchRuntime = defaultPatchRuntime,
): Promise<ApplyOutcome> {
  const { installation, manifest } = input;
  const { identity, canonicalPath, version } = installation;
  const now = () => new Date().toISOString();

  const live = await runtime.inspect(canonicalPath, manifest?.patchedSha256);
  if (!live.readable || !live.sha256 || !live.version) {
    return { ok: false, message: describeInspectFailure(live) };
  }
  if (live.version !== version) {
    return { ok: false, message: 'The live claude version changed during inspection.' };
  }
  if (live.injection.state !== 'present') {
    return { ok: false, message: 'Refusing restore because the live claude binary is not Leverframe-injected.' };
  }
  if (!manifest) return { ok: false, message: 'Injected claude has no patch manifest for this target.' };
  if (!existsSync(manifest.baselinePath)) return { ok: false, message: 'The saved baseline is missing.' };

  // Pre-fix baselines were stored owner-read-only; inspect shells out to
  // `--version` and treats that as unreadable unless the execute bit is back.
  ensureBaselineExecutable(manifest.baselinePath);
  const backup = await runtime.inspect(manifest.baselinePath);
  if (!backup.readable) {
    return { ok: false, message: `The saved baseline could not be read: ${backup.error ?? 'unknown reason'}` };
  }
  if (backup.version !== version) {
    return { ok: false, message: `The saved baseline is Claude Code ${backup.version ?? 'unknown'}, not ${version}.` };
  }
  if (backup.injection.state !== 'absent') {
    return { ok: false, message: `The saved baseline is already injected (${backup.injection.evidence}).` };
  }
  if (backup.sha256 !== manifest.baselineSha256) {
    return { ok: false, message: 'The saved baseline hash does not match the patch manifest.' };
  }

  const journalBase = {
    schemaVersion: PATCH_JOURNAL_SCHEMA_VERSION as typeof PATCH_JOURNAL_SCHEMA_VERSION,
    operation: 'restore' as const,
    identity,
    canonicalPath,
    generation: manifest.generation + 1,
    expectedPreHash: live.sha256,
    claudeVersion: version,
    configHash: manifest.configHash,
    transformVersion: manifest.transformVersion,
    provenance: 'backup' as const,
    baselineSha256: manifest.baselineSha256,
    baselinePath: manifest.baselinePath,
    startedAt: now(),
  };
  writeJournal({ ...journalBase, phase: 'prepared', updatedAt: now() });
  writeJournal({ ...journalBase, phase: 'baseline_committed', updatedAt: now() });

  const stage = sameDirectoryStagePath(canonicalPath, 'restore');
  try {
    copyImmutableFileSync(manifest.baselinePath, stage, { mode: statSync(canonicalPath).mode & 0o777 });
    const candidate = await runtime.inspect(stage);
    if (
      !candidate.readable
      || candidate.version !== version
      || candidate.injection.state !== 'absent'
      || candidate.sha256 !== backup.sha256
    ) {
      return { ok: false, message: 'Restore candidate failed staged validation.' };
    }
    commitSameDirectoryStageSync(stage, canonicalPath);
    writeJournal({
      ...journalBase,
      phase: 'binary_committed',
      patchedSha256: candidate.sha256 ?? undefined,
      patchedSize: statSync(canonicalPath).size,
      updatedAt: now(),
    });

    removeManifestV2(identity);
    writeJournal({ ...journalBase, phase: 'manifest_committed', updatedAt: now() });
    writeJournal({ ...journalBase, phase: 'completed', updatedAt: now() });
    return { ok: true, message: `Restored pristine claude ${version} from ${manifest.baselinePath}.` };
  } catch (err) {
    return { ok: false, message: `Restore failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try {
      unlinkSync(stage);
    } catch {
    }
  }
}
