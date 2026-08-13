export type AbortReason = 'user_initiated' | 'remote_command' | 'user_abort' | 'autopilot_credit_limit';

export interface AssistantMessageToolRequest {
  toolCallId: string;
  name: string;
  arguments?: Record<string, unknown>;
}

interface SessionEventEnvelope {
  id: string;
  parentId: string | null;
  timestamp: string;
  agentId?: string;
}

export interface AssistantMessageStartEvent extends SessionEventEnvelope {
  type: 'assistant.message_start';
  ephemeral: true;
  data: { messageId: string };
}

export interface AssistantMessageDeltaEvent extends SessionEventEnvelope {
  type: 'assistant.message_delta';
  ephemeral: true;
  data: { messageId: string; deltaContent: string };
}

export interface AssistantMessageEvent extends SessionEventEnvelope {
  type: 'assistant.message';
  ephemeral?: boolean;
  data: { messageId: string; content: string; toolRequests?: AssistantMessageToolRequest[] };
}

export interface AssistantReasoningDeltaEvent extends SessionEventEnvelope {
  type: 'assistant.reasoning_delta';
  ephemeral: true;
  data: { reasoningId: string; deltaContent: string };
}

export interface AssistantReasoningEvent extends SessionEventEnvelope {
  type: 'assistant.reasoning';
  ephemeral?: boolean;
  data: { reasoningId: string; content: string };
}

export interface AssistantToolCallDeltaEvent extends SessionEventEnvelope {
  type: 'assistant.tool_call_delta';
  ephemeral: true;
  data: { toolCallId: string; toolName?: string; inputDelta: string };
}

export interface AssistantUsageEvent extends SessionEventEnvelope {
  type: 'assistant.usage';
  ephemeral: true;
  data: {
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    finishReason?: string;
  };
}

export interface AssistantTurnEndEvent extends SessionEventEnvelope {
  type: 'assistant.turn_end';
  ephemeral?: boolean;
  data: { turnId: string; model?: string };
}

export interface AssistantIdleEvent extends SessionEventEnvelope {
  type: 'assistant.idle';
  ephemeral: true;
  data: { aborted?: boolean };
}

export interface SessionErrorEvent extends SessionEventEnvelope {
  type: 'session.error';
  ephemeral?: boolean;
  data: { errorType: string; message: string; statusCode?: number };
}

export interface AbortEvent extends SessionEventEnvelope {
  type: 'abort';
  ephemeral?: boolean;
  data: { reason: AbortReason };
}

export type FixtureSessionEvent =
  | AssistantMessageStartEvent
  | AssistantMessageDeltaEvent
  | AssistantMessageEvent
  | AssistantReasoningDeltaEvent
  | AssistantReasoningEvent
  | AssistantToolCallDeltaEvent
  | AssistantUsageEvent
  | AssistantTurnEndEvent
  | AssistantIdleEvent
  | SessionErrorEvent
  | AbortEvent;

const FIXED_TIMESTAMP = '2026-08-13T00:00:00.000Z';

function envelope(id: string, agentId?: string): SessionEventEnvelope {
  return { id, parentId: null, timestamp: FIXED_TIMESTAMP, agentId };
}

export function messageStartEvent(options: { id: string; messageId: string; agentId?: string }): AssistantMessageStartEvent {
  return { ...envelope(options.id, options.agentId), type: 'assistant.message_start', ephemeral: true, data: { messageId: options.messageId } };
}

export function messageDeltaEvent(options: {
  id: string;
  messageId: string;
  deltaContent: string;
  agentId?: string;
}): AssistantMessageDeltaEvent {
  return {
    ...envelope(options.id, options.agentId),
    type: 'assistant.message_delta',
    ephemeral: true,
    data: { messageId: options.messageId, deltaContent: options.deltaContent },
  };
}

export function messageEvent(options: {
  id: string;
  messageId: string;
  content: string;
  toolRequests?: AssistantMessageToolRequest[];
  agentId?: string;
}): AssistantMessageEvent {
  return {
    ...envelope(options.id, options.agentId),
    type: 'assistant.message',
    data: { messageId: options.messageId, content: options.content, toolRequests: options.toolRequests },
  };
}

export function reasoningDeltaEvent(options: {
  id: string;
  reasoningId: string;
  deltaContent: string;
  agentId?: string;
}): AssistantReasoningDeltaEvent {
  return {
    ...envelope(options.id, options.agentId),
    type: 'assistant.reasoning_delta',
    ephemeral: true,
    data: { reasoningId: options.reasoningId, deltaContent: options.deltaContent },
  };
}

export function reasoningEvent(options: { id: string; reasoningId: string; content: string; agentId?: string }): AssistantReasoningEvent {
  return { ...envelope(options.id, options.agentId), type: 'assistant.reasoning', data: { reasoningId: options.reasoningId, content: options.content } };
}

export function toolCallDeltaEvent(options: {
  id: string;
  toolCallId: string;
  inputDelta: string;
  toolName?: string;
  agentId?: string;
}): AssistantToolCallDeltaEvent {
  return {
    ...envelope(options.id, options.agentId),
    type: 'assistant.tool_call_delta',
    ephemeral: true,
    data: { toolCallId: options.toolCallId, toolName: options.toolName, inputDelta: options.inputDelta },
  };
}

export function usageEvent(options: {
  id: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  finishReason?: string;
  agentId?: string;
}): AssistantUsageEvent {
  const { id, agentId, ...data } = options;
  return { ...envelope(id, agentId), type: 'assistant.usage', ephemeral: true, data };
}

export function turnEndEvent(options: { id: string; turnId: string; agentId?: string }): AssistantTurnEndEvent {
  return { ...envelope(options.id, options.agentId), type: 'assistant.turn_end', data: { turnId: options.turnId } };
}

export function idleEvent(options: { id: string; aborted?: boolean; agentId?: string }): AssistantIdleEvent {
  return { ...envelope(options.id, options.agentId), type: 'assistant.idle', ephemeral: true, data: { aborted: options.aborted } };
}

export function sessionErrorEvent(options: {
  id: string;
  errorType: string;
  message: string;
  statusCode?: number;
  agentId?: string;
}): SessionErrorEvent {
  return {
    ...envelope(options.id, options.agentId),
    type: 'session.error',
    data: { errorType: options.errorType, message: options.message, statusCode: options.statusCode },
  };
}

export function abortEvent(options: { id: string; reason: AbortReason; agentId?: string }): AbortEvent {
  return { ...envelope(options.id, options.agentId), type: 'abort', data: { reason: options.reason } };
}
