/** Strict metadata is needed to prevent guessed routes. */
import type { CachedModel } from '../registry/types.js';
import { COPILOT_REASONING_EFFORT_SET, type CopilotReasoningEffort } from './reasoning-effort.js';

type JsonRecord = Record<string, unknown>;

/** Types differ because callers classify failures. */
export class CopilotModelValidationError extends TypeError {
  /** Names matter because diagnostics print the error type. */
  constructor(message: string) {
    super(message);
    this.name = 'CopilotModelValidationError';
  }
}

/** No arrays, because metadata must be keyed. */
function requireRecord(value: unknown, field: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CopilotModelValidationError(`Copilot model ${field} must be an object`);
  }
  return value as JsonRecord;
}

/** Empty strings fail to prevent unusable model metadata. */
function requireNonEmptyString(record: JsonRecord, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new CopilotModelValidationError(`Copilot model ${field} must be a non-empty string`);
  }
  return value;
}

/** No coercion, because false and absent differ. */
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

function optionalString(record: JsonRecord, field: string): string | undefined {
  return record[field] === undefined ? undefined : requireNonEmptyString(record, field);
}

function aliasedField(record: JsonRecord, field: string, alias: string): unknown {
  return record[field] === undefined ? record[alias] : record[field];
}

/** Unknown policy states fail to avoid access bypasses. */
function policyAllowsModel(value: unknown): boolean {
  if (value === undefined) return true;
  const policy = requireRecord(value, 'policy');
  const state = requireNonEmptyString(policy, 'state');
  if (state !== 'enabled' && state !== 'disabled' && state !== 'unconfigured') {
    throw new CopilotModelValidationError('Copilot model policy.state is unsupported');
  }
  return state === 'enabled';
}

/** Zero stays unknown to avoid guessed limits. */
function parseTokenLimit(limits: JsonRecord, field: string): number | undefined {
  const value = limits[field];
  if (value === undefined || value === 0) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new CopilotModelValidationError(`Copilot model ${field} must be zero or a positive number`);
  }
  return value;
}

function parseContextWindow(limits: JsonRecord): number | undefined {
  return parseTokenLimit(limits, 'max_context_window_tokens');
}

/** Unknown labels drop to avoid invalid requests. */
function parseReasoningEffort(value: unknown, field: string): CopilotReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new CopilotModelValidationError(`Copilot model ${field} must be a string`);
  }
  return COPILOT_REASONING_EFFORT_SET.has(value as CopilotReasoningEffort) ? value as CopilotReasoningEffort : undefined;
}

/** New labels must not hide otherwise valid models. */
function parseReasoningEfforts(value: unknown): CopilotReasoningEffort[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new CopilotModelValidationError('Copilot model supported_reasoning_efforts must be an array');
  }
  return value.flatMap((effort, index) => {
    const parsed = parseReasoningEffort(effort, `supported_reasoning_efforts[${index}]`);
    return parsed === undefined ? [] : [parsed];
  });
}

/** Names may be absent because catalogs mix tasks. */
export function isChatRecord(record: unknown): boolean {
  const model = requireRecord(record, 'record');
  requireNonEmptyString(model, 'id');
  const capabilities = requireRecord(model.capabilities, 'capabilities');
  const type = optionalString(capabilities, 'type');
  return type === undefined || type === 'chat';
}

/** Explicit paths are needed to prevent key leaks. */
function selectCopilotAdapter(model: JsonRecord, capabilities: JsonRecord): Pick<CachedModel, 'npm' | 'modelFormat'> {
  const type = optionalString(capabilities, 'type');
  if (type !== undefined && type !== 'chat') {
    throw new CopilotModelValidationError('Copilot model capabilities.type must be chat');
  }
  const endpoints = model.supported_endpoints;
  if (endpoints === undefined && type === 'chat') {
    return { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai' };
  }
  if (!Array.isArray(endpoints) || endpoints.some(endpoint => typeof endpoint !== 'string' || endpoint.length === 0)) {
    throw new CopilotModelValidationError('Copilot model supported_endpoints must be an array of non-empty strings');
  }
  if (endpoints.includes('/v1/messages')) {
    return { npm: '@ai-sdk/anthropic', modelFormat: 'anthropic' };
  }
  if (endpoints.includes('/responses')) {
    return { npm: '@ai-sdk/openai', modelFormat: 'openai' };
  }
  if (endpoints.includes('/chat/completions')) {
    return { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai' };
  }
  throw new CopilotModelValidationError('Copilot model supported_endpoints has no supported inference endpoint');
}

/** Missing flags stay unknown to avoid capability guesses. */
export function parseCopilotModelInfo(record: unknown): CachedModel {
  const model = requireRecord(record, 'record');
  const id = requireNonEmptyString(model, 'id');
  const name = requireNonEmptyString(model, 'name');
  policyAllowsModel(model.policy);
  const capabilities = requireRecord(model.capabilities, 'capabilities');
  const supports = optionalRecord(capabilities.supports, 'capabilities.supports');
  const limits = optionalRecord(capabilities.limits, 'capabilities.limits');
  const family = optionalString(capabilities, 'family');
  const vision = optionalBoolean(supports, 'vision');
  const reasoningEffort = optionalBoolean(supports, 'reasoning_effort') ?? optionalBoolean(supports, 'reasoningEffort');
  const reasoning = reasoningEffort ?? optionalBoolean(supports, 'reasoning');
  const supportsParallelToolCalls = optionalBoolean(supports, 'parallel_tool_calls');
  const contextWindow = parseContextWindow(limits);
  const inputTokenLimit = parseTokenLimit(limits, 'max_prompt_tokens');
  const outputTokenLimit = parseTokenLimit(limits, 'max_output_tokens');
  const supportedReasoningEfforts = parseReasoningEfforts(aliasedField(model, 'supported_reasoning_efforts', 'supportedReasoningEfforts'));
  const defaultReasoningEffort = parseReasoningEffort(
    aliasedField(model, 'default_reasoning_effort', 'defaultReasoningEffort'),
    'default_reasoning_effort',
  );
  const adapter = selectCopilotAdapter(model, capabilities);
  const supportedParameters = adapter.npm === '@ai-sdk/openai-compatible' && reasoningEffort === true ? ['reasoning_effort'] : undefined;
  return {
    id, name, upstreamModelId: id,
    ...adapter,
    ...(supportedParameters === undefined ? {} : { supportedParameters }),
    apiUrl: 'https://api.githubcopilot.com',
    ...(family === undefined ? {} : { family }),
    ...(vision === undefined ? {} : { vision }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(supportsParallelToolCalls === undefined ? {} : { supportsParallelToolCalls }),
    ...(contextWindow === undefined ? { contextWindowUnconfirmed: true } : { contextWindow }),
    ...(inputTokenLimit === undefined ? {} : { inputTokenLimit }),
    ...(outputTokenLimit === undefined ? {} : { outputTokenLimit }),
    ...(supportedReasoningEfforts === undefined ? {} : { supportedReasoningEfforts }),
    ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
  };
}

/** Invalid records fail to prevent partial catalogs. */
export function mapCopilotModels(records: unknown): CachedModel[] {
  if (!Array.isArray(records)) {
    throw new CopilotModelValidationError('Copilot model discovery must return an array');
  }
  return records.flatMap(record => {
    if (!isChatRecord(record)) return [];
    const model = parseCopilotModelInfo(record);
    const policy = requireRecord(record, 'record').policy;
    return policyAllowsModel(policy) ? [model] : [];
  });
}
