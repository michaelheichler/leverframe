/**
 * Converts public Copilot session events into AI SDK V3 stream parts.
 * Only root-agent events cross the provider boundary.
 */

import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import {
  addCopilotUsage,
  languageModelFinishReason,
  languageModelUsage,
  type CopilotUsageState,
} from './event-usage.js';

export interface CopilotSessionEvent {
  type: string;
  agentId?: string;
  data: unknown;
}

export interface CopilotEventStreamBridge {
  readonly closed: boolean;
  handle(event: CopilotSessionEvent): LanguageModelV3StreamPart[];
}

interface EventBridgeState {
  closed: boolean;
  openText: Set<string>;
  openReasoning: Set<string>;
  openTools: Map<string, OpenToolInput>;
  usage: CopilotUsageState;
  sawToolCalls: boolean;
  /**
   * Last `model.call_failure` with no successful retry after it. Copilot emits
   * `assistant.turn_end` before `session.error`, so without this the turn would
   * close cleanly and the real cause (quota, auth, upstream 4xx) would be lost
   * behind a generic empty-response error.
   */
  callFailure?: CopilotCallFailure;
}

interface CopilotCallFailure {
  message: string;
  statusCode?: number;
}

interface ToolRequest {
  toolCallId: string;
  name: string;
  arguments?: Record<string, unknown>;
}

interface OpenToolInput {
  name?: string;
  bufferedDeltas: string[];
}

export class CopilotEventStreamClosedError extends Error {
  constructor() {
    super('Copilot event stream is already closed');
    this.name = 'CopilotEventStreamClosedError';
  }
}

export class CopilotEventProtocolError extends Error {
  constructor(eventType: string, detail: string) {
    super(`Invalid Copilot ${eventType} event: ${detail}`);
    this.name = 'CopilotEventProtocolError';
  }
}

function dataRecord(event: CopilotSessionEvent): Record<string, unknown> {
  if (event.data === null || typeof event.data !== 'object' || Array.isArray(event.data)) {
    throw new CopilotEventProtocolError(event.type, 'data must be an object');
  }
  return event.data as Record<string, unknown>;
}

interface EventFieldInput {
  event: CopilotSessionEvent;
  data: Record<string, unknown>;
  field: string;
}

function stringField(input: EventFieldInput): string {
  const value = input.data[input.field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new CopilotEventProtocolError(
      input.event.type,
      `${input.field} must be a non-empty string`,
    );
  }
  return value;
}

function optionalNumber(input: EventFieldInput): number | undefined {
  const value = input.data[input.field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new CopilotEventProtocolError(
      input.event.type,
      `${input.field} must be a non-negative number`,
    );
  }
  return value;
}

function textParts(
  state: EventBridgeState,
  event: CopilotSessionEvent,
): LanguageModelV3StreamPart[] {
  const data = dataRecord(event);
  const messageId = stringField({ event, data, field: 'messageId' });
  if (event.type === 'assistant.message_start') {
    state.openText.add(messageId);
    return [{ type: 'text-start', id: messageId }];
  }
  if (event.type === 'assistant.message_delta') {
    const delta = stringField({ event, data, field: 'deltaContent' });
    const start = state.openText.has(messageId)
      ? []
      : [{ type: 'text-start' as const, id: messageId }];
    state.openText.add(messageId);
    return [...start, { type: 'text-delta', id: messageId, delta }];
  }

  const content = typeof data.content === 'string'
    ? data.content
    : (() => { throw new CopilotEventProtocolError(event.type, 'content must be a string'); })();
  const parts: LanguageModelV3StreamPart[] = state.openText.has(messageId)
    ? [{ type: 'text-end', id: messageId }]
    : content.length === 0
      ? []
      : [
          { type: 'text-start', id: messageId },
          { type: 'text-delta', id: messageId, delta: content },
          { type: 'text-end', id: messageId },
        ];
  state.openText.delete(messageId);
  const toolParts = finalizedToolParts({ state, event, value: data.toolRequests });
  return toolParts.length === 0
    ? parts
    : [...parts, ...toolParts, ...finish(state, undefined)];
}

function reasoningParts(
  state: EventBridgeState,
  event: CopilotSessionEvent,
): LanguageModelV3StreamPart[] {
  const data = dataRecord(event);
  const reasoningId = stringField({ event, data, field: 'reasoningId' });
  if (event.type === 'assistant.reasoning_delta') {
    const delta = stringField({ event, data, field: 'deltaContent' });
    const start = state.openReasoning.has(reasoningId)
      ? []
      : [{ type: 'reasoning-start' as const, id: reasoningId }];
    state.openReasoning.add(reasoningId);
    return [...start, { type: 'reasoning-delta', id: reasoningId, delta }];
  }

  const content = typeof data.content === 'string'
    ? data.content
    : (() => { throw new CopilotEventProtocolError(event.type, 'content must be a string'); })();
  const parts: LanguageModelV3StreamPart[] = state.openReasoning.has(reasoningId)
    ? [{ type: 'reasoning-end', id: reasoningId }]
    : [
        { type: 'reasoning-start', id: reasoningId },
        ...(content.length === 0
          ? []
          : [{ type: 'reasoning-delta' as const, id: reasoningId, delta: content }]),
        { type: 'reasoning-end', id: reasoningId },
      ];
  state.openReasoning.delete(reasoningId);
  return parts;
}

