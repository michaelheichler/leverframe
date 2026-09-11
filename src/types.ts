

import type { FreeStatus } from './free-models.js';

export type ModelFormat = 'anthropic' | 'openai' | 'unsupported';

export type StarterCommand = 'root' | 'claude' | 'server' | 'models' | 'providers' | 'patch' | 'executions' | 'keyring';

export interface ModelCost {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

export interface LocalProviderModel {
  id: string;
  name: string;
  family: string;
  brand: string;
  modelFormat: 'anthropic' | 'openai';

  upstreamModelId: string;
  baseUrl?: string;        // set for anthropic-format models
  completionsUrl?: string; // set for openai-format models
  npm?: string;            // OpenCode api.npm package, e.g. @ai-sdk/xai (SDK routing)
  apiBaseUrl?: string;     // raw api.url, for openai-compatible/openrouter SDK base URL
  cost?: ModelCost;

  usageMultiplier?: number;
  usageMultiplierApplies?: boolean;
  deprecated?: boolean;
  contextWindow?: number;
  maxContextWindow?: number;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  minimalClientVersion?: string;
  contextWindowUnconfirmed?: boolean;

  supportedParameters?: string[];

  reasoning?: boolean;
  supportsTemperature?: boolean;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  supportsReasoningSummaries?: boolean;
  supportsReasoningSummaryParameter?: boolean;
  supportsParallelToolCalls?: boolean;

  supportsReasoningToggle?: boolean;

  supportsPromptCacheBreakpoints?: boolean;

  interleavedReasoningField?: string;

  useResponsesLite?: boolean;

  preferWebSockets?: boolean;

  isFree?: boolean;
  freeStatus?: FreeStatus;
  modalities?: ('text' | 'image')[];
}

export interface LocalProvider {
  id: string;
  name: string;
  apiKey: string;
  authType?: 'api' | 'oauth' | 'none';
  oauthAccountId?: string;
  providerData?: Record<string, unknown>;

  headers?: Record<string, string>;
  models: LocalProviderModel[];
}

export interface FavoriteModel {
  providerId: string;
  modelId: string;
}

export interface ModelAlias extends FavoriteModel {
  name: string;
}

export type BridgeMode = 'endpoint' | 'proxy';

export interface UserPreferences {
  lastModel?: string;
  lastProvider?: string;
  recentModelsByProvider?: Record<string, string[]>;
  favoriteModels?: FavoriteModel[];
  modelAliases?: ModelAlias[];

  claudeBridgeMode?: BridgeMode;

  serverBridgeMode?: BridgeMode;

  appPathOverrides?: Record<string, string>;
  recentLaunchFolders?: string[];

  contextCeilingOverrides?: string[];

  launch?: {

    bypassPermissions?: boolean;
  };
  server?: {
    savedPassword?: string;

    exposedProviders?: string[];

    maskGatewayIds?: boolean;

    favoritesOnly?: boolean;

    listenMode?: 'local' | 'network';
  };
}

export interface ParsedArgs {
  command: StarterCommand;
  showHelp: boolean;
  showVersion: boolean;
  dryRun: boolean;
  trace: boolean;
  claudeArgs: string[];

  launchProvider?: string;

  launchModel?: string;

  bridgeMode?: BridgeMode;

  saveBridgeMode?: boolean;

  serverQuick?: boolean;

  serverListenMode?: 'local' | 'network';

  serverProvidersMode?: 'all' | 'favorites' | 'specific';

  serverProviderIds?: string[];

  serverMaskGatewayIds?: boolean;

  serverPassword?: string;

  serverPort?: number;

  serverWsDiagnostics?: boolean;

  serverNoDiscovery?: boolean;

  serverPrepareClaude?: boolean;

  favoritesList?: boolean;

  favoritesAlias?: string;

  favoritesUnalias?: string;

  favoritesContextCeiling?: string;

  favoritesNoContextCeiling?: string;

  patchRestore?: boolean;

  patchDiagnose?: boolean;

  patchJson?: boolean;

  patchTarget?: string;

  keyringRepairAccount?: string;
  error?: string;
}

export interface ConflictInfo {
  name: string;
  value: string;
}
