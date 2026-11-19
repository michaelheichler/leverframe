import { deriveBrand } from '../models.js';
import type { CachedModel } from './types.js';

export interface OpenAiModelEntry {
  id: string;
  name: string;
  context_window?: unknown;

  max_context_window?: unknown;
  inputTokenLimit?: unknown;
  outputTokenLimit?: unknown;
  supportedParameters?: string[];
  reasoning?: boolean;
  supportedReasoningEfforts?: string[];
  supportsTemperature?: boolean;
  supportsReasoningSummaries?: boolean;
  supportsReasoningSummaryParameter?: boolean;
  supportsParallelToolCalls?: boolean;
  supportsReasoningToggle?: boolean;
  defaultReasoningEffort?: string;
}

function readReasoningEfforts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const efforts = value.flatMap(option => {
    if (typeof option === 'string') return [option];
    if (!option || typeof option !== 'object' || Array.isArray(option)) return [];
    const record = option as Record<string, unknown>;
    if (typeof record.effort === 'string') return [record.effort];
    if (record.type === 'effort' && Array.isArray(record.values)) {
      return record.values.filter((effort): effort is string => typeof effort === 'string');
    }
    return [];
  }).map(effort => effort.trim()).filter(effort => effort.length > 0);
  return [...new Set(efforts)];
}

function readReasoningToggle(value: unknown): boolean | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.some(option => (
    option !== null
    && typeof option === 'object'
    && !Array.isArray(option)
    && (option as Record<string, unknown>).type === 'toggle'
  ));
}

function readCapabilityFlags(m: Record<string, unknown>): Omit<OpenAiModelEntry, 'id' | 'name' | 'context_window' | 'max_context_window'> {
  const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
  const limit = m.limit;
  const limitRecord = limit !== null && typeof limit === 'object' && !Array.isArray(limit)
    ? limit as Record<string, unknown>
    : undefined;
  const supportedReasoningEfforts = readReasoningEfforts(
    m.supported_reasoning_levels ?? m.reasoning_options,
  );
  const reportedReasoning = bool(m.reasoning);
  const supportedParameters = Array.isArray(m.supported_parameters)
    ? m.supported_parameters.filter((value): value is string => typeof value === 'string')
    : undefined;
  return {
    inputTokenLimit: limitRecord?.input ?? m.inputTokenLimit,
    outputTokenLimit: limitRecord?.output ?? m.outputTokenLimit,
    supportedParameters,
    reasoning: reportedReasoning ?? (
      supportedReasoningEfforts === undefined ? undefined : supportedReasoningEfforts.length > 0
    ),
    supportedReasoningEfforts,
    supportsTemperature: bool(m.temperature),
    supportsReasoningSummaries: bool(m.supports_reasoning_summaries),
    supportsReasoningSummaryParameter: bool(m.supports_reasoning_summary_parameter),
    supportsParallelToolCalls: bool(m.supports_parallel_tool_calls),
    supportsReasoningToggle: readReasoningToggle(m.reasoning_options),
    defaultReasoningEffort: typeof m.default_reasoning_level === 'string'
      ? m.default_reasoning_level.trim() || undefined
      : undefined,
  };
}

function confirmedContextWindow(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function parseOpenAiModelEntries(entries: Array<Record<string, unknown>>): OpenAiModelEntry[] {
  return entries.flatMap(model => {
    const { slug, display_name, context_window, max_context_window } = model;
    if (typeof slug !== 'string' || !slug.trim()) return [];
    return [{
      id: slug,
      name: typeof display_name === 'string' && display_name.trim() ? display_name : slug,
      context_window,
      max_context_window,
      ...readCapabilityFlags(model),
    }];
  });
}

export function buildDynamicOAuthModel(entry: OpenAiModelEntry): CachedModel {
  const contextWindow = confirmedContextWindow(entry.context_window);
  const maxContextWindow = confirmedContextWindow(entry.max_context_window);
  const { id } = entry;
  const prefix = id.split('-')[0] ?? id;
  return {
    id,
    name: entry.name,
    upstreamModelId: id,
    family: prefix,
    brand: deriveBrand(prefix),
    contextWindow,
    maxContextWindow,
    inputTokenLimit: confirmedContextWindow(entry.inputTokenLimit),
    outputTokenLimit: confirmedContextWindow(entry.outputTokenLimit),
    contextWindowUnconfirmed: contextWindow === undefined ? true : undefined,
    modelFormat: 'openai' as const,
    npm: '@ai-sdk/openai',
    supportedParameters: entry.supportedParameters,
    reasoning: entry.reasoning,
    supportedReasoningEfforts: entry.supportedReasoningEfforts,
    defaultReasoningEffort: entry.defaultReasoningEffort,
    supportsTemperature: entry.supportsTemperature,
    supportsReasoningSummaries: entry.supportsReasoningSummaries,
    supportsReasoningSummaryParameter: entry.supportsReasoningSummaryParameter,
    supportsParallelToolCalls: entry.supportsParallelToolCalls,
    supportsReasoningToggle: entry.supportsReasoningToggle,
  };
}
