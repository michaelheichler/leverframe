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
import type { FavoriteModel, LocalProvider } from './types.js';
import type { CachedModel, RegistryProvider } from './registry/types.js';
import { runPatchCommandV2, runLaunchPatchCheckV2 } from './patch-reconcile.js';
import { diagnosePatchV2, formatPatchDiagnosticsText, type PatchDiagnosticsReport } from './patch-diagnostics.js';
import type { ClaudeInstallation } from './claude-installation.js';

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

export type PatchContextProvenance = 'confirmed' | 'unconfirmed' | 'missing';

export interface DesiredPatchConfig {
  config: PatchScriptModelConfig;
  unknownWindows: string[];
  provenance: Record<string, PatchContextProvenance>;
}

export interface PatchModelMeta {
  contextWindow?: number;

  maxContextWindow?: number;

  contextWindowUnconfirmed?: boolean;

  modelFormat?: 'anthropic' | 'openai';

  nativeAnthropic?: boolean;

  contextCeilingOverride?: number;
  displayName?: string;

  effort?: PatchScriptEffort;
}

export interface PatchModelConfigOptions {
  includeContextModes?: boolean;
}

interface PatchMetadataModel {
  id: string;
  name: string;
  modelFormat: CachedModel['modelFormat'];
  contextWindow?: number;
  maxContextWindow?: number;
  contextWindowUnconfirmed?: boolean;
}

function patchModelFormat(model: Pick<PatchMetadataModel, 'modelFormat'>): PatchModelMeta['modelFormat'] {
  return model.modelFormat === 'anthropic' || model.modelFormat === 'openai'
    ? model.modelFormat
    : undefined;
}

function buildPatchModelMeta(
  providerId: string,
  providerName: string,
  model: PatchMetadataModel,
  effort?: PatchScriptEffort,
): PatchModelMeta {
  return {
    contextWindow: !model.contextWindowUnconfirmed && model.contextWindow && model.contextWindow > 0
      ? model.contextWindow
      : undefined,
    maxContextWindow: model.maxContextWindow,
    contextWindowUnconfirmed: model.contextWindowUnconfirmed,
    modelFormat: patchModelFormat(model),
    nativeAnthropic: providerId === 'anthropic' && model.modelFormat === 'anthropic',
    displayName: httpProxyDisplayName(model, providerName),
    effort,
  };
}

export function reasoningEffortForPatch(provider: RegistryProvider, model: CachedModel): PatchScriptEffort | undefined {
  const npm = model.npm ?? provider.api.npm;
  if (!npm || model.modelFormat !== 'openai') return undefined;
  const metadata: ReasoningMetadata = {
    providerId: provider.templateId ?? provider.id,
    apiBaseUrl: model.apiUrl ?? provider.api.url,
    supportedParameters: model.supportedParameters,
    reasoning: model.reasoning,
    supportsTemperature: model.supportsTemperature,
    supportedReasoningEfforts: model.supportedReasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
    supportsReasoningToggle: model.supportsReasoningToggle,
    supportsPromptCacheBreakpoints: model.supportsPromptCacheBreakpoints,
    interleavedReasoningField: model.interleavedReasoningField,
  };
  const upstreamId = (model.upstreamModelId ?? model.id).replace(/\[1m\]$/i, '');
  const caps = getReasoningCapabilities(npm, upstreamId, metadata);
  if (!caps.defaultLevel || caps.levels.length === 0) return undefined;
  return { levels: [...caps.levels], defaultLevel: caps.defaultLevel };
}

function resolveContextForPatch(
  meta: PatchModelMeta | undefined,
): { context?: number; provenance: PatchContextProvenance } {

  const context = meta?.contextWindow;
  if (context === undefined || context <= 0) {
    return { provenance: meta?.contextWindowUnconfirmed ? 'unconfirmed' : 'missing' };
  }
  return { context, provenance: 'confirmed' };
}

