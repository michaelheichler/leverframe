// src/tool-call-tap.ts — read-only, best-effort observation of Anthropic and
// OpenAI response shapes (SSE and full JSON), used to drive the persistent
// tool-call ledger and the checkpoint's visible-byte accounting.
//
// This module never mutates, delays, or re-orders anything it observes. It
// exists purely so router.ts can tee already-outbound bytes into the
// execution tracker without touching the byte-for-byte passthrough path the
// native-Anthropic golden tests protect (stabilization plan §11.3): callers
// feed it a *copy* of the bytes already written to the client.

export interface ToolCallTapCallbacks {
  onToolUse?: (toolCallId: string, toolName: string) => void;
  onTextBytes?: (byteCount: number) => void;
  onMessageStop?: () => void;
}

export interface ToolCallTap {
  feed(chunk: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseSseDataLine(raw: string): unknown {
  const dataLine = raw.split('\n').find(line => line.startsWith('data:'));
  if (!dataLine) return undefined;
  const payload = dataLine.slice(dataLine.indexOf(':') + 1).trim();
  if (!payload || payload === '[DONE]') return undefined;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

function processAnthropicEvent(parsed: unknown, callbacks: ToolCallTapCallbacks): void {
  if (!isRecord(parsed)) return;
  if (parsed.type === 'content_block_start') {
    const block = parsed.content_block;
    if (isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      callbacks.onToolUse?.(block.id, block.name);
    }
    return;
  }
  if (parsed.type === 'content_block_delta') {
    const delta = parsed.delta;
    if (isRecord(delta) && delta.type === 'text_delta' && typeof delta.text === 'string') {
      callbacks.onTextBytes?.(Buffer.byteLength(delta.text, 'utf8'));
    }
    return;
  }
  if (parsed.type === 'message_stop') {
    callbacks.onMessageStop?.();
  }
}

function emitOpenAiToolCall(call: unknown, callbacks: ToolCallTapCallbacks): void {
  if (!isRecord(call)) return;
  const fn = call.function;
  const name = isRecord(fn) && typeof fn.name === 'string' ? fn.name : undefined;
  if (typeof call.id === 'string' && name) callbacks.onToolUse?.(call.id, name);
}

function processOpenAiEvent(parsed: unknown, callbacks: ToolCallTapCallbacks): void {
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return;
  for (const choiceValue of parsed.choices) {
    if (!isRecord(choiceValue)) continue;
    const delta = choiceValue.delta;
    const toolCalls = isRecord(delta) ? delta.tool_calls : undefined;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) emitOpenAiToolCall(call, callbacks);
    }
    if (isRecord(delta) && typeof delta.content === 'string') {
      callbacks.onTextBytes?.(Buffer.byteLength(delta.content, 'utf8'));
    }
    if (choiceValue.finish_reason) callbacks.onMessageStop?.();
  }
}

function createLineBufferedTap(processEvent: (parsed: unknown, callbacks: ToolCallTapCallbacks) => void, callbacks: ToolCallTapCallbacks): ToolCallTap {
  let buffer = '';
  return {
    feed(chunk: string): void {
      buffer += chunk;
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseDataLine(raw);
        if (parsed !== undefined) processEvent(parsed, callbacks);
      }
    },
  };
}

/** Stateful line-buffered tap for Anthropic-format SSE. Feed it raw text chunks in wire order. */
export function createAnthropicSseTap(callbacks: ToolCallTapCallbacks): ToolCallTap {
  return createLineBufferedTap(processAnthropicEvent, callbacks);
}

/** Stateful line-buffered tap for OpenAI chat-completions SSE. Feed it raw text chunks in wire order. */
export function createOpenAiSseTap(callbacks: ToolCallTapCallbacks): ToolCallTap {
  return createLineBufferedTap(processOpenAiEvent, callbacks);
}

/** Best-effort extraction from a full (non-streamed) Anthropic response body. */
export function observeNonStreamAnthropicResponse(parsed: unknown, callbacks: ToolCallTapCallbacks): void {
  if (!isRecord(parsed) || !Array.isArray(parsed.content)) return;
  for (const block of parsed.content) {
    if (!isRecord(block)) continue;
    if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      callbacks.onToolUse?.(block.id, block.name);
    } else if (block.type === 'text' && typeof block.text === 'string') {
      callbacks.onTextBytes?.(Buffer.byteLength(block.text, 'utf8'));
    }
  }
  callbacks.onMessageStop?.();
}

/** Best-effort extraction from a full (non-streamed) OpenAI chat-completions response body. */
export function observeNonStreamOpenAiResponse(parsed: unknown, callbacks: ToolCallTapCallbacks): void {
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return;
  for (const choiceValue of parsed.choices) {
    if (!isRecord(choiceValue) || !isRecord(choiceValue.message)) continue;
    const message = choiceValue.message;
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) emitOpenAiToolCall(call, callbacks);
    }
    if (typeof message.content === 'string') {
      callbacks.onTextBytes?.(Buffer.byteLength(message.content, 'utf8'));
    }
  }
  callbacks.onMessageStop?.();
}
