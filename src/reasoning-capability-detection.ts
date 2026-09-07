
import { VERTEX_ANTHROPIC_NPM } from './constants.js';

export type ReasoningMode = 'none' | 'internal-only' | 'controllable';
export type ReasoningSource = 'provider-metadata' | 'provider-rule' | 'model-metadata' | 'none';
export type ReasoningConfidence = 'verified' | 'documented' | 'inferred';
export type ReasoningWireFormat =
  | { kind: 'openrouter-reasoning' }
  | { kind: 'openai-reasoning-effort' }
  | { kind: 'anthropic-thinking' }
  | { kind: 'google-thinking-config' }
  | { kind: 'mistral-reasoning-effort' }
  | { kind: 'deepseek-thinking' };

export interface ReasoningMetadata {
  providerId?: string;
  apiBaseUrl?: string;
  supportedParameters?: string[];
  reasoning?: boolean;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  supportsTemperature?: boolean;
  supportsReasoningSummaries?: boolean;
  supportsReasoningSummaryParameter?: boolean;
  supportsParallelToolCalls?: boolean;
  supportsReasoningToggle?: boolean;
  supportsPromptCacheBreakpoints?: boolean;
  useResponsesLite?: boolean;
  interleavedReasoningField?: string;

  upstreamModelId?: string;
}

export interface ReasoningCapabilities {
  levels: string[];
  defaultLevel: string;
  supportsSummaries: boolean;
  mode: ReasoningMode;
  source: ReasoningSource;
  confidence: ReasoningConfidence;
  wireFormat?: ReasoningWireFormat;
}

const ANTHROPIC_EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

const EMPTY_REASONING: ReasoningCapabilities = {
  levels: [],
  defaultLevel: '',
  supportsSummaries: false,
  mode: 'none',
  source: 'none',
  confidence: 'inferred',
};

const EFFORT_DESCRIPTIONS: Record<string, string> = {
  off: 'Turn off extended reasoning',
  none: 'No reasoning',
  minimal: 'Minimal reasoning',
  low: 'Light reasoning',
  medium: 'Balanced reasoning',
  high: 'Deep reasoning',
  xhigh: 'Maximum reasoning',
  max: 'Maximum effort',
};

function isClaudeReasoningModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (!lower.startsWith('claude-')) return false;
  if (lower.includes('fable') || lower.includes('mythos')) return true;
  const m = lower.match(/claude-(?:opus|sonnet|haiku)-(\d+)-(\d+)/);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 4 || (major === 4 && minor >= 6);
}

function toCamelCase(str: string): string {
  return str.replace(/[-_]([a-z])/g, (_, g) => g.toUpperCase());
}

function hasSupportedParameter(metadata: ReasoningMetadata | undefined, param: string): boolean {
  return (metadata?.supportedParameters ?? []).some(p => p === param);
}

function reportedReasoningLevels(metadata: ReasoningMetadata | undefined): string[] | undefined {
  if (!metadata?.supportedReasoningEfforts) return undefined;
  const levels = metadata.supportedReasoningEfforts
    .filter((level): level is string => typeof level === 'string' && level.trim().length > 0);
  return levels.length > 0 ? [...new Set(levels)] : [];
}

function defaultReportedReasoningLevel(
  levels: string[],
  requestedDefault?: string,
): string {
  if (requestedDefault && levels.includes(requestedDefault)) return requestedDefault;
  return '';
}

function hasExplicitReasoningMetadata(metadata: ReasoningMetadata | undefined): boolean {
  return metadata?.reasoning !== undefined || metadata?.supportedReasoningEfforts !== undefined;
}

function isOpenRouterRoute(npm: string, metadata?: ReasoningMetadata): boolean {
  return npm === '@openrouter/ai-sdk-provider'
    || metadata?.providerId === 'openrouter'
    || metadata?.apiBaseUrl?.includes('openrouter.ai') === true;
}

function openRouterReasoningCapabilities(metadata?: ReasoningMetadata): ReasoningCapabilities {
  if (metadata?.reasoning === false) return EMPTY_REASONING;
  const levels = reportedReasoningLevels(metadata);
  if (levels !== undefined) {
    return {
      levels,
      defaultLevel: defaultReportedReasoningLevel(levels, metadata?.defaultReasoningEffort),
      supportsSummaries: metadata?.supportsReasoningSummaries === true,
      mode: levels.length > 0 ? 'controllable' : 'internal-only',
      source: 'provider-metadata',
      confidence: 'documented',
      wireFormat: { kind: 'openrouter-reasoning' },
    };
  }
  if (metadata?.reasoning === true || hasSupportedParameter(metadata, 'reasoning')) {
    return {
      ...EMPTY_REASONING,
      mode: 'internal-only',
      source: metadata?.reasoning === true ? 'model-metadata' : 'provider-metadata',
      confidence: 'documented',
      wireFormat: { kind: 'openrouter-reasoning' },
    };
  }
  return EMPTY_REASONING;
}

