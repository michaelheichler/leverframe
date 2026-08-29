import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAppHome } from './paths.js';
import { loadPreferences } from './config.js';
import { loadRegistry } from './registry/io.js';
import { resolveContextCeilingOverride } from './context-ceilings.js';
import { httpProxyDisplayName, httpProxyModelId } from './http-proxy/routes.js';
import { stripOneMContextSuffix } from './context-model-id.js';
import {
  PATCH_TRANSFORMS_VERSION,
  projectNativeEffort,
  type PatchScriptEffort,
  type PatchScriptModelConfig,
} from './patch-transforms.js';
import { getReasoningCapabilities, type ReasoningMetadata } from './provider-factory.js';
import type { CachedModel, RegistryProvider } from './registry/types.js';
import { runPatchCommandV2, runLaunchPatchCheckV2 } from './patch-reconcile.js';
import { diagnosePatchV2, formatPatchDiagnosticsText, type PatchDiagnosticsReport } from './patch-diagnostics.js';
import type { ClaudeInstallation } from './claude-installation.js';


/**
 * Shape of the pre-V2 single global patch-state manifest. Retained only for
 * conservative one-way migration: `readPatchManifest` lets
 * `migrateLegacyStateIfVerified` (src/patch-legacy-recovery.ts) and
 * `diagnosePatchV2` (src/patch-diagnostics.ts) recognize and verify an
 * existing legacy manifest before adopting it into the per-target V2 state
 * (src/patch-state.ts, src/patch-transaction.ts). Nothing writes this shape
 * anymore.
 */
export interface PatchManifest {
  binaryPath: string;
  claudeVersion: string;
  configHash: string;
  patchedSize: number;
  patchedSha256: string;
  backupPath: string;
  baselineSha256?: string;
  patchedAt: string;
}

function getPatchManifestPath(): string {
  return join(getAppHome(), 'patch-state.json');
}

export function readPatchManifest(path = getPatchManifestPath()): PatchManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PatchManifest;
    if (parsed && typeof parsed.binaryPath === 'string' && typeof parsed.configHash === 'string') {
      return parsed;
    }
  } catch {
  }
  return null;
}


/**
 * Per-favorite context-window provenance, surfaced for `--trace` and used
 * internally to decide whether a missing context belongs in `unknownWindows`
 * (truly missing metadata) versus a deliberate provider-unconfirmed value
 * (materialize.ts:83's rule: unconfirmed is withheld from the patch, not
 * reported as "missing").
 */
export type PatchContextProvenance = 'confirmed' | 'unconfirmed' | 'missing' | 'override';

export interface DesiredPatchConfig {
  config: PatchScriptModelConfig;
  unknownWindows: string[];
  provenance: Record<string, PatchContextProvenance>;
}

export interface PatchModelMeta {
  contextWindow?: number;
  /**
   * True when the cached model's context window is a heuristic guess rather
   * than provider-confirmed (mirrors `CachedModel.contextWindowUnconfirmed`,
   * src/registry/types.ts). When set, `contextWindow` here is expected to
   * already read `undefined` (see materialize.ts:83's rule) — this flag is
   * what lets `buildPatchModelConfig` tell "deliberately unconfirmed" apart
   * from "genuinely missing" so only the latter lands in `unknownWindows`.
   */
  contextWindowUnconfirmed?: boolean;
  /**
   * Documented ceiling the user opted this model into, when its provider
   * reports a lower tuned default (src/context-ceilings.ts). Outranks
   * `contextWindow` and is recorded with `override` provenance.
   */
  contextCeilingOverride?: number;
  displayName?: string;
  /**
   * Raw supplier reasoning-capability ladder (pre-projection), e.g. straight
   * from `getReasoningCapabilities`. `buildPatchModelConfig` runs this
   * through `projectNativeEffort` before baking it into the patch config, so
   * a ladder that cannot be represented on Claude Code's native picker is
   * silently omitted here rather than rejected — only a directly-constructed
   * `PatchScriptModelConfig` (bypassing this builder) hits the hard
   * `applyLeverframePatches` validation error for a malformed ladder.
   */
  effort?: PatchScriptEffort;
}

/**
 * Derive the same supplier-authoritative reasoning ladder used for proxy-side
 * effort wiring (`server/index.ts`'s `enrichServerModelReasoning`) so the
 * binary-side PATCH 8/9 capability gates and the request path agree about
 * which levels a model supports. Gated identically: only OpenAI-format
 * models routed through an OpenCode `npm` package carry reasoning metadata.
 * A model-level override wins over the provider-level `api.npm`/`api.url`,
 * matching every other registry consumer (e.g. `refresh-models.ts`).
 */
export function reasoningEffortForPatch(provider: RegistryProvider, model: CachedModel): PatchScriptEffort | undefined {
  const npm = model.npm ?? provider.api.npm;
  if (!npm || model.modelFormat !== 'openai') return undefined;
  const metadata: ReasoningMetadata = {
    providerId: provider.templateId ?? provider.id,
    apiBaseUrl: model.apiUrl ?? provider.api.url,
    supportedParameters: model.supportedParameters,
    reasoning: model.reasoning,
    interleavedReasoningField: model.interleavedReasoningField,
  };
  const upstreamId = (model.upstreamModelId ?? model.id).replace(/\[1m\]$/i, '');
  const caps = getReasoningCapabilities(npm, upstreamId, metadata);
  if (!caps.defaultLevel || caps.levels.length === 0) return undefined;
  return { levels: [...caps.levels], defaultLevel: caps.defaultLevel };
}

