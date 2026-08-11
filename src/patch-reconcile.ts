import { statSync } from 'node:fs';
import {
  isClaudeCodeVersionSupportedForBinaryPatching,
  resolveClaudeInstallation,
  unsupportedClaudeCodeBinaryPatchingMessage,
  type ClaudeInstallation,
} from './claude-installation.js';
import { withPatchTargetLock } from './patch-lock.js';
import { clackPatchPresenter, type PatchPresenter } from './patch-presenter.js';
import {
  clearPatchJournal,
  applyPatchTransactionV2,
  computeSemanticFingerprint,
  defaultPatchRuntime,
  readPatchJournal,
  restorePatchTransactionV2,
  verifyPatchSites,
  type ApplyOutcome,
  type PatchRuntime,
} from './patch-transaction.js';
import {
  readManifestV2,
  writeManifestV2,
  type PatchManifestV2,
} from './patch-state.js';
import {
  describePatchStateV2,
  evaluatePatchStateV2,
  isCurrentPatchState,
  type PatchStateV2,
} from './patch-classify.js';
import {
  inspectLegacyPatchRecovery,
  migrateLegacyStateIfVerified,
  type LegacyPatchRecoveryInspection,
} from './patch-legacy-recovery.js';
import { buildDesiredPatchConfig, computePatchConfigHash, type DesiredPatchConfig } from './patcher.js';

export { migrateLegacyStateIfVerified } from './patch-legacy-recovery.js';

/**
 * Inspect a possibly-interrupted transaction journal against the live
 * binary's current hash and either complete it, discard it as safely
 * abandoned, or leave it in place with a report when neither hash matches
 * (a case requiring a human to look, not autonomous action).
 */
export async function reconcilePatchTransaction(
  installation: ClaudeInstallation,
  runtime: PatchRuntime = defaultPatchRuntime,
): Promise<{ action: 'none' | 'discarded' | 'completed' | 'left-in-place'; detail?: string }> {
  const journal = readPatchJournal(installation.identity);
  if (!journal || journal.phase === 'completed') return { action: 'none' };

  const liveInspection = await runtime.inspect(installation.canonicalPath);
  if (!liveInspection.readable || !liveInspection.sha256) {
    return { action: 'left-in-place', detail: 'Live binary is unreadable during reconciliation.' };
  }
  const liveSha256 = liveInspection.sha256;

  if (journal.phase === 'prepared' || journal.phase === 'baseline_committed') {
    clearPatchJournal(installation.identity);
    return { action: 'discarded', detail: `Discarded an interrupted ${journal.operation} at phase ${journal.phase}.` };
  }

  if (journal.phase === 'binary_committed') {
    if (journal.patchedSha256 && liveSha256 === journal.patchedSha256) {
      const manifest: PatchManifestV2 = {
        schemaVersion: 2,
        transformVersion: journal.transformVersion,
        generation: journal.generation,
        logicalPath: installation.logicalPath,
        canonicalPath: installation.canonicalPath,
        installationKind: installation.installationKind,
        claudeVersion: journal.claudeVersion,
        baselineSha256: journal.baselineSha256,
        baselinePath: journal.baselinePath,
        patchedSha256: journal.patchedSha256,
        patchedSize: journal.patchedSize ?? statSync(installation.canonicalPath).size,
        semanticFingerprint: computeSemanticFingerprint([{ status: 'OK', name: 'reconciled-from-journal' }]),
        configHash: journal.configHash,
        provenance: journal.provenance,
        completedAt: new Date().toISOString(),
      };
      if (journal.operation === 'restore') {
        clearPatchJournal(installation.identity);
        return { action: 'completed', detail: 'Completed an interrupted restore (manifest already absent).' };
      }
      writeManifestV2(installation.identity, manifest);
      clearPatchJournal(installation.identity);
      return { action: 'completed', detail: 'Completed an interrupted patch by publishing its manifest.' };
    }
    if (liveSha256 === journal.expectedPreHash) {
      clearPatchJournal(installation.identity);
      return { action: 'discarded', detail: `Discarded an interrupted ${journal.operation}; the live binary was never modified.` };
    }
    clearPatchJournal(installation.identity);
    return {
      action: 'left-in-place',
      detail: 'The live claude binary changed to a hash unrelated to the interrupted transaction; leaving it as-is.',
    };
  }

  clearPatchJournal(installation.identity);
  return { action: 'completed', detail: 'Completed an interrupted transaction at its final phase.' };
}

