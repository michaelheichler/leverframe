

import type { FreeStatus } from '../free-models.js';

export const REGISTRY_SCHEMA_VERSION = 1;

export type RegistrySubscriptionFilter = 'free';

export interface BillingMetadata {
  kind: 'metered' | 'subscription' | 'none' | 'unknown';
  source: string;
  observedAt: string;
}

export interface ModelPricingMetadata {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrites?: CacheWriteRate[];
  tiers?: ModelPricingTier[];
  invalidTiers?: boolean;
  source: string;
  observedAt?: string;
}

export interface CacheWriteRate {
  ttlSeconds: number;
  rate: number;
}

export interface ModelPricingTier {
  condition?: { type: 'context'; size: number };
  label?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrites?: CacheWriteRate[];
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ModelDiscoveryFailureKind =
  | 'authentication'
  | 'empty'
  | 'policy'
  | 'runtime'
  | 'schema'
  | 'sdk';

export interface ModelDiscoverySkipDiagnostic {
  index: number;
  modelId?: string;
  kind: 'schema' | 'transport-unknown' | 'policy' | 'non-chat';
  reason: string;
}

export interface CachedModel {
  subscriptionQuota?: { remainingFraction?: number; resetTime?: string };
  id: string;
  name: string;
  upstreamModelId: string;
  family?: string;
  brand?: string;
  contextWindow?: number;
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number };
  pricing?: ModelPricingMetadata;
  usageMultiplier?: number;
  usageMultiplierApplies?: boolean;
  peakCostMultiplier?: number;
  deprecated?: boolean;
  contextWindowUnconfirmed?: boolean;

  maxContextWindow?: number;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  minimalClientVersion?: string;
  isFree?: boolean;
  freeStatus?: FreeStatus;
  modelFormat: 'anthropic' | 'openai' | 'cloud-code';

  npm?: string;

  apiUrl?: string;
  sourceBackend?: string;

  supportedParameters?: string[];

  reasoning?: boolean;

  supportsTemperature?: boolean;

  vision?: boolean;

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
}

export interface RegistryAccount {
  id: string;
  authRef: string;
  enabled: boolean;
  billing?: BillingMetadata;
  name?: string;
  tag?: string;
  modelsCache?: RegistryProvider['modelsCache'];
  modelDiscoveryError?: string;
  modelDiscoveryGeneration?: string;
}

export interface RegistryProvider {
  id: string;
  templateId: string;
  name: string;
  enabled: boolean;
  authRef: string;
  accounts?: RegistryAccount[];
  pinnedAccountId?: string;
  authType?: 'api' | 'oauth' | 'none';
  credentialSource?: 'claude-code';
  billing?: BillingMetadata;
  subscriptionFilter?: RegistrySubscriptionFilter;
  api: {
    npm?: string;
    url?: string;
    id?: string;

    headers?: Record<string, string>;
  };
  modelsCache?: {
    source?: 'harness' | 'account';
    oauthAccountId?: string;
    fetchedAt: string;
    models: CachedModel[];
  };
  modelDiscoveryError?: {
    failedAt: string;
    kind: ModelDiscoveryFailureKind;
    reason: string;
  };
  modelDiscoveryWarnings?: {
    checkedAt: string;
    skippedModels: ModelDiscoverySkipDiagnostic[];
  };
  addedAt: string;
  refreshedAt?: string;
}

export interface ProviderRegistry {
  schemaVersion: number;
  providers: RegistryProvider[];
  importedAt?: string;
  pricingCacheAt?: string;
}
