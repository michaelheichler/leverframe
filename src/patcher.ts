import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAppHome } from './paths.js';
import { loadPreferences } from './config.js';
import { loadRegistry } from './registry/io.js';
import { httpProxyDisplayName, httpProxyModelId } from './http-proxy/routes.js';
import { stripContextMarkers, stripOneMContextSuffix } from './context-model-id.js';
import {
  PATCH_TRANSFORMS_VERSION,
  ROUTING_RECOVERY_ENTRY,
  projectNativeEffort,
  type PatchScriptEffort,
  type PatchScriptModelConfig,
} from './patch-transforms.js';
import { getReasoningCapabilities, type ReasoningMetadata } from './provider-factory.js';
import { formatModelCapabilities } from './ui.js';
import type { FavoriteModel, LocalProvider } from './types.js';
import { projectRoutingPromptPolicy, type RoutingConfig } from './model-routing.js';
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
  accountTag?: string;
  contextWindow?: number;

  maxContextWindow?: number;

  contextWindowUnconfirmed?: boolean;

  modelFormat?: 'anthropic' | 'openai';

  nativeAnthropic?: boolean;

  contextCeilingOverride?: number;
  displayName?: string;

  capabilities?: string;

  effort?: PatchScriptEffort;
}

export interface PatchModelConfigOptions {
  includeContextModes?: boolean;
  routingAvailable?: boolean;
  routingRecoveryOnly?: boolean;
  routingConfig?: RoutingConfig;
  routingPreflight?: ReturnType<typeof import('./routing-policy-identity.js').routingPreflight>;

  agentModels?: Array<{ providerId: string; modelId: string }>;
}

interface PatchMetadataModel {
  id: string;
  accountTag?: string;
  name: string;
  modelFormat: CachedModel['modelFormat'];
  contextWindow?: number;
  maxContextWindow?: number;
  contextWindowUnconfirmed?: boolean;
  usageMultiplier?: number;
  usageMultiplierApplies?: boolean;
  peakCostMultiplier?: number;
  deprecated?: boolean;
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
    accountTag: model.accountTag,
    contextWindow: !model.contextWindowUnconfirmed && model.contextWindow && model.contextWindow > 0
      ? model.contextWindow
      : undefined,
    maxContextWindow: model.maxContextWindow,
    contextWindowUnconfirmed: model.contextWindowUnconfirmed,
    modelFormat: patchModelFormat(model),
    nativeAnthropic: providerId === 'anthropic' && model.modelFormat === 'anthropic',
    displayName: httpProxyDisplayName(model, providerName),
    capabilities: formatModelCapabilities(model),
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
  if (meta?.contextWindowUnconfirmed === true) return { provenance: 'unconfirmed' };
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
  const agentKeys = options.agentModels === undefined
    ? undefined
    : new Set(options.agentModels.map(model => `${model.providerId}:${stripContextMarkers(model.modelId)}`));

  for (const favorite of favorites) {
    const id = stripOneMContextSuffix(httpProxyModelId(favorite.providerId, favorite.modelId));
    if (config[id]) continue;
    const meta = modelMetaFor(favorite.providerId, favorite.modelId);
    const alias = aliasByFavorite.get(`${favorite.providerId}:${favorite.modelId}`);
    const entry: PatchScriptModelConfig[string] = {};
    if (meta?.accountTag) entry.accountTag = meta.accountTag;
    if (alias) entry.alias = alias;
    const { context, provenance: contextProvenance } = resolveContextForPatch(meta);
    if (context !== undefined) entry.context = context;
    if (
      options.includeContextModes !== false
      && meta?.modelFormat !== undefined
      && meta.nativeAnthropic !== true
      && context === undefined
    ) entry.contextSelection = true;
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
    if (meta?.capabilities && meta.capabilities !== '[]') entry.capabilities = meta.capabilities;
    const projectedEffort = projectNativeEffort(meta?.effort);
    if (projectedEffort) entry.effort = projectedEffort;
    if (
      agentKeys !== undefined
      && !alias
      && !agentKeys.has(`${favorite.providerId}:${stripContextMarkers(favorite.modelId)}`)
    ) entry.pickerOnly = true;
    config[id] = entry;
  }
  return { config, unknownWindows, provenance };
}

