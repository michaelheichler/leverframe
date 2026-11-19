
import { VERTEX_ANTHROPIC_NPM } from './constants.js';
import { isCanonicalOpenAiBaseUrl } from './openai-endpoint-provenance.js';

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
  templateId?: string;
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
const ANTHROPIC_WIRE_EFFORT_LEVELS = new Set<string>([...ANTHROPIC_EFFORT_LEVELS, 'xhigh', 'max']);
const OPENAI_GPT_62_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const CLAUDE_XHIGH_MODELS = /^claude-(?:(?:opus|sonnet)-5(?:-5)?|(?:fable|mythos)-5(?:-[12])?|haiku-5-5|opus-4-[78]|mythos-preview)(?:-\d{8})?$/;
const CLAUDE_MAX_MODELS = /^claude-(?:opus|sonnet)-4-6(?:-\d{8})?$/;

const EMPTY_REASONING: ReasoningCapabilities = {
  levels: [],
  defaultLevel: '',
  supportsSummaries: false,
  mode: 'none',
  source: 'none',
  confidence: 'inferred',
};

function isClaudeReasoningModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (!lower.startsWith('claude-')) return false;
  if (lower.includes('fable') || lower.includes('mythos')) return true;
  const m = lower.match(/^claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d+))?/);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
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

function openAiReasoningCapabilities(npm: string, modelId: string, metadata?: ReasoningMetadata): ReasoningCapabilities {
  const wireFormat = { kind: 'openai-reasoning-effort' } as const;
  if (npm === '@ai-sdk/openai' && metadata?.providerId === 'openai'
    && /^gpt-6\.2-(?:astra|sol)$/.test(modelId) && isCanonicalOpenAiBaseUrl(metadata.apiBaseUrl)
    && metadata.reasoning !== false && metadata.supportedReasoningEfforts === undefined) {
    return {
      levels: [...OPENAI_GPT_62_EFFORT_LEVELS],
      defaultLevel: defaultReportedReasoningLevel([...OPENAI_GPT_62_EFFORT_LEVELS], metadata.defaultReasoningEffort) || 'medium',
      supportsSummaries: metadata.supportsReasoningSummaries === true,
      mode: 'controllable',
      source: 'provider-rule',
      confidence: 'documented',
      wireFormat,
    };
  }
  return metadataReasoningCapabilities(metadata, wireFormat);
}

function reportedEffort(metadata: ReasoningMetadata | undefined, effort: string): string | undefined {
  const levels = reportedReasoningLevels(metadata);
  return levels?.includes(effort) ? effort : undefined;
}

function openAiCompatibleReasoningWireFormat(
  metadata: ReasoningMetadata | undefined,
): ReasoningWireFormat | undefined {
  if (metadata?.supportsReasoningToggle === true) return { kind: 'deepseek-thinking' };
  if (hasSupportedParameter(metadata, 'reasoning_effort')
    || (metadata?.providerId === 'opencode-go' && reportedReasoningLevels(metadata)?.length)) {
    return { kind: 'openai-reasoning-effort' };
  }
  if (hasSupportedParameter(metadata, 'reasoning')) return { kind: 'openrouter-reasoning' };
  return undefined;
}

function anthropicReasoningCapabilities(npm: string, modelId: string, metadata?: ReasoningMetadata): ReasoningCapabilities {
  if (metadata?.reasoning === false) return EMPTY_REASONING;
  const wireFormat = { kind: 'anthropic-thinking' } as const;
  const reported = reportedReasoningLevels(metadata)?.filter(level => ANTHROPIC_WIRE_EFFORT_LEVELS.has(level));
  const isClaude = isClaudeReasoningModel(modelId);
  if (reported === undefined && !isClaude && metadata?.reasoning !== true) return EMPTY_REASONING;
  const levels: string[] = reported ?? [...ANTHROPIC_EFFORT_LEVELS];
  if (reported === undefined && npm === '@ai-sdk/anthropic'
    && (metadata?.apiBaseUrl === undefined || /^https:\/\/api\.anthropic\.com(?:\/v1)?\/?$/.test(metadata.apiBaseUrl))) {
    if (CLAUDE_XHIGH_MODELS.test(modelId)) levels.push('xhigh', 'max');
    else if (CLAUDE_MAX_MODELS.test(modelId)) levels.push('max');
  }
  const documentedDefault = /^claude-(?:opus|haiku)-5-5(?:-\d{8})?$/.test(modelId) ? 'medium' : 'high';
  return {
    levels,
    defaultLevel: defaultReportedReasoningLevel(levels, metadata?.defaultReasoningEffort)
      || (isClaude && levels.includes(documentedDefault) ? documentedDefault : ''),
    supportsSummaries: metadata?.supportsReasoningSummaries ?? isClaude,
    mode: levels.length > 0 ? 'controllable' : metadata?.reasoning === true ? 'internal-only' : 'none',
    source: reported !== undefined || !isClaude ? 'model-metadata' : 'provider-rule',
    confidence: reported !== undefined || isClaude ? 'documented' : 'inferred',
    wireFormat,
  };
}

function mapCodexEffortToAnthropic(effort: string, levels: string[]): string | undefined {
  if (levels.includes(effort)) return effort;
  if ((effort === 'none' || effort === 'minimal') && levels.includes('low')) return 'low';
  if (effort === 'xhigh' && levels.includes('high')) return 'high';
  return undefined;
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
    return anthropicReasoningCapabilities(npm, modelId, metadata);
  }

  if (npm === '@ai-sdk/openai' || npm === '@ai-sdk/azure') {
    return openAiReasoningCapabilities(npm, modelId, metadata);
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
    if (!openAiReasoningCapabilities(npm, modelId ?? '', metadata).levels.includes(effort)) return undefined;
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
    if (!modelId) return undefined;
    const mapped = mapCodexEffortToAnthropic(effort, anthropicReasoningCapabilities(npm, modelId, metadata).levels);
    if (!mapped) return undefined;
    const thinking = isClaudeReasoningModel(modelId) ? { type: 'adaptive' } : undefined;
    return { anthropic: { ...(thinking ? { thinking } : {}), effort: mapped } };
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
    if (openAiCompatibleReasoningWireFormat(metadata)?.kind === 'openai-reasoning-effort') {
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
        ...(metadata?.supportsParallelToolCalls === false ? { parallelToolCalls: false } : {}),
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
