import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAppHome } from './paths.js';
import { loadPreferences } from './config.js';
import { loadRegistry } from './registry/io.js';
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


export interface DesiredPatchConfig {
  config: PatchScriptModelConfig;
  unknownWindows: string[];
}

export interface PatchModelMeta {
  contextWindow?: number;
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

export function buildPatchModelConfig(
  favorites: Array<{ providerId: string; modelId: string }>,
  aliases: Array<{ name: string; providerId: string; modelId: string }>,
  modelMetaFor: (providerId: string, modelId: string) => PatchModelMeta | undefined,
): DesiredPatchConfig {
  const config: PatchScriptModelConfig = {};
  const unknownWindows: string[] = [];
  const aliasByFavorite = new Map(aliases.map(a => [`${a.providerId}:${a.modelId}`, a.name]));

  for (const favorite of favorites) {
    const id = stripOneMContextSuffix(httpProxyModelId(favorite.providerId, favorite.modelId));
    if (config[id]) continue;
    const meta = modelMetaFor(favorite.providerId, favorite.modelId);
    const context = meta?.contextWindow;
    const alias = aliasByFavorite.get(`${favorite.providerId}:${favorite.modelId}`);
    const entry: PatchScriptModelConfig[string] = {};
    if (alias) entry.alias = alias;
    if (context === undefined || context <= 0) unknownWindows.push(id);
    else if (context !== 200_000) entry.context = context;
    const display = meta?.displayName?.trim();
    if (display) entry.display = display;
    const projectedEffort = projectNativeEffort(meta?.effort);
    if (projectedEffort) entry.effort = projectedEffort;
    config[id] = entry;
  }
  return { config, unknownWindows };
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
        contextWindow: model.contextWindow && model.contextWindow > 0 ? model.contextWindow : undefined,
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