function metadataReasoningCapabilities(
  metadata: ReasoningMetadata | undefined,
  wireFormat: ReasoningWireFormat,
  source: 'provider-metadata' | 'model-metadata' = 'model-metadata',
): ReasoningCapabilities {
  if (metadata?.reasoning === false) return EMPTY_REASONING;
  const levels = reportedReasoningLevels(metadata);
  if (levels !== undefined) {
    return {
      levels,
      defaultLevel: defaultReportedReasoningLevel(levels, metadata?.defaultReasoningEffort),
      supportsSummaries: metadata?.supportsReasoningSummaries === true,
      mode: levels.length > 0 ? 'controllable' : 'internal-only',
      source,
      confidence: 'documented',
      wireFormat,
    };
  }
  if (metadata?.reasoning === true) {
    return {
      ...EMPTY_REASONING,
      mode: 'internal-only',
      source,
      confidence: 'documented',
      wireFormat,
    };
  }
  return EMPTY_REASONING;
}

function reportedEffort(metadata: ReasoningMetadata | undefined, effort: string): string | undefined {
  const levels = reportedReasoningLevels(metadata);
  return levels?.includes(effort) ? effort : undefined;
}

function openAiCompatibleReasoningWireFormat(
  metadata: ReasoningMetadata | undefined,
): ReasoningWireFormat | undefined {
  if (metadata?.supportsReasoningToggle === true) return { kind: 'deepseek-thinking' };
  if (hasSupportedParameter(metadata, 'reasoning_effort')) return { kind: 'openai-reasoning-effort' };
  if (hasSupportedParameter(metadata, 'reasoning')) return { kind: 'openrouter-reasoning' };
  return undefined;
}

function mapCodexEffortToAnthropic(effort: string): string | undefined {
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
    case 'max':
      return effort === 'xhigh' ? 'high' : effort === 'max' ? 'max' : 'high';
    default:
      if (ANTHROPIC_EFFORT_LEVELS.includes(effort as typeof ANTHROPIC_EFFORT_LEVELS[number])) {
        return effort;
      }
      return undefined;
  }
}

export function getReasoningCapabilities(
  npm: string,
  modelId: string,
  metadata?: ReasoningMetadata,
): ReasoningCapabilities {
  if (isOpenRouterRoute(npm, metadata)) {
    return openRouterReasoningCapabilities(metadata);
  }

  if (npm === '@ai-sdk/anthropic' || npm === VERTEX_ANTHROPIC_NPM) {
    const isClaude = isClaudeReasoningModel(modelId);
    if (isClaude || metadata?.reasoning) {
      return {
        levels: [...ANTHROPIC_EFFORT_LEVELS],
        defaultLevel: 'high',
        supportsSummaries: true,
        mode: 'controllable',
        source: isClaude ? 'provider-rule' : 'model-metadata',
        confidence: isClaude ? 'documented' : 'inferred',
        wireFormat: { kind: 'anthropic-thinking' },
      };
    }
    return EMPTY_REASONING;
  }

  if (npm === '@ai-sdk/openai' || npm === '@ai-sdk/azure') {
    if (metadata?.reasoning === false) return EMPTY_REASONING;
    const reportedLevels = reportedReasoningLevels(metadata);
    if (reportedLevels !== undefined) {
      return {
        levels: reportedLevels,
        defaultLevel: defaultReportedReasoningLevel(reportedLevels, metadata?.defaultReasoningEffort),
        supportsSummaries: metadata?.supportsReasoningSummaries === true,
        mode: reportedLevels.length > 0 ? 'controllable' : 'internal-only',
        source: 'model-metadata',
        confidence: 'documented',
        wireFormat: { kind: 'openai-reasoning-effort' },
      };
    }
    if (metadata?.reasoning === true) {
      return {
        ...EMPTY_REASONING,
        mode: 'internal-only',
        source: 'model-metadata',
        confidence: 'documented',
        wireFormat: { kind: 'openai-reasoning-effort' },
      };
    }
    return EMPTY_REASONING;
  }

  if (npm === '@ai-sdk/google') {
    return metadataReasoningCapabilities(metadata, { kind: 'google-thinking-config' });
  }

  if (npm === '@ai-sdk/mistral') {
    return metadataReasoningCapabilities(metadata, { kind: 'mistral-reasoning-effort' });
  }

  if (npm === '@ai-sdk/xai') {
    return metadataReasoningCapabilities(metadata, { kind: 'openai-reasoning-effort' });
  }

  if (npm === '@ai-sdk/openai-compatible') {
    const wireFormat = openAiCompatibleReasoningWireFormat(metadata);
    if (wireFormat) return metadataReasoningCapabilities(metadata, wireFormat);
    if (metadata?.reasoning === true) {
      return {
        ...EMPTY_REASONING,
        mode: 'internal-only',
        source: 'model-metadata',
        confidence: 'documented',
      };
    }
    return EMPTY_REASONING;
  }

  if (metadata?.reasoning === true) {
    return {
      ...EMPTY_REASONING,
      mode: 'internal-only',
      source: 'model-metadata',
      confidence: 'documented',
    };
  }
  return EMPTY_REASONING;
}