const ROUTING_NOTICE_PATCH_REVISION = 1;

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
      entry.contextSelection === true,
      entry.pickerOnly === true,
      entry.accountTag ?? null,
      entry.capabilities ?? null,
      ...(entry.routingEnabled ? [true, entry.routingPolicyModelId ?? null, entry.routingMetadata ?? null,
        entry.routingTargetMetadata ?? null, entry.routingPromptPolicy ?? null, ROUTING_NOTICE_PATCH_REVISION] : []),
      ...(entry.routingRecoveryOnly ? [ROUTING_NOTICE_PATCH_REVISION] : []),
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
        meta.set(
          `${provider.id}:${model.id}`,
          buildPatchModelMeta(
            provider.id,
            provider.name,
            model,
            registryProvider
              ? reasoningEffortForPatch(registryProvider, { ...model, apiUrl: model.apiBaseUrl })
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

  const favoriteOrder = new Map<string, number>();
  favorites.forEach((favorite, index) => {
    const key = `${favorite.providerId}:${stripContextMarkers(favorite.modelId)}`;
    if (!favoriteOrder.has(key)) favoriteOrder.set(key, index);
  });
  const freshModels = freshProviders === undefined
    ? []
    : freshProviders.flatMap(provider => provider.models
      .filter(model => !(provider.id === 'anthropic' && model.modelFormat === 'anthropic'))
      .map(model => ({ providerId: provider.id, modelId: model.id })))
      .map((model, index) => ({ model, index }))
      .sort((left, right) => {
        const leftRank = favoriteOrder.get(`${left.model.providerId}:${stripContextMarkers(left.model.modelId)}`);
        const rightRank = favoriteOrder.get(`${right.model.providerId}:${stripContextMarkers(right.model.modelId)}`);
        if (leftRank !== undefined || rightRank !== undefined) {
          if (leftRank === undefined) return 1;
          if (rightRank === undefined) return -1;
          if (leftRank !== rightRank) return leftRank - rightRank;
        }
        return left.index - right.index;
      })
      .map(({ model }) => model);
  const scopeModels = freshProviders === undefined
    ? [...favorites, ...aliases.map(({ providerId, modelId }) => ({ providerId, modelId }))]
    : freshModels;
  const requestedModels = selectedModel === undefined ? scopeModels : [selectedModel, ...scopeModels];
  const freshSelections = freshProviders === undefined
    ? requestedModels
    : requestedModels.filter(favorite => freshProviders.some(provider =>
      provider.id === favorite.providerId
      && provider.models.some(model => model.id === favorite.modelId),
    ));

  const desired = buildPatchModelConfig(
    freshSelections,
    aliases,
    (providerId, modelId) => meta.get(`${providerId}:${modelId}`),
    { ...options, agentModels: favorites },
  );
  const routingConfig = options.routingConfig ?? prefs.routing;
  if (options.routingAvailable && routingConfig?.enabled) {
    if (!options.routingPreflight) throw new Error('Routing preflight is required for Claude integration.');
    const id = routingConfig.visibleModelId ?? 'auto';
    desired.config[id] = { ...desired.config[id], display: routingConfig.visibleModelLabel ?? 'Auto', routingEnabled: true,
      routingPolicyModelId: options.routingPreflight.policyModelId, routingMetadata: options.routingPreflight.metadata,
      routingTargetMetadata: options.routingPreflight.targetMetadata, routingPromptPolicy: projectRoutingPromptPolicy(routingConfig) };
  }
  if (options.routingRecoveryOnly) {
    if (Object.hasOwn(desired.config, ROUTING_RECOVERY_ENTRY)) throw new Error('Routing recovery config conflicts with a model name.');
    desired.config[ROUTING_RECOVERY_ENTRY] = { routingRecoveryOnly: true };
  }
  return desired;
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
    routingAvailable?: boolean;
    routingRecoveryOnly?: boolean;
    routingConfig?: RoutingConfig;
    routingPreflight?: ReturnType<typeof import('./routing-policy-identity.js').routingPreflight>;
  } = {},
): Promise<void> {
  return runLaunchPatchCheckV2(opts);
}

export type { PatchDiagnosticsReport };
export { diagnosePatchV2, formatPatchDiagnosticsText };
