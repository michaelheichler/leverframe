/**
 * Validates public Copilot SDK model records and materializes registry metadata.
 * It never infers capabilities or limits that `listModels()` did not confirm.
 */

import type {
  CachedModel,
  ModelDiscoveryFailureKind,
  ReasoningEffort,
} from '../registry/types.js';

type JsonRecord = Record<string, unknown>;

export type CopilotModelFailureKind = ModelDiscoveryFailureKind;

/** Distinguishes SDK schema drift from runtime transport failures. */
class CopilotModelValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'CopilotModelValidationError';
  }
}

class CopilotModelDiscoveryError extends Error {
  readonly kind: CopilotModelFailureKind;

  constructor(kind: CopilotModelFailureKind, message: string) {
    super(message);
    this.name = 'CopilotModelDiscoveryError';
    this.kind = kind;
  }
}

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function requireRecord(value: unknown, field: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CopilotModelValidationError(`Copilot model ${field} must be an object`);
  }
  return value as JsonRecord;
}

function requireNonEmptyString(record: JsonRecord, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new CopilotModelValidationError(`Copilot model ${field} must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(record: JsonRecord, field: string): boolean | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new CopilotModelValidationError(`Copilot model ${field} must be a boolean`);
  }
  return value;
}

function optionalRecord(value: unknown, field: string): JsonRecord {
  return value === undefined ? {} : requireRecord(value, field);
}

/** Validates SDK policy and excludes models unavailable to the authenticated account. */
function policyAllowsModel(value: unknown): boolean {
  if (value === undefined) return true;
  const policy = requireRecord(value, 'policy');
  const state = requireNonEmptyString(policy, 'state');
  if (state !== 'enabled' && state !== 'disabled' && state !== 'unconfigured') {
    throw new CopilotModelValidationError('Copilot model policy.state is unsupported');
  }
  return state === 'enabled';
}

function parseContextWindow(limits: JsonRecord): number | undefined {
  const value = limits.max_context_window_tokens;
  if (value === undefined || value === 0) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new CopilotModelValidationError('Copilot model max_context_window_tokens must be zero or a positive number');
  }
  return value;
}

function parseReasoningEffort(value: unknown, field: string): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new CopilotModelValidationError(`Copilot model ${field} must be a string`);
  }
  return REASONING_EFFORTS.has(value as ReasoningEffort) ? value as ReasoningEffort : undefined;
}

function parseReasoningEfforts(value: unknown): ReasoningEffort[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new CopilotModelValidationError('Copilot model supportedReasoningEfforts must be an array');
  }
  return value.flatMap((effort, index) => {
    const parsed = parseReasoningEffort(effort, `supportedReasoningEfforts[${index}]`);
    return parsed === undefined ? [] : [parsed];
  });
}

/** Converts one runtime-validated `ModelInfo` record into registry metadata. */
export function parseCopilotModelInfo(record: unknown): CachedModel {
  const model = requireRecord(record, 'record');
  const id = requireNonEmptyString(model, 'id');
  const name = requireNonEmptyString(model, 'name');
  policyAllowsModel(model.policy);
  const capabilities = requireRecord(model.capabilities, 'capabilities');
  const supports = optionalRecord(capabilities.supports, 'capabilities.supports');
  const limits = optionalRecord(capabilities.limits, 'capabilities.limits');
  const vision = optionalBoolean(supports, 'vision');
  const reasoning = optionalBoolean(supports, 'reasoningEffort');
  const contextWindow = parseContextWindow(limits);
  const supportedReasoningEfforts = parseReasoningEfforts(model.supportedReasoningEfforts);
  const defaultReasoningEffort = parseReasoningEffort(
    model.defaultReasoningEffort,
    'defaultReasoningEffort',
  );

  return {
    id,
    name,
    upstreamModelId: id,
    modelFormat: 'openai' as const,
    ...(vision === undefined ? {} : { vision }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(contextWindow === undefined
      ? { contextWindowUnconfirmed: true }
      : { contextWindow }),
    ...(supportedReasoningEfforts === undefined ? {} : { supportedReasoningEfforts }),
    ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
  };
}

/** Validates and maps the complete `CopilotClient.listModels()` result. */
export function mapCopilotModels(records: unknown): CachedModel[] {
  if (!Array.isArray(records)) {
    throw new CopilotModelValidationError('CopilotClient.listModels() must return an array');
  }
  return records.flatMap(record => {
    const model = parseCopilotModelInfo(record);
    const policy = requireRecord(record, 'record').policy;
    return policyAllowsModel(policy) ? [model] : [];
  });
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

export function classifyCopilotModelFailure(error: unknown): CopilotModelFailureKind {
  const chain = errorChain(error);
  const discovery = chain.find(entry => entry instanceof CopilotModelDiscoveryError);
  if (discovery instanceof CopilotModelDiscoveryError) return discovery.kind;
  if (chain.some(entry => entry instanceof CopilotModelValidationError)) return 'schema';
  const errors = chain.map(entry => ({
    name: entry instanceof Error ? entry.name : '',
    message: entry instanceof Error ? entry.message : String(entry),
  }));
  if (errors.some(({ name, message }) => (
    name === 'CopilotSdkNotInstalledError'
    || name === 'CopilotSdkIncompatibleError'
    || /Copilot CLI not found|Copilot support is not installed|Copilot platform package/i.test(message)
  ))) return 'sdk';
  if (errors.some(({ message }) => /\b401\b|\b403\b|unauthori[sz]ed|forbidden|authentication|access token|subscription|entitlement|eligible/i.test(message))) {
    return 'authentication';
  }
  return 'runtime';
}

export type CopilotModelRefreshResult =
  | { models: CachedModel[]; source: 'live' }
  | { models: CachedModel[]; source: 'cache'; failureReason: string; failureKind: CopilotModelFailureKind };

/** Discovers models while preserving a valid cache on runtime failure. */
export async function refreshCopilotModels(input: {
  listModels: () => Promise<unknown>;
  cachedModels: CachedModel[];
}): Promise<CopilotModelRefreshResult> {
  try {
    const records = await input.listModels();
    const recordCount = Array.isArray(records) ? records.length : 0;
    const models = mapCopilotModels(records);
    if (models.length === 0) {
      if (recordCount > 0) {
        throw new CopilotModelDiscoveryError(
          'policy',
          'Copilot model discovery returned no policy-enabled models',
        );
      }
      throw new CopilotModelDiscoveryError(
        'empty',
        'Copilot model discovery returned no models',
      );
    }
    return { models, source: 'live' };
  } catch (error) {
    if (input.cachedModels.length === 0) throw error;
    return {
      models: input.cachedModels,
      source: 'cache',
      failureReason: error instanceof Error ? error.message : String(error),
      failureKind: classifyCopilotModelFailure(error),
    };
  }
}