export function buildCodexReasoningLevels(
  capabilities: Pick<ReasoningCapabilities, 'levels'>,
): Array<{ effort: string; description: string }> {
  return capabilities.levels.map(effort => ({
    effort,
    description: EFFORT_DESCRIPTIONS[effort] ?? effort,
  }));
}

export function effortProviderOptions(
  npm: string,
  effort?: string,
  modelId?: string,
  metadata?: ReasoningMetadata,
): Record<string, Record<string, unknown>> | undefined {
  if (!effort) return undefined;

  if (isOpenRouterRoute(npm, metadata)) {
    return reportedEffort(metadata, effort)
      ? { openrouter: { reasoning: { effort, exclude: false } } }
      : undefined;
  }

  if (npm === '@ai-sdk/openai' || npm === '@ai-sdk/azure') {
    if (metadata?.reasoning === false) return undefined;
    const reportedLevels = reportedReasoningLevels(metadata);
    if (reportedLevels === undefined || !reportedLevels.includes(effort)) return undefined;
    return {
      openai: {
        reasoningEffort: effort,
        forceReasoning: true,
        systemMessageMode: 'developer',
      },
    };
  }

  if (npm === '@ai-sdk/xai') {
    return reportedEffort(metadata, effort)
      ? { xai: { reasoningEffort: effort } }
      : undefined;
  }

  if (npm === '@ai-sdk/anthropic' || npm === VERTEX_ANTHROPIC_NPM) {
    if (!modelId || !isClaudeReasoningModel(modelId)) return undefined;
    const mapped = mapCodexEffortToAnthropic(effort);
    return mapped
      ? { anthropic: { thinking: { type: 'adaptive', effort: mapped } } }
      : undefined;
  }

  if (npm === '@ai-sdk/google') {
    return reportedEffort(metadata, effort)
      ? { google: { thinkingConfig: { thinkingLevel: effort, includeThoughts: true } } }
      : undefined;
  }

  if (npm === '@ai-sdk/mistral') {
    return reportedEffort(metadata, effort)
      ? { mistral: { reasoningEffort: effort } }
      : undefined;
  }

  if (npm === '@ai-sdk/openai-compatible' || npm === '@ai-sdk/openai') {
    if (!reportedEffort(metadata, effort)) return undefined;
    if (metadata?.supportsReasoningToggle === true) {
      const thinking = { type: effort === 'none' || effort === 'off' ? 'disabled' : 'enabled' };
      return {
        openaiCompatible: { reasoningEffort: effort, thinking },
        deepseek: { thinking },
      };
    }
    if (hasSupportedParameter(metadata, 'reasoning_effort')) {
      const options = { reasoningEffort: effort };
      if (metadata?.providerId) return { [toCamelCase(metadata.providerId)]: options };
      return { openai: options, openaiCompatible: options };
    }
    if (hasSupportedParameter(metadata, 'reasoning')) {
      return { openrouter: { reasoning: { effort, exclude: false } } };
    }
    return undefined;
  }

  return undefined;
}

export function deepMergeProviderOptions(
  a?: Record<string, Record<string, unknown>>,
  b?: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: Record<string, Record<string, unknown>> = {};
  for (const key of keys) {
    out[key] = { ...a[key], ...b[key] };
  }
  return out;
}

export function thinkingProviderOptions(
  npm: string,
  metadata?: ReasoningMetadata,
): Record<string, Record<string, unknown>> | undefined {
  if (npm === '@ai-sdk/google') {
    const levels = reportedReasoningLevels(metadata);
    if (metadata?.reasoning !== true && !(levels && levels.length > 0)) return undefined;
    return { google: { thinkingConfig: { includeThoughts: true } } };
  }
  if (npm === '@ai-sdk/openai') {
    return {
      openai: {
        store: false,
        include: ['reasoning.encrypted_content'],
        ...(metadata?.useResponsesLite === true
          ? { reasoningContext: 'all_turns', parallelToolCalls: false }
          : metadata?.supportsParallelToolCalls === false
            ? { parallelToolCalls: false }
            : {}),
        ...(metadata?.supportsReasoningSummaries === false
          || metadata?.supportsReasoningSummaryParameter === false
          ? { reasoningSummary: null }
          : {}),
        ...(hasExplicitReasoningMetadata(metadata) && metadata?.reasoning !== false
          ? { forceReasoning: true, systemMessageMode: 'developer' }
          : {}),
      },
    };
  }
  return undefined;
}
