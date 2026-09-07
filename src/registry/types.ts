

import type { FreeStatus } from '../free-models.js';

export const REGISTRY_SCHEMA_VERSION = 1;

export type RegistrySubscriptionFilter = 'free';

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ModelDiscoveryFailureKind =
  | 'authentication'
  | 'empty'
  | 'policy'
  | 'runtime'
  | 'schema'
  | 'sdk';

export interface CachedModel {
  id: string;
  name: string;
  upstreamModelId: string;
  family?: string;
  brand?: string;
  contextWindow?: number;
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number };
  usageMultiplier?: number;
  usageMultiplierApplies?: boolean;
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

export interface RegistryProvider {
  id: string;
  templateId: string;
  name: string;
  enabled: boolean;
  authRef: string;
  authType?: 'api' | 'oauth' | 'none';
  subscriptionFilter?: RegistrySubscriptionFilter;
  api: {
    npm?: string;
    url?: string;
    id?: string;

    headers?: Record<string, string>;
  };
  modelsCache?: {
    fetchedAt: string;
    models: CachedModel[];
  };
  modelDiscoveryError?: {
    failedAt: string;
    kind: ModelDiscoveryFailureKind;
    reason: string;
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