export interface CheckResult {
  installation: ClaudeInstallation | null;
  manifest: PatchManifestV2 | null;
  state: PatchStateV2 | null;
  desired: DesiredPatchConfig;
  configHash: string;
  legacyRecovery: LegacyPatchRecoveryInspection | null;
}

export async function checkResolvedPatchState(
  installation: ClaudeInstallation,
  runtime: PatchRuntime = defaultPatchRuntime,
): Promise<CheckResult> {
  const desired = buildDesiredPatchConfig();
  const configHash = computePatchConfigHash(desired.config);

  await reconcilePatchTransaction(installation, runtime);
  const legacyInspection = await inspectLegacyPatchRecovery({ installation, runtime });
  if (legacyInspection.kind === 'exact-adoption') {
    await migrateLegacyStateIfVerified({
      installation,
      runtime,
      inspection: legacyInspection,
    }).catch(() => undefined);
  }

  const manifest = readManifestV2(installation.identity);
  const live = await runtime.inspect(installation.canonicalPath, manifest?.patchedSha256);
  let semanticSitesComplete: boolean | undefined;
  if (
    live.readable
    && live.sha256
    && live.injection.state === 'present'
    && (!manifest || live.sha256 !== manifest.patchedSha256)
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
    live: { readable: live.readable, version: live.version, sha256: live.sha256, injectionState: live.injection.state },
    desiredConfigHash: configHash,
    semanticSitesComplete,
  });
  return {
    installation,
    manifest,
    state,
    desired,
    configHash,
    legacyRecovery: manifest ? null : legacyInspection,
  };
}

export async function checkPatchState(
  target?: string,
  runtime: PatchRuntime = defaultPatchRuntime,
): Promise<CheckResult> {
  const installation = resolveClaudeInstallation({ target });
  if (installation) return checkResolvedPatchState(installation, runtime);

  const desired = buildDesiredPatchConfig();
  return {
    installation: null,
    manifest: null,
    state: null,
    desired,
    configHash: computePatchConfigHash(desired.config),
    legacyRecovery: null,
  };
}

export interface RunPatchCommandV2Options {
  restore?: boolean;
  trace?: boolean;
  target?: string;
  installation?: ClaudeInstallation;
  runtime?: PatchRuntime;
}

export async function runPatchCommandV2(
  opts: RunPatchCommandV2Options = {},
  presenter: PatchPresenter = clackPatchPresenter,
): Promise<number> {
  const runtime = opts.runtime ?? defaultPatchRuntime;
  const installation = opts.installation ?? resolveClaudeInstallation({ target: opts.target });
  if (!installation) {
    presenter.error('claude binary not found. Install Claude Code, set TWEAKCC_CC_INSTALLATION_PATH, or pass --target.');
    return 1;
  }
  if (!opts.restore && !isClaudeCodeVersionSupportedForBinaryPatching(installation.version)) {
    presenter.error(unsupportedClaudeCodeBinaryPatchingMessage(installation.version));
    return 1;
  }
  const { manifest, state, desired, legacyRecovery } = await checkResolvedPatchState(installation, runtime);

  return withPatchTargetLock(installation.identity, async () => {
    if (opts.restore) {
      const outcome = await restorePatchTransactionV2({ installation, manifest }, runtime);
      return reportOutcome(outcome, false, presenter);
    }

    if (Object.keys(desired.config).length === 0) {
      presenter.error('No favorite models to patch. Save favorites with `leverframe models` first.');
      return 1;
    }
    for (const id of desired.unknownWindows) {
      presenter.warn(`No context window metadata for ${id}. Claude Code will assume the 200k default.`);
    }
    if (isCurrentPatchState(state)) {
      const detail = state === 'modified_but_injected'
        ? ' Exact bytes changed after publication, but all current semantic sites verify.'
        : '';
      presenter.success(`claude ${installation.version} is already patched with the current model config.${detail} Nothing to do.`);
      return 0;
    }
    const configHash = computePatchConfigHash(desired.config);
    const recoveryBaseline = !manifest && legacyRecovery && legacyRecovery.kind !== 'unavailable'
      ? legacyRecovery.baseline
      : undefined;
    const outcome = await applyPatchTransactionV2({
      installation,
      desiredConfig: desired.config,
      configHash,
      manifest,
      recoveryBaseline,
      trace: opts.trace ?? false,
    }, runtime);
    return reportOutcome(outcome, opts.trace ?? false, presenter);
  }, { waitMs: 500 }).catch((err: unknown) => {
    presenter.warn(`Another leverframe process is patching the claude binary right now. Skipped. (${err instanceof Error ? err.message : String(err)})`);
    return 1;
  });
}

