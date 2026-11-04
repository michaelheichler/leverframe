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
  defaultHomeOwnsPatchedBinary,
  readManifestV2,
  removeManifestV2,
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
import { loadStoredRegistryProviders } from './registry/load.js';
import type { FavoriteModel, LocalProvider } from './types.js';
import type { RoutingConfig } from './model-routing.js';

export { migrateLegacyStateIfVerified } from './patch-legacy-recovery.js';

export async function reconcilePatchTransaction(
  installation: ClaudeInstallation,
  runtime: PatchRuntime = defaultPatchRuntime,
): Promise<{ action: 'none' | 'discarded' | 'completed' | 'left-in-place'; detail?: string }> {
  return withPatchTargetLock(installation.identity, () => reconcileOwnedPatchTransaction(installation, runtime), { waitMs: 500 });
}

async function reconcileOwnedPatchTransaction(
  installation: ClaudeInstallation,
  runtime: PatchRuntime,
): Promise<{ action: 'none' | 'discarded' | 'completed' | 'left-in-place'; detail?: string }> {
  const journal = readPatchJournal(installation.identity);
  if (!journal || journal.phase === 'completed') return { action: 'none' };

  const liveInspection = await runtime.inspect(installation.canonicalPath);
  if (!liveInspection.readable || !liveInspection.sha256) {
    return { action: 'left-in-place', detail: 'Live binary is unreadable during reconciliation.' };
  }
  const liveSha256 = liveInspection.sha256;

  if (journal.operation === 'restore' && liveSha256 === journal.baselineSha256) {
    removeManifestV2(installation.identity);
    clearPatchJournal(installation.identity);
    return { action: 'completed', detail: 'Completed an interrupted restore by removing its manifest.' };
  }

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
        removeManifestV2(installation.identity);
        clearPatchJournal(installation.identity);
        return { action: 'completed', detail: 'Completed an interrupted restore by removing its manifest.' };
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
  freshProviders?: LocalProvider[],
  selectedModel?: FavoriteModel,
  contextSelectionAvailable = true,
  routingAvailable = false,
  routingConfig?: RoutingConfig,
  routingPreflight?: ReturnType<typeof import('./routing-policy-identity.js').routingPreflight>,
  routingRecoveryOnly = false,
): Promise<CheckResult> {
  return withPatchTargetLock(installation.identity, () => checkOwnedPatchState({
    installation, runtime, freshProviders, selectedModel, contextSelectionAvailable, routingAvailable, routingConfig, routingPreflight, routingRecoveryOnly,
  }), { waitMs: 500 });
}

/** Because every staleness check must hash the same catalog. */
async function loadStoredPatchCatalog(): Promise<LocalProvider[]> {
  return (await loadStoredRegistryProviders({ agent: 'claude' })).providers;
}