export function buildPatchModelConfig(
  favorites: Array<{ providerId: string; modelId: string }>,
  aliases: Array<{ name: string; providerId: string; modelId: string }>,
  modelMetaFor: (providerId: string, modelId: string) => PatchModelMeta | undefined,
  options: PatchModelConfigOptions = {},
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
    if (
      options.includeContextModes !== false
      && meta?.modelFormat !== undefined
      && meta.nativeAnthropic !== true
      && meta?.contextWindow !== undefined
      && meta.contextWindow > 0
      && meta.contextWindowUnconfirmed !== true
    ) {
      const maximum = meta.maxContextWindow;
      entry.contextModes = maximum !== undefined
        && Number.isSafeInteger(maximum)
        && maximum > meta.contextWindow
        ? { default: meta.contextWindow, maximum }
        : { default: meta.contextWindow };
    }
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
      entry.contextModes
        ? [entry.contextModes.default, entry.contextModes.maximum ?? null]
        : null,
      entry.display ?? null,
      entry.effort ? [entry.effort.levels, entry.effort.defaultLevel] : null,
    ];
  });
  return createHash('sha256')
    .update(JSON.stringify([transformVersion, canonical]))
    .digest('hex');
}

export function buildDesiredPatchConfig(
  freshProviders?: LocalProvider[],
  selectedModel?: FavoriteModel,
  options: PatchModelConfigOptions = {},
): DesiredPatchConfig {
  const prefs = loadPreferences();
  const favorites = prefs.favoriteModels ?? [];
  const aliases = prefs.modelAliases ?? [];
  const registry = loadRegistry();

  const meta = new Map<string, PatchModelMeta>();
  if (freshProviders !== undefined) {
    for (const provider of freshProviders) {
      const registryProvider = registry.providers.find(candidate => candidate.id === provider.id);
      for (const model of provider.models) {
        const cachedModel = registryProvider?.modelsCache?.models.find(candidate => candidate.id === model.id);
        meta.set(
          `${provider.id}:${model.id}`,
          buildPatchModelMeta(
            provider.id,
            provider.name,
            model,
            registryProvider && cachedModel
              ? reasoningEffortForPatch(registryProvider, cachedModel)
              : undefined,
          ),
        );
      }
    }
  } else {
    for (const provider of registry.providers) {
      for (const model of provider.modelsCache?.models ?? []) {
        meta.set(
          `${provider.id}:${model.id}`,
          buildPatchModelMeta(provider.id, provider.name, model, reasoningEffortForPatch(provider, model)),
        );
      }
    }
  }

  const freshModels = freshProviders === undefined
    ? []
    : freshProviders.flatMap(provider => provider.models
      .filter(model => !(provider.id === 'anthropic' && model.modelFormat === 'anthropic'))
      .map(model => ({ providerId: provider.id, modelId: model.id })));
  const requestedModels = freshProviders !== undefined && selectedModel === undefined
    ? freshModels
    : selectedModel === undefined
      ? favorites
      : [selectedModel, ...favorites];
  const freshSelections = freshProviders === undefined
    ? requestedModels
    : requestedModels.filter(favorite => freshProviders.some(provider =>
      provider.id === favorite.providerId
      && provider.models.some(model => model.id === favorite.modelId),
    ));

  return buildPatchModelConfig(
    freshSelections,
    aliases,
    (providerId, modelId) => meta.get(`${providerId}:${modelId}`),
    options,
  );
}

export interface RunPatchCommandOptions {
  restore?: boolean;
  trace?: boolean;

  target?: string;

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
  opts: {
    agentStdout?: boolean;
    dryRun?: boolean;
    installation?: ClaudeInstallation;
    freshProviders?: LocalProvider[];
    selectedModel?: FavoriteModel;
    contextSelectionAvailable?: boolean;
  } = {},
): Promise<void> {
  return runLaunchPatchCheckV2(opts);
}

export type { PatchDiagnosticsReport };
export { diagnosePatchV2, formatPatchDiagnosticsText };
