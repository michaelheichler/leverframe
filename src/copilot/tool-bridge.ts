/**
 * Exposes Claude tools to Copilot while keeping execution in Claude Code.
 * Handler promises cross HTTP requests and settle only from matching tool results.
 */

import type { LanguageModelV3FunctionTool } from '@ai-sdk/provider';
import type { ToolResultPart } from 'ai';

export type ToolBridgeSettleReason = 'abort' | 'disconnect' | 'timeout' | 'disposal';

interface ToolInvocation {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
}

export interface CopilotBridgeTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  overridesBuiltInTool: true;
  skipPermission: true;
  defer: 'never';
  handler: (args: unknown, invocation: ToolInvocation) => Promise<unknown>;
}

export interface ToolBridge {
  readonly copilotTools: readonly CopilotBridgeTool[];
  pendingToolCallIds(): readonly string[];
  resolveToolResults(results: readonly ToolResultPart[]): void;
  settleAllPending(reason: ToolBridgeSettleReason): void;
}

interface PendingToolCall {
  toolName: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface ToolBridgeState {
  pending: Map<string, PendingToolCall>;
  settled: Set<string>;
  terminalReason: ToolBridgeSettleReason | undefined;
}

export class DuplicateToolResultError extends Error {
  readonly toolCallId: string;

  constructor(toolCallId: string) {
    super(`Tool result for "${toolCallId}" was already settled`);
    this.name = 'DuplicateToolResultError';
    this.toolCallId = toolCallId;
  }
}

export class UnknownToolResultError extends Error {
  readonly toolCallId: string;

  constructor(toolCallId: string) {
    super(`Tool result for unknown call "${toolCallId}"`);
    this.name = 'UnknownToolResultError';
    this.toolCallId = toolCallId;
  }
}

export class ToolResultError extends Error {
  readonly toolCallId: string;
  readonly toolName: string;

  constructor(toolCallId: string, toolName: string, detail: string) {
    super(`Tool "${toolName}" failed for call "${toolCallId}": ${detail}`);
    this.name = 'ToolResultError';
    this.toolCallId = toolCallId;
    this.toolName = toolName;
  }
}

class ToolBridgeSettledError extends Error {
  readonly reason: ToolBridgeSettleReason;

  constructor(reason: ToolBridgeSettleReason) {
    super(`Copilot tool bridge settled because of ${reason}`);
    this.name = 'ToolBridgeSettledError';
    this.reason = reason;
  }
}

function schemaRecord(
  tool: LanguageModelV3FunctionTool,
): Record<string, unknown> {
  if (tool.inputSchema === null || typeof tool.inputSchema !== 'object') {
    throw new TypeError(`Tool "${tool.name}" input schema must be a JSON object`);
  }
  return tool.inputSchema as Record<string, unknown>;
}

function resultValue(result: ToolResultPart): unknown {
  if (result.output.type === 'text' || result.output.type === 'json') {
    return result.output.value;
  }
  if (result.output.type === 'content') return result.output.value;
  return undefined;
}

function resultError(result: ToolResultPart): ToolResultError | undefined {
  const output = result.output;
  if (output.type === 'error-text') {
    return new ToolResultError(result.toolCallId, result.toolName, output.value);
  }
  if (output.type === 'error-json') {
    return new ToolResultError(result.toolCallId, result.toolName, JSON.stringify(output.value));
  }
  if (output.type === 'execution-denied') {
    return new ToolResultError(result.toolCallId, result.toolName, output.reason ?? 'execution denied');
  }
  return undefined;
}

function pendingHandler(
  state: ToolBridgeState,
  toolName: string,
): CopilotBridgeTool['handler'] {
  return (_args, invocation) => {
    if (state.terminalReason !== undefined) {
      return Promise.reject(new ToolBridgeSettledError(state.terminalReason));
    }
    if (state.pending.has(invocation.toolCallId) || state.settled.has(invocation.toolCallId)) {
      return Promise.reject(new DuplicateToolResultError(invocation.toolCallId));
    }
    if (invocation.toolName !== toolName) {
      return Promise.reject(new Error(
        `Copilot invoked tool "${toolName}" with mismatched name "${invocation.toolName}"`,
      ));
    }
    return new Promise<unknown>((resolve, reject) => {
      state.pending.set(invocation.toolCallId, { toolName, resolve, reject });
    });
  };
}

function copilotTools(
  tools: readonly LanguageModelV3FunctionTool[],
  state: ToolBridgeState,
): readonly CopilotBridgeTool[] {
  return tools.map(tool => ({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    parameters: schemaRecord(tool),
    overridesBuiltInTool: true,
    skipPermission: true,
    defer: 'never',
    handler: pendingHandler(state, tool.name),
  }));
}

const TOOL_RESULT_OUTPUT_TYPES = new Set([
  'text',
  'json',
  'content',
  'error-text',
  'error-json',
  'execution-denied',
]);

function validateResults(state: ToolBridgeState, results: readonly ToolResultPart[]): void {
  const batchIds = new Set<string>();
  for (const result of results) {
    if (!TOOL_RESULT_OUTPUT_TYPES.has(result.output.type)) {
      throw new TypeError(`Unsupported tool-result output type "${result.output.type}"`);
    }
    if (state.settled.has(result.toolCallId) || batchIds.has(result.toolCallId)) {
      throw new DuplicateToolResultError(result.toolCallId);
    }
    const call = state.pending.get(result.toolCallId);
    if (call === undefined) throw new UnknownToolResultError(result.toolCallId);
    if (call.toolName !== result.toolName) {
      throw new Error(
        `Tool result name "${result.toolName}" does not match pending tool "${call.toolName}"`,
      );
    }
    batchIds.add(result.toolCallId);
  }
}

function resolveResults(state: ToolBridgeState, results: readonly ToolResultPart[]): void {
  validateResults(state, results);
  for (const result of results) {
    const call = state.pending.get(result.toolCallId);
    if (call === undefined) throw new UnknownToolResultError(result.toolCallId);
    state.pending.delete(result.toolCallId);
    state.settled.add(result.toolCallId);
    const error = resultError(result);
    if (error === undefined) call.resolve(resultValue(result));
    else call.reject(error);
  }
}

function settlePending(state: ToolBridgeState, reason: ToolBridgeSettleReason): void {
  state.terminalReason ??= reason;
  for (const [toolCallId, call] of state.pending) {
    state.pending.delete(toolCallId);
    state.settled.add(toolCallId);
    call.reject(new ToolBridgeSettledError(state.terminalReason));
  }
}

/** Creates declarations whose handlers wait for a later Claude tool-result request. */
export function createToolBridge(
  tools: readonly LanguageModelV3FunctionTool[],
): ToolBridge {
  const state: ToolBridgeState = {
    pending: new Map(),
    settled: new Set(),
    terminalReason: undefined,
  };
  return {
    copilotTools: copilotTools(tools, state),
    pendingToolCallIds: () => [...state.pending.keys()],
    resolveToolResults: results => resolveResults(state, results),
    settleAllPending: reason => settlePending(state, reason),
  };
}