/**
 * Decide the context value (if any) to bake for one favorite and its
 * provenance, keeping `buildPatchModelConfig`'s loop guard-clause-flat.
 * `missing` (no known window, not deliberately unconfirmed) is the only
 * provenance that should land in `unknownWindows` — see materialize.ts:83.
 */
function resolveContextForPatch(
  meta: PatchModelMeta | undefined,
): { context?: number; provenance: PatchContextProvenance } {
  // An opted-in ceiling wins over the reported window and keeps its own
  // provenance, so diagnostics never present it as provider-confirmed.
  if (meta?.contextCeilingOverride !== undefined && meta.contextCeilingOverride > 0) {
    return { context: meta.contextCeilingOverride, provenance: 'override' };
  }
  const context = meta?.contextWindow;
  if (context === undefined || context <= 0) {
    return { provenance: meta?.contextWindowUnconfirmed ? 'unconfirmed' : 'missing' };
  }
  return { context: context === 200_000 ? undefined : context, provenance: 'confirmed' };
}

export function buildPatchModelConfig(
  favorites: Array<{ providerId: string; modelId: string }>,
  aliases: Array<{ name: string; providerId: string; modelId: string }>,
  modelMetaFor: (providerId: string, modelId: string) => PatchModelMeta | undefined,
): DesiredPatchConfig {
  const config: PatchScriptModelConfig = {};
  const unknownWindows: string[] = [];
  const provenance: Record<string, PatchContextProvenance> = {};
  const aliasByFavorite = new Map(aliases.map(a => [`${a.providerId}:${a.modelId}`, a.name]));

  for (const favorite of favorites) {
    const id = stripOneMContextSuffix(httpProxyModelId(favorite.providerId, favorite.modelId));
    if (config[id]) continue;
    const meta = modelMetaFor(favorite.providerId, favorite.modelId);
    const alias = aliasByFavorite.get(`${favorite.providerId}:${favorite.modelId}`);
    const entry: PatchScriptModelConfig[string] = {};
    if (alias) entry.alias = alias;
    const { context, provenance: contextProvenance } = resolveContextForPatch(meta);
    if (context !== undefined) entry.context = context;
    provenance[id] = contextProvenance;
    if (contextProvenance === 'missing') unknownWindows.push(id);
    const display = meta?.displayName?.trim();
    if (display) entry.display = display;
    const projectedEffort = projectNativeEffort(meta?.effort);
    if (projectedEffort) entry.effort = projectedEffort;
    config[id] = entry;
  }
  return { config, unknownWindows, provenance };
}

export function computePatchConfigHash(
  config: PatchScriptModelConfig,
  transformVersion = PATCH_TRANSFORMS_VERSION,
): string {
  const canonical = Object.keys(config).sort().map(key => {
    const entry = config[key]!;
    return [
      key,
      entry.alias ?? null,
      entry.context ?? null,
      entry.display ?? null,
      entry.effort ? [entry.effort.levels, entry.effort.defaultLevel] : null,
    ];
  });
  return createHash('sha256')
    .update(JSON.stringify([transformVersion, canonical]))
    .digest('hex');
}

export function buildDesiredPatchConfig(): DesiredPatchConfig {
  const prefs = loadPreferences();
  const favorites = prefs.favoriteModels ?? [];
  const aliases = prefs.modelAliases ?? [];
  const registry = loadRegistry();

  const meta = new Map<string, PatchModelMeta>();
  for (const provider of registry.providers) {
    for (const model of provider.modelsCache?.models ?? []) {
      meta.set(`${provider.id}:${model.id}`, {
        // Mirror materialize.ts:83's provenance rule: an unconfirmed window
        // is withheld here too, so it never gets baked into the binary as
        // if provider-confirmed.
        contextWindow: !model.contextWindowUnconfirmed && model.contextWindow && model.contextWindow > 0
          ? model.contextWindow
          : undefined,
        contextWindowUnconfirmed: model.contextWindowUnconfirmed,
        contextCeilingOverride: resolveContextCeilingOverride(model, prefs.contextCeilingOverrides),
        displayName: httpProxyDisplayName(model, provider.name),
        effort: reasoningEffortForPatch(provider, model),
      });
    }
  }

  return buildPatchModelConfig(
    favorites,
    aliases,
    (providerId, modelId) => meta.get(`${providerId}:${modelId}`),
  );
}


// --- V2 patch lifecycle -----------------------------------------------------
//
// `leverframe patch` and the launch-time patch check run against the
// per-target, journaled, crash-safe V2 state machine (src/patch-state.ts,
// src/patch-transaction.ts, src/patch-reconcile.ts). Only the legacy manifest
// shape and reader above remain here, kept solely so
// `migrateLegacyStateIfVerified` can conservatively adopt a pre-V2 global
// manifest into V2 exactly once; nothing else in this module writes or acts
// on that legacy state anymore.

export interface RunPatchCommandOptions {
  restore?: boolean;
  trace?: boolean;
  /** `leverframe patch --target <path>` — pin an explicit installation. */
  target?: string;
  /** `leverframe patch --diagnose[, --json]` — read-only report, no mutation. */
  diagnose?: boolean;
  json?: boolean;
}

export async function runPatchCommand(opts: RunPatchCommandOptions = {}): Promise<number> {
  if (opts.diagnose) {
    const report = await diagnosePatchV2(opts.target);
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const line of formatPatchDiagnosticsText(report)) console.log(line);
    }
    return 0;
  }
  return runPatchCommandV2(opts);
}

export async function runLaunchPatchCheck(
  opts: { agentStdout?: boolean; dryRun?: boolean; installation?: ClaudeInstallation } = {},
): Promise<void> {
  return runLaunchPatchCheckV2(opts);
}

export type { PatchDiagnosticsReport };
export { diagnosePatchV2, formatPatchDiagnosticsText };