async function checkOwnedPatchState(options: {
  installation: ClaudeInstallation;
  runtime: PatchRuntime;
  freshProviders?: LocalProvider[];
  selectedModel?: FavoriteModel;
  contextSelectionAvailable: boolean;
  routingAvailable?: boolean;
  routingConfig?: RoutingConfig;
  routingPreflight?: ReturnType<typeof import('./routing-policy-identity.js').routingPreflight>;
  routingRecoveryOnly?: boolean;
}): Promise<CheckResult> {
  const { installation, runtime, freshProviders, selectedModel, contextSelectionAvailable, routingAvailable, routingConfig, routingPreflight, routingRecoveryOnly } = options;
  const catalog = freshProviders ?? await loadStoredPatchCatalog();
  const desired = buildDesiredPatchConfig(catalog, selectedModel, {
    includeContextModes: contextSelectionAvailable,
    routingAvailable,
    routingConfig,
    routingPreflight,
    routingRecoveryOnly,
  });
  const configHash = computePatchConfigHash(desired.config);

  await reconcileOwnedPatchTransaction(installation, runtime);
  const legacyInspection = await inspectLegacyPatchRecovery({ installation, runtime });
  if (legacyInspection.kind === 'exact-adoption') {
    await migrateLegacyStateIfVerified({
      installation,
      runtime,
      inspection: legacyInspection,
      desired,
    }).catch(() => undefined);
  }

  const manifest = readManifestV2(installation.identity);
  const live = await runtime.inspect(installation.canonicalPath, manifest?.patchedSha256);
  let semanticSitesComplete: boolean | undefined;
  if (
    live.readable
    && live.sha256
    && live.injection.state === 'present'
    && (routingAvailable || routingRecoveryOnly || !manifest || live.sha256 !== manifest.patchedSha256)
  ) {
    try {
      const content = await runtime.readContent(installation.canonicalPath, installation.version);
      semanticSitesComplete = verifyPatchSites(content, desired.config).complete;
    } catch {
      semanticSitesComplete = false;
    }
  }

  if ((routingAvailable || routingRecoveryOnly) && manifest && manifest.configHash === configHash
    && live.sha256 === manifest.patchedSha256 && semanticSitesComplete === false) {
    throw new Error('Routing integration is incomplete. Reapply the Claude integration from its saved baseline before launching.');
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

  const desired = buildDesiredPatchConfig(await loadStoredPatchCatalog());
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
  freshProviders?: LocalProvider[];
  selectedModel?: FavoriteModel;
  contextSelectionAvailable?: boolean;
  routingAvailable?: boolean;
  routingConfig?: RoutingConfig;
  routingPreflight?: ReturnType<typeof import('./routing-policy-identity.js').routingPreflight>;
  routingRecoveryOnly?: boolean;
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
  const catalogProviders = opts.freshProviders ?? await loadStoredPatchCatalog();
  let lockAcquired = false;
  return withPatchTargetLock(installation.identity, async () => {
    lockAcquired = true;
    const { manifest, state, desired, legacyRecovery } = await checkOwnedPatchState({
      installation,
      runtime,
      freshProviders: catalogProviders,
      selectedModel: opts.selectedModel,
      contextSelectionAvailable: opts.contextSelectionAvailable !== false,
      routingAvailable: opts.routingAvailable,
      routingConfig: opts.routingConfig,
      routingPreflight: opts.routingPreflight,
      routingRecoveryOnly: opts.routingRecoveryOnly,
    });
    if (opts.restore) {
      const outcome = await restorePatchTransactionV2({ installation, manifest }, runtime);
      return reportOutcome(outcome, false, presenter);
    }

    if (Object.keys(desired.config).length === 0) {
      presenter.error('No provider models to patch. Add a provider with `leverframe providers` first.');
      return 1;
    }
    for (const id of desired.unknownWindows) {
      presenter.warn(`No confirmed context window metadata for ${id}; context selection remains unavailable.`);
    }
    for (const [id, prov] of Object.entries(desired.provenance)) {
      if (prov !== 'unconfirmed') continue;
      presenter.warn(`Context window for ${id} is provider-unconfirmed; context selection remains unavailable.`);
    }
    if (opts.trace) {
      for (const id of Object.keys(desired.config)) {
        const context = desired.config[id]?.context ?? '-';
        presenter.detail(`trace: model=${id} context=${context} provenance=${desired.provenance[id] ?? 'missing'}`);
      }
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
    if (lockAcquired) {
      presenter.error(`Could not inspect or patch claude: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
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

const silentPatchPresenter: PatchPresenter = {
  error() {},
  warn() {},
  success() {},
  detail() {},
  notice() {},
  async confirm() { return false; },
};

export async function runLaunchPatchCheckV2(
  opts: {
    agentStdout?: boolean;
    dryRun?: boolean;
    installation?: ClaudeInstallation;
    runtime?: PatchRuntime;
    freshProviders?: LocalProvider[];
    selectedModel?: FavoriteModel;
    contextSelectionAvailable?: boolean;
    routingAvailable?: boolean;
    routingConfig?: RoutingConfig;
    routingPreflight?: ReturnType<typeof import('./routing-policy-identity.js').routingPreflight>;
    routingRecoveryOnly?: boolean;
  } = {},
  presenter: PatchPresenter = clackPatchPresenter,
): Promise<void> {
  try {
    const runtime = opts.runtime ?? defaultPatchRuntime;
    const installation = opts.installation ?? resolveClaudeInstallation();
    if (!installation) {
      if (opts.routingAvailable || opts.routingRecoveryOnly) throw new Error('Routing requires a Claude installation.');
      return;
    }
    if (!isClaudeCodeVersionSupportedForBinaryPatching(installation.version)) {
      if (opts.routingAvailable || opts.routingRecoveryOnly) throw new Error('Routing requires a supported Claude integration.');
      presenter.notice(unsupportedClaudeCodeBinaryPatchingMessage(installation.version));
      return;
    }
    const { manifest, state, desired, legacyRecovery } = await checkResolvedPatchState(
      installation,
      runtime,
      opts.freshProviders,
      opts.selectedModel,
      opts.contextSelectionAvailable !== false,
      opts.routingAvailable === true,
      opts.routingConfig,
      opts.routingPreflight,
      opts.routingRecoveryOnly === true,
    );
    if (Object.keys(desired.config).length === 0) {
      if (
        opts.freshProviders !== undefined
        && !opts.dryRun
        && manifest
        && (state === 'patched' || state === 'config_stale')
      ) {
        const outcome = await withPatchTargetLock(
          installation.identity,
          async () => {
            const current = await checkOwnedPatchState({
              installation, runtime, freshProviders: opts.freshProviders,
              selectedModel: opts.selectedModel,
              contextSelectionAvailable: opts.contextSelectionAvailable !== false,
              routingAvailable: opts.routingAvailable,
              routingConfig: opts.routingConfig,
              routingPreflight: opts.routingPreflight,
              routingRecoveryOnly: opts.routingRecoveryOnly,
            });
            if (!current.manifest || (current.state !== 'patched' && current.state !== 'config_stale')) {
              return { ok: true, message: 'No stale integration remains to restore.' };
            }
            return restorePatchTransactionV2({ installation, manifest: current.manifest }, runtime);
          },
          { waitMs: 500 },
        );
        if (!outcome.ok) throw new Error(outcome.message);
        if (!opts.agentStdout) presenter.notice('Fresh model discovery returned no configured models; restored the stale Claude integration.');
      }
      return;
    }
    if (isCurrentPatchState(state)) return;

    if (opts.dryRun) {
      if (!opts.agentStdout) {
        presenter.notice(`leverframe: claude binary is ${describePatchStateV2(state)} for your favorites. Run \`leverframe patch\`.`);
      }
      return;
    }

    const legacyRecoveryUnsafe = state === 'state_missing' && (!legacyRecovery || legacyRecovery.kind === 'unavailable');
    if (legacyRecoveryUnsafe) {
      const live = await runtime.inspect(installation.canonicalPath);
      if (defaultHomeOwnsPatchedBinary(installation.identity, live.sha256)) {
        return;
      }
      const reason = legacyRecovery?.kind === 'unavailable'
        ? ` (${legacyRecovery.reason})`
        : '';
      presenter.notice(
        `leverframe: injected claude has no V2 patch state and cannot be recovered safely${reason} Run \`leverframe patch --diagnose\`.`,
      );
      throw new Error('Claude integration state cannot be recovered safely');
    }

    const interactive = !opts.agentStdout
      && process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (interactive) {
      const message = state === 'state_missing'
        ? 'Claude Code is injected but missing V2 state. Rebuild it from the verified pristine legacy backup now?'
        : state === 'unpatched'
          ? 'Claude Code is not patched for your leverframe favorites. Patch now?'
          : 'The Claude Code patch is stale (config or claude version changed). Re-patch now?';
      if (!await presenter.confirm(message)) throw new Error('Claude integration is required before launch');
      const exitCode = await runPatchCommandV2(
        {
          installation,
          runtime,
          freshProviders: opts.freshProviders,
          selectedModel: opts.selectedModel,
          contextSelectionAvailable: opts.contextSelectionAvailable,
          routingAvailable: opts.routingAvailable,
          routingConfig: opts.routingConfig,
          routingPreflight: opts.routingPreflight,
          routingRecoveryOnly: opts.routingRecoveryOnly,
        },
        presenter,
      );
      if (exitCode !== 0) throw new Error('Claude integration failed; launch blocked');
      return;
    }

    const exitCode = await runPatchCommandV2(
      {
        installation,
        runtime,
        freshProviders: opts.freshProviders,
        selectedModel: opts.selectedModel,
        contextSelectionAvailable: opts.contextSelectionAvailable,
        routingAvailable: opts.routingAvailable,
        routingConfig: opts.routingConfig,
        routingPreflight: opts.routingPreflight,
        routingRecoveryOnly: opts.routingRecoveryOnly,
      },
      opts.agentStdout ? silentPatchPresenter : presenter,
    );
    if (exitCode !== 0) throw new Error('Claude integration failed; launch blocked');
  } catch (err) {
    presenter.error(`leverframe: Claude integration unavailable (${err instanceof Error ? err.message : String(err)})`);
    throw err;
  }
}
