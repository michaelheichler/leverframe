/**
 * Validates public Copilot SDK model records and materializes registry metadata.
 * It never infers capabilities or limits that `listModels()` did not confirm.
 */

import type { CachedModel, ReasoningEffort } from '../registry/types.js';

type JsonRecord = Record<string, unknown>;

/** Distinguishes SDK schema drift from runtime transport failures. */
class CopilotModelValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'CopilotModelValidationError';
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

function requireBoolean(record: JsonRecord, field: string): boolean {
  const value = record[field];
  if (typeof value !== 'boolean') {
    throw new CopilotModelValidationError(`Copilot model ${field} must be a boolean`);
  }
  return value;
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
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new CopilotModelValidationError('Copilot model max_context_window_tokens must be a positive number');
  }
  return value;
}

function parseReasoningEffort(value: unknown, field: string): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !REASONING_EFFORTS.has(value as ReasoningEffort)) {
    throw new CopilotModelValidationError(`Copilot model ${field} contains an unsupported value`);
  }
  return value as ReasoningEffort;
}

function parseReasoningEfforts(value: unknown): ReasoningEffort[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new CopilotModelValidationError('Copilot model supportedReasoningEfforts must be an array');
  }
  return value.map((effort, index) => {
    const parsed = parseReasoningEffort(effort, `supportedReasoningEfforts[${index}]`);
    if (parsed === undefined) {
      throw new CopilotModelValidationError(`Copilot model supportedReasoningEfforts[${index}] is missing`);
    }
    return parsed;
  });
}

/** Converts one runtime-validated `ModelInfo` record into registry metadata. */
export function parseCopilotModelInfo(record: unknown): CachedModel {
  const model = requireRecord(record, 'record');
  const id = requireNonEmptyString(model, 'id');
  const name = requireNonEmptyString(model, 'name');
  policyAllowsModel(model.policy);
  const capabilities = requireRecord(model.capabilities, 'capabilities');
  const supports = requireRecord(capabilities.supports, 'capabilities.supports');
  const limits = requireRecord(capabilities.limits, 'capabilities.limits');
  const vision = requireBoolean(supports, 'vision');
  const reasoning = requireBoolean(supports, 'reasoningEffort');
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
    vision,
    reasoning,
    ...(contextWindow === undefined
      ? { contextWindowUnconfirmed: true }
      : { contextWindow }),
    ...(supportedReasoningEfforts === undefined ? {} : { supportedReasoningEfforts }),
    ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
  };
}

/** Validates and maps the complete `CopilotClient.listModels()` result. */
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

export type CopilotModelRefreshResult =
  | { models: CachedModel[]; source: 'live' }
  | { models: CachedModel[]; source: 'cache'; failureReason: string; failureKind: 'runtime' | 'schema' };

/** Discovers models while preserving a valid cache on runtime failure. */
export async function refreshCopilotModels(input: {
  listModels: () => Promise<unknown>;
  cachedModels: CachedModel[];
}): Promise<CopilotModelRefreshResult> {
  try {
    const models = mapCopilotModels(await input.listModels());
    if (models.length === 0) {
      throw new Error('Copilot model discovery returned no models');
    }
    return { models, source: 'live' };
  } catch (error) {
    if (input.cachedModels.length === 0) throw error;
    return {
      models: input.cachedModels,
      source: 'cache',
      failureReason: error instanceof Error ? error.message : String(error),
      failureKind: error instanceof CopilotModelValidationError ? 'schema' : 'runtime',
    };
  }
}
