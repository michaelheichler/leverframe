import { deriveBrand } from '../models.js';
import type { CachedModel } from './types.js';

export interface OpenAiModelEntry {
  id: string;
  name: string;
  context_window?: unknown;

  max_context_window?: unknown;
  inputTokenLimit?: unknown;
  outputTokenLimit?: unknown;
  minimalClientVersion?: string;
  supportedParameters?: string[];
  reasoning?: boolean;
  supportedReasoningEfforts?: string[];
  supportsTemperature?: boolean;
  supportsReasoningSummaries?: boolean;
  supportsReasoningSummaryParameter?: boolean;
  supportsParallelToolCalls?: boolean;
  supportsReasoningToggle?: boolean;
  defaultReasoningEffort?: string;
  useResponsesLite?: boolean;
  preferWebSockets?: boolean;
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

function readCapabilityFlags(m: Record<string, unknown>): Pick<OpenAiModelEntry, 'inputTokenLimit' | 'outputTokenLimit' | 'minimalClientVersion' | 'supportedParameters' | 'reasoning' | 'supportedReasoningEfforts' | 'supportsTemperature' | 'supportsReasoningSummaries' | 'supportsReasoningSummaryParameter' | 'supportsParallelToolCalls' | 'supportsReasoningToggle' | 'defaultReasoningEffort' | 'useResponsesLite' | 'preferWebSockets'> {
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
    minimalClientVersion: typeof m.minimal_client_version === 'string'
      ? m.minimal_client_version.trim() || undefined
      : undefined,
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
    useResponsesLite: bool(m['use_responses_lite']),
    preferWebSockets: bool(m['prefer_websockets']),
  };
}

function confirmedContextWindow(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function parseOpenAiModelEntries(body: unknown): OpenAiModelEntry[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as Record<string, unknown>;

  if (Array.isArray(b.models)) {
    return (b.models as Array<Record<string, unknown>>)
      .map(m => ({
        id: (m.slug as string) ?? '',
        name: (m.title as string) ?? (m.name as string) ?? (m.slug as string) ?? '',
        context_window: m.context_window,
        max_context_window: m.max_context_window,
        ...readCapabilityFlags(m),
      }))
      .filter(m => m.id.length > 0);
  }
  if (Array.isArray(b.data)) {
    return (b.data as Array<Record<string, unknown>>)
      .map(m => ({
        id: (m.id as string) ?? '',
        name: (m.name as string) ?? (m.id as string) ?? '',
        context_window: m.context_window,
        max_context_window: m.max_context_window,
        ...readCapabilityFlags(m),
      }))
      .filter(m => m.id.length > 0);
  }
  return [];
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
    minimalClientVersion: entry.minimalClientVersion,
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
    useResponsesLite: entry.useResponsesLite,
    preferWebSockets: entry.preferWebSockets,
  };
}
