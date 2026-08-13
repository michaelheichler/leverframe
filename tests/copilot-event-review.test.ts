import { describe, expect, it } from 'vitest';
import {
  CopilotEventProtocolError,
  createCopilotEventStreamBridge,
} from '../src/copilot/event-stream.js';
import {
  abortEvent,
  idleEvent,
  messageDeltaEvent,
  messageEvent,
  messageStartEvent,
  toolCallDeltaEvent,
  turnEndEvent,
  usageEvent,
} from './fixtures/copilot-session-events.js';

describe('Copilot event usage across model calls', () => {
  it('adds disjoint counters from every usage event before finish', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(usageEvent({
      id: 'evt-1',
      model: 'copilot-gpt-5',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      reasoningTokens: 1,
      finishReason: 'stop',
    }));
    bridge.handle(usageEvent({
      id: 'evt-2',
      model: 'copilot-gpt-5',
      inputTokens: 20,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      reasoningTokens: 2,
      finishReason: 'stop',
    }));

    const parts = bridge.handle(turnEndEvent({ id: 'evt-3', turnId: 'turn-1' }));

    expect(parts).toEqual([{
      type: 'finish',
      usage: {
        inputTokens: { total: 30, noCache: 25, cacheRead: 5, cacheWrite: 3 },
        outputTokens: { total: 12, text: 9, reasoning: 3 },
      },
      finishReason: { unified: 'stop', raw: 'stop' },
    }]);
  });

  it('reports an aborted idle boundary instead of a successful finish', () => {
    const bridge = createCopilotEventStreamBridge();

    const parts = bridge.handle(idleEvent({ id: 'evt-1', aborted: true }));

    expect(parts).toEqual([expect.objectContaining({
      type: 'finish',
      finishReason: { unified: 'other', raw: 'abort:idle' },
    })]);
  });
});

describe('Copilot terminal block closure', () => {
  it('closes open text before an abort finish', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(messageStartEvent({ id: 'evt-1', messageId: 'msg-1' }));
    bridge.handle(messageDeltaEvent({ id: 'evt-2', messageId: 'msg-1', deltaContent: 'partial' }));

    const parts = bridge.handle(abortEvent({ id: 'evt-3', reason: 'user_initiated' }));

    expect(parts.map(part => part.type)).toEqual(['text-end', 'finish']);
  });
});

describe('Copilot tool-call delta validation', () => {
  it('buffers input until the finalized request supplies an optional tool name', () => {
    const bridge = createCopilotEventStreamBridge();

    expect(bridge.handle(toolCallDeltaEvent({
      id: 'evt-1',
      toolCallId: 'call-1',
      inputDelta: '{"path":"a.txt"}',
    }))).toEqual([]);
    const parts = bridge.handle(messageEvent({
      id: 'evt-2',
      messageId: 'msg-1',
      content: '',
      toolRequests: [{ toolCallId: 'call-1', name: 'Read', arguments: { path: 'a.txt' } }],
    }));

    expect(parts).toEqual([
      { type: 'tool-input-start', id: 'call-1', toolName: 'Read' },
      { type: 'tool-input-delta', id: 'call-1', delta: '{"path":"a.txt"}' },
      { type: 'tool-input-end', id: 'call-1' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'Read', input: '{"path":"a.txt"}' },
      expect.objectContaining({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' } }),
    ]);
  });

  it('rejects a finalized name that differs from the streamed name', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(toolCallDeltaEvent({
      id: 'evt-1',
      toolCallId: 'call-1',
      toolName: 'Read',
      inputDelta: '{}',
    }));

    expect(() => bridge.handle(messageEvent({
      id: 'evt-2',
      messageId: 'msg-1',
      content: '',
      toolRequests: [{ toolCallId: 'call-1', name: 'Grep', arguments: {} }],
    }))).toThrow(CopilotEventProtocolError);
  });
});
