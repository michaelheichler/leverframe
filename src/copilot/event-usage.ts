/**
 * Aggregates per-model-call Copilot usage into one AI SDK turn result.
 * Token categories stay disjoint so Anthropic usage translation remains accurate.
 */

import type {
  LanguageModelV3FinishReason,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';

export interface CopilotUsageState {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  finishReason?: string;
}

function sum(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left + right;
}

/** Adds one model-call usage record while retaining the latest finish reason. */
export function addCopilotUsage(
  current: CopilotUsageState,
  next: CopilotUsageState,
): CopilotUsageState {
  return {
    inputTokens: sum(current.inputTokens, next.inputTokens),
    outputTokens: sum(current.outputTokens, next.outputTokens),
    cacheReadTokens: sum(current.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: sum(current.cacheWriteTokens, next.cacheWriteTokens),
    reasoningTokens: sum(current.reasoningTokens, next.reasoningTokens),
    finishReason: next.finishReason ?? current.finishReason,
  };
}

/** Maps accumulated counters without merging cached or reasoning categories. */
export function languageModelUsage(state: CopilotUsageState): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: state.inputTokens,
      noCache: state.inputTokens === undefined || state.cacheReadTokens === undefined
        ? undefined
        : state.inputTokens - state.cacheReadTokens,
      cacheRead: state.cacheReadTokens,
      cacheWrite: state.cacheWriteTokens,
    },
    outputTokens: {
      total: state.outputTokens,
      text: state.outputTokens === undefined || state.reasoningTokens === undefined
        ? undefined
        : state.outputTokens - state.reasoningTokens,
      reasoning: state.reasoningTokens,
    },
  };
}

/** Normalizes the latest provider finish reason, with tool calls as a structural fallback. */
export function languageModelFinishReason(
  state: CopilotUsageState,
  sawToolCalls: boolean,
): LanguageModelV3FinishReason {
  const raw = state.finishReason ?? (sawToolCalls ? 'tool_calls' : undefined);
  if (raw === 'tool_calls') return { unified: 'tool-calls', raw };
  if (raw === 'stop' || raw === 'length') return { unified: raw, raw };
  if (raw === 'content_filter') return { unified: 'content-filter', raw };
  return { unified: 'other', raw };
}