function toolDeltaParts(
  state: EventBridgeState,
  event: CopilotSessionEvent,
): LanguageModelV3StreamPart[] {
  const data = dataRecord(event);
  const toolCallId = stringField({ event, data, field: 'toolCallId' });
  const delta = stringField({ event, data, field: 'inputDelta' });
  const suppliedName = data.toolName === undefined
    ? undefined
    : stringField({ event, data, field: 'toolName' });
  const open = state.openTools.get(toolCallId) ?? { bufferedDeltas: [] };
  if (open.name !== undefined && suppliedName !== undefined && open.name !== suppliedName) {
    throw new CopilotEventProtocolError(event.type, 'toolName changed during input streaming');
  }
  const toolName = open.name ?? suppliedName;
  if (toolName === undefined) {
    open.bufferedDeltas.push(delta);
    state.openTools.set(toolCallId, open);
    return [];
  }
  if (open.name !== undefined) return [{ type: 'tool-input-delta', id: toolCallId, delta }];
  state.openTools.set(toolCallId, { name: toolName, bufferedDeltas: [] });
  return [
    { type: 'tool-input-start', id: toolCallId, toolName },
    ...open.bufferedDeltas.map(value => ({
      type: 'tool-input-delta' as const,
      id: toolCallId,
      delta: value,
    })),
    { type: 'tool-input-delta', id: toolCallId, delta },
  ];
}

function parseToolRequests(event: CopilotSessionEvent, value: unknown): ToolRequest[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new CopilotEventProtocolError(event.type, 'toolRequests must be an array');
  }
  return value.map(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new CopilotEventProtocolError(event.type, 'tool request must be an object');
    }
    const record = item as Record<string, unknown>;
    const toolCallId = stringField({ event, data: record, field: 'toolCallId' });
    const name = stringField({ event, data: record, field: 'name' });
    const args = record.arguments;
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
      throw new CopilotEventProtocolError(event.type, 'tool arguments must be an object');
    }
    return { toolCallId, name, arguments: args as Record<string, unknown> | undefined };
  });
}

interface FinalizedToolInput {
  state: EventBridgeState;
  event: CopilotSessionEvent;
  value: unknown;
}

function finalizedToolParts(input: FinalizedToolInput): LanguageModelV3StreamPart[] {
  const requests = parseToolRequests(input.event, input.value);
  if (requests.length > 0) input.state.sawToolCalls = true;
  return requests.flatMap(request => {
    const open = input.state.openTools.get(request.toolCallId);
    if (open?.name !== undefined && open.name !== request.name) {
      throw new CopilotEventProtocolError(input.event.type, 'final tool name does not match input stream');
    }
    const start = open?.name === undefined
      ? [
          { type: 'tool-input-start' as const, id: request.toolCallId, toolName: request.name },
          ...(open?.bufferedDeltas ?? []).map(delta => ({
            type: 'tool-input-delta' as const,
            id: request.toolCallId,
            delta,
          })),
        ]
      : [];
    input.state.openTools.delete(request.toolCallId);
    return [
      ...start,
      { type: 'tool-input-end' as const, id: request.toolCallId },
      {
        type: 'tool-call' as const,
        toolCallId: request.toolCallId,
        toolName: request.name,
        input: JSON.stringify(request.arguments ?? {}),
      },
    ];
  });
}

function recordUsage(state: EventBridgeState, event: CopilotSessionEvent): void {
  const data = dataRecord(event);
  state.usage = addCopilotUsage(state.usage, {
    inputTokens: optionalNumber({ event, data, field: 'inputTokens' }),
    outputTokens: optionalNumber({ event, data, field: 'outputTokens' }),
    cacheReadTokens: optionalNumber({ event, data, field: 'cacheReadTokens' }),
    cacheWriteTokens: optionalNumber({ event, data, field: 'cacheWriteTokens' }),
    reasoningTokens: optionalNumber({ event, data, field: 'reasoningTokens' }),
    finishReason: data.finishReason === undefined
      ? undefined
      : stringField({ event, data, field: 'finishReason' }),
  });
}