function isSkipOrFailDetailLine(line: string): boolean {
  return line.startsWith('SKIP ') || line.startsWith('FAIL ');
}

function reportOutcome(outcome: ApplyOutcome, trace: boolean, presenter: PatchPresenter): number {
  if (!outcome.ok) {
    presenter.error(outcome.message);
    for (const line of outcome.detailLines ?? []) presenter.detail(line);
    return 1;
  }
  presenter.success(outcome.message);
  for (const line of outcome.detailLines ?? []) {
    if (trace || isSkipOrFailDetailLine(line)) presenter.detail(line);
  }
  return 0;
}

export async function runLaunchPatchCheckV2(
  opts: {
    agentStdout?: boolean;
    dryRun?: boolean;
    installation?: ClaudeInstallation;
    runtime?: PatchRuntime;
  } = {},
  presenter: PatchPresenter = clackPatchPresenter,
): Promise<void> {
  try {
    const runtime = opts.runtime ?? defaultPatchRuntime;
    const installation = opts.installation ?? resolveClaudeInstallation();
    if (!installation) return;
    if (!isClaudeCodeVersionSupportedForBinaryPatching(installation.version)) {
      presenter.notice(unsupportedClaudeCodeBinaryPatchingMessage(installation.version));
      return;
    }
    const { state, desired, legacyRecovery } = await checkResolvedPatchState(installation, runtime);
    if (Object.keys(desired.config).length === 0) return;
    if (isCurrentPatchState(state)) return;

    const interactive = !opts.dryRun && !opts.agentStdout
      && process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (!interactive) {
      if (!opts.agentStdout) {
        presenter.notice(`leverframe: claude binary is ${describePatchStateV2(state)} for your favorites. Run \`leverframe patch\`.`);
      }
      return;
    }

    if (state === 'state_missing' && (!legacyRecovery || legacyRecovery.kind === 'unavailable')) {
      const reason = legacyRecovery?.kind === 'unavailable'
        ? ` (${legacyRecovery.reason})`
        : '';
      presenter.notice(
        `leverframe: injected claude has no V2 patch state and cannot be recovered safely${reason} Run \`leverframe patch --diagnose\`.`,
      );
      return;
    }

    const message = state === 'state_missing'
      ? 'Claude Code is injected but missing V2 state. Rebuild it from the verified pristine legacy backup now?'
      : state === 'unpatched'
        ? 'Claude Code is not patched for your leverframe favorites. Patch now?'
        : 'The Claude Code patch is stale (config or claude version changed). Re-patch now?';
    if (!await presenter.confirm(message)) return;

    await runPatchCommandV2({ installation, runtime }, presenter);
  } catch (err) {
    presenter.notice(`leverframe: patch check skipped (${err instanceof Error ? err.message : String(err)})`);
  }
}
