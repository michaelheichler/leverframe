// src/registry/types.ts — native provider registry schema (no secrets)

import type { FreeStatus } from '../free-models.js';

export const REGISTRY_SCHEMA_VERSION = 1;

export type RegistrySubscriptionFilter = 'free';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
  isFree?: boolean;
  freeStatus?: FreeStatus;
  modelFormat: 'anthropic' | 'openai' | 'cloud-code';
  /** Per-model override — wins over provider-level api.npm */
  npm?: string;
  /** Per-model override — wins over provider-level api.url */
  apiUrl?: string;
  sourceBackend?: string;
  /** Provider-reported request parameters, e.g. OpenRouter supported_parameters. */
  supportedParameters?: string[];
  /** Broad model metadata: model can produce reasoning/thinking output. */
  reasoning?: boolean;
  /** Provider-confirmed support for image input. */
  vision?: boolean;
  /** Provider-confirmed reasoning effort values. */
  supportedReasoningEfforts?: ReasoningEffort[];
  /** Provider-confirmed default reasoning effort. */
  defaultReasoningEffort?: ReasoningEffort;
  /** Streaming/interleaved reasoning field name from metadata, e.g. reasoning_content. */
  interleavedReasoningField?: string;
  /** Backend capability: model requires the Responses-Lite request shape (x-openai-internal-codex-responses-lite). */
  useResponsesLite?: boolean;
  /** Backend capability: model must use the WebSocket Responses transport instead of HTTP. */
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
    /** Static headers sent on every upstream request (e.g. a plan/auth-tracking header a custom endpoint requires). */
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