function closeOpenParts(state: EventBridgeState): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [
    ...[...state.openText].map(id => ({ type: 'text-end' as const, id })),
    ...[...state.openReasoning].map(id => ({ type: 'reasoning-end' as const, id })),
    ...[...state.openTools].flatMap(([id, input]) => (
      input.name === undefined ? [] : [{ type: 'tool-input-end' as const, id }]
    )),
  ];
  state.openText.clear();
  state.openReasoning.clear();
  state.openTools.clear();
  return parts;
}

/**
 * `model.call_failure.errorMessage` carries the upstream body, usually JSON
 * like `{"message":"You have exceeded your monthly quota"}`. Prefer that
 * message, fall back to the raw string.
 */
function callFailureMessage(raw: string | undefined, statusCode: number | undefined): string {
  const fallback = statusCode === undefined
    ? 'Copilot model call failed'
    : `Copilot model call failed with status ${statusCode}`;
  if (raw === undefined || raw.length === 0) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && 'message' in parsed) {
      const message = (parsed as { message: unknown }).message;
      if (typeof message === 'string' && message.length > 0) return message;
    }
  } catch {
    // Not JSON, use the raw body below.
  }
  return raw;
}

function recordCallFailure(state: EventBridgeState, event: CopilotSessionEvent): void {
  const data = dataRecord(event);
  const raw = typeof data['errorMessage'] === 'string' ? data['errorMessage'] : undefined;
  const statusCode = typeof data['statusCode'] === 'number' ? data['statusCode'] : undefined;
  state.callFailure = { message: callFailureMessage(raw, statusCode), statusCode };
}

function finish(state: EventBridgeState, rawOverride: string | undefined): LanguageModelV3StreamPart[] {
  const closingParts = closeOpenParts(state);
  state.closed = true;
  const failure = state.callFailure;
  if (failure !== undefined) {
    return [
      ...closingParts,
      { type: 'error', error: { errorType: 'model_call_failure', message: failure.message, statusCode: failure.statusCode } },
    ];
  }
  return [
    ...closingParts,
    {
      type: 'finish',
      usage: languageModelUsage(state.usage),
      finishReason: rawOverride === undefined
        ? languageModelFinishReason(state.usage, state.sawToolCalls)
        : { unified: 'other', raw: rawOverride },
    },
  ];
}

function errorPart(state: EventBridgeState, event: CopilotSessionEvent): LanguageModelV3StreamPart[] {
  const data = dataRecord(event);
  const errorType = stringField({ event, data, field: 'errorType' });
  const message = stringField({ event, data, field: 'message' });
  const statusCode = optionalNumber({ event, data, field: 'statusCode' });
  state.closed = true;
  return [{ type: 'error', error: { errorType, message, statusCode } }];
}

function assistantParts(
  state: EventBridgeState,
  event: CopilotSessionEvent,
): LanguageModelV3StreamPart[] {
  if (event.type.startsWith('assistant.message')) return textParts(state, event);
  if (event.type.startsWith('assistant.reasoning')) return reasoningParts(state, event);
  if (event.type === 'assistant.tool_call_delta') return toolDeltaParts(state, event);
  if (event.type === 'assistant.usage') {
    recordUsage(state, event);
    return [];
  }
  if (event.type === 'assistant.turn_end') return finish(state, undefined);
  if (event.type === 'assistant.idle') {
    const data = dataRecord(event);
    if (data.aborted !== undefined && typeof data.aborted !== 'boolean') {
      throw new CopilotEventProtocolError(event.type, 'aborted must be a boolean');
    }
    return finish(state, data.aborted === true ? 'abort:idle' : undefined);
  }
  return [];
}

function eventParts(
  state: EventBridgeState,
  event: CopilotSessionEvent,
): LanguageModelV3StreamPart[] {
  if (event.agentId !== undefined) return [];
  if (state.closed) throw new CopilotEventStreamClosedError();
  // A fresh attempt supersedes an earlier failed one, so a retried call that
  // succeeds does not inherit the previous failure.
  if (event.type === 'model.call_start') {
    state.callFailure = undefined;
    return [];
  }
  if (event.type === 'model.call_failure') {
    recordCallFailure(state, event);
    return [];
  }
  if (event.type.startsWith('assistant.')) return assistantParts(state, event);
  if (event.type === 'session.error') return errorPart(state, event);
  if (event.type === 'abort') {
    const data = dataRecord(event);
    return finish(state, `abort:${stringField({ event, data, field: 'reason' })}`);
  }
  return [];
}

/** Creates one stateful mapper for a single root Copilot turn. */
export function createCopilotEventStreamBridge(): CopilotEventStreamBridge {
  const state: EventBridgeState = {
    closed: false,
    openText: new Set(),
    openReasoning: new Set(),
    openTools: new Map(),
    usage: {},
    sawToolCalls: false,
  };
  return {
    get closed() { return state.closed; },
    handle: event => eventParts(state, event),
  };
}

