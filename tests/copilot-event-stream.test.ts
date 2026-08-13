import { describe, expect, it } from 'vitest';
import {
  createCopilotEventStreamBridge,
  CopilotEventStreamClosedError,
} from '../src/copilot/event-stream.js';
import {
  messageStartEvent,
  messageDeltaEvent,
  messageEvent,
  reasoningDeltaEvent,
  reasoningEvent,
  toolCallDeltaEvent,
  usageEvent,
  turnEndEvent,
  idleEvent,
  sessionErrorEvent,
  abortEvent,
} from './fixtures/copilot-session-events.js';

describe('createCopilotEventStreamBridge: text lifecycle', () => {
  it('opens a text block on assistant.message_start using the message id', () => {
    const bridge = createCopilotEventStreamBridge();
    const parts = bridge.handle(messageStartEvent({ id: 'evt-1', messageId: 'msg-1' }));
    expect(parts).toEqual([{ type: 'text-start', id: 'msg-1' }]);
  });

  it('emits a text delta for each assistant.message_delta on the open message', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(messageStartEvent({ id: 'evt-1', messageId: 'msg-1' }));
    const first = bridge.handle(messageDeltaEvent({ id: 'evt-2', messageId: 'msg-1', deltaContent: 'Hel' }));
    const second = bridge.handle(messageDeltaEvent({ id: 'evt-3', messageId: 'msg-1', deltaContent: 'lo' }));
    expect(first).toEqual([{ type: 'text-delta', id: 'msg-1', delta: 'Hel' }]);
    expect(second).toEqual([{ type: 'text-delta', id: 'msg-1', delta: 'lo' }]);
  });

  it('closes the text block on the finalized assistant.message event', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(messageStartEvent({ id: 'evt-1', messageId: 'msg-1' }));
    bridge.handle(messageDeltaEvent({ id: 'evt-2', messageId: 'msg-1', deltaContent: 'Hello' }));
    const parts = bridge.handle(messageEvent({ id: 'evt-3', messageId: 'msg-1', content: 'Hello' }));
    expect(parts).toEqual([{ type: 'text-end', id: 'msg-1' }]);
  });

  it('brackets final text when ephemeral events were not emitted', () => {
    const bridge = createCopilotEventStreamBridge();
    const parts = bridge.handle(messageEvent({ id: 'evt-1', messageId: 'msg-1', content: 'Hello' }));
    expect(parts).toEqual([
      { type: 'text-start', id: 'msg-1' },
      { type: 'text-delta', id: 'msg-1', delta: 'Hello' },
      { type: 'text-end', id: 'msg-1' },
    ]);
  });
});

describe('createCopilotEventStreamBridge: reasoning lifecycle opening', () => {
  it('opens a reasoning block on the first assistant.reasoning_delta for a reasoning id', () => {
    const bridge = createCopilotEventStreamBridge();
    const parts = bridge.handle(reasoningDeltaEvent({ id: 'evt-1', reasoningId: 'r-1', deltaContent: 'thinking' }));
    expect(parts).toEqual([
      { type: 'reasoning-start', id: 'r-1' },
      { type: 'reasoning-delta', id: 'r-1', delta: 'thinking' },
    ]);
  });

  it('emits a bare reasoning delta once the block is already open', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(reasoningDeltaEvent({ id: 'evt-1', reasoningId: 'r-1', deltaContent: 'thinking' }));
    const parts = bridge.handle(reasoningDeltaEvent({ id: 'evt-2', reasoningId: 'r-1', deltaContent: ' more' }));
    expect(parts).toEqual([{ type: 'reasoning-delta', id: 'r-1', delta: ' more' }]);
  });
});

describe('createCopilotEventStreamBridge: reasoning lifecycle closing', () => {
  it('closes the reasoning block on the finalized assistant.reasoning event', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(reasoningDeltaEvent({ id: 'evt-1', reasoningId: 'r-1', deltaContent: 'thinking' }));
    const parts = bridge.handle(reasoningEvent({ id: 'evt-2', reasoningId: 'r-1', content: 'thinking done' }));
    expect(parts).toEqual([{ type: 'reasoning-end', id: 'r-1' }]);
  });

  it('brackets a reasoning block that finalizes with no prior delta', () => {
    const bridge = createCopilotEventStreamBridge();
    const parts = bridge.handle(reasoningEvent({ id: 'evt-1', reasoningId: 'r-2', content: 'instant' }));
    expect(parts).toEqual([
      { type: 'reasoning-start', id: 'r-2' },
      { type: 'reasoning-delta', id: 'r-2', delta: 'instant' },
      { type: 'reasoning-end', id: 'r-2' },
    ]);
  });
});

describe('createCopilotEventStreamBridge: tool input streaming', () => {
  it('opens a tool-input block on the first assistant.tool_call_delta for a tool call id', () => {
    const bridge = createCopilotEventStreamBridge();
    const parts = bridge.handle(
      toolCallDeltaEvent({ id: 'evt-1', toolCallId: 'call-1', toolName: 'Read', inputDelta: '{"path":' }),
    );
    expect(parts).toEqual([
      { type: 'tool-input-start', id: 'call-1', toolName: 'Read' },
      { type: 'tool-input-delta', id: 'call-1', delta: '{"path":' },
    ]);
  });

  it('emits a bare tool-input delta once the call is already open', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(toolCallDeltaEvent({ id: 'evt-1', toolCallId: 'call-1', toolName: 'Read', inputDelta: '{"path":' }));
    const parts = bridge.handle(toolCallDeltaEvent({ id: 'evt-2', toolCallId: 'call-1', inputDelta: '"a.txt"}' }));
    expect(parts).toEqual([{ type: 'tool-input-delta', id: 'call-1', delta: '"a.txt"}' }]);
  });
});

describe('createCopilotEventStreamBridge: finalized tool calls', () => {
  it('closes tool-input and emits a tool-call part per finalized toolRequest', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(messageStartEvent({ id: 'evt-1', messageId: 'msg-1' }));
    bridge.handle(toolCallDeltaEvent({ id: 'evt-2', toolCallId: 'call-1', toolName: 'Read', inputDelta: '{"path":"a.txt"}' }));
    const parts = bridge.handle(
      messageEvent({
        id: 'evt-3',
        messageId: 'msg-1',
        content: '',
        toolRequests: [{ toolCallId: 'call-1', name: 'Read', arguments: { path: 'a.txt' } }],
      }),
    );
    expect(parts).toEqual([
      { type: 'text-end', id: 'msg-1' },
      { type: 'tool-input-end', id: 'call-1' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'Read', input: '{"path":"a.txt"}' },
      expect.objectContaining({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' } }),
    ]);
  });
});

describe('createCopilotEventStreamBridge: finalized tool call argument edge cases', () => {
  it('serializes a finalized tool call with no arguments as an empty JSON object', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(messageStartEvent({ id: 'evt-1', messageId: 'msg-1' }));
    const parts = bridge.handle(
      messageEvent({
        id: 'evt-2',
        messageId: 'msg-1',
        content: '',
        toolRequests: [{ toolCallId: 'call-2', name: 'Bash' }],
      }),
    );
    expect(parts).toContainEqual({ type: 'tool-call', toolCallId: 'call-2', toolName: 'Bash', input: '{}' });
  });

  it('emits one tool-call part per parallel finalized toolRequest, in order', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(messageStartEvent({ id: 'evt-1', messageId: 'msg-1' }));
    const parts = bridge.handle(
      messageEvent({
        id: 'evt-2',
        messageId: 'msg-1',
        content: '',
        toolRequests: [
          { toolCallId: 'call-1', name: 'Read', arguments: { path: 'a.txt' } },
          { toolCallId: 'call-2', name: 'Grep', arguments: { pattern: 'x' } },
        ],
      }),
    );
    expect(parts).toEqual([
      { type: 'text-end', id: 'msg-1' },
      { type: 'tool-input-start', id: 'call-1', toolName: 'Read' },
      { type: 'tool-input-end', id: 'call-1' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'Read', input: '{"path":"a.txt"}' },
      { type: 'tool-input-start', id: 'call-2', toolName: 'Grep' },
      { type: 'tool-input-end', id: 'call-2' },
      { type: 'tool-call', toolCallId: 'call-2', toolName: 'Grep', input: '{"pattern":"x"}' },
      expect.objectContaining({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' } }),
    ]);
  });
});

describe('createCopilotEventStreamBridge: tool-call finish boundary', () => {
  it('finishes with tool-calls when the finalized request follows usage', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(messageStartEvent({ id: 'evt-1', messageId: 'msg-1' }));
    bridge.handle(usageEvent({
      id: 'evt-2',
      model: 'copilot-gpt-5',
      inputTokens: 10,
      outputTokens: 3,
      finishReason: 'tool_calls',
    }));

    const parts = bridge.handle(messageEvent({
      id: 'evt-3',
      messageId: 'msg-1',
      content: '',
      toolRequests: [{ toolCallId: 'call-1', name: 'Read', arguments: { path: 'a.txt' } }],
    }));

    expect(parts.at(-1)).toEqual(expect.objectContaining({
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    }));
    expect(bridge.closed).toBe(true);
  });
});

describe('createCopilotEventStreamBridge: usage accounting', () => {
  it('folds non-terminal assistant.usage into state without emitting a stream part', () => {
    const bridge = createCopilotEventStreamBridge();
    const parts = bridge.handle(usageEvent({ id: 'evt-1', model: 'copilot-gpt-5', inputTokens: 1200, outputTokens: 340 }));
    expect(parts).toEqual([]);
  });

  it('maps disjoint input, cache-read, and cache-write counters onto the next finish', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(
      usageEvent({
        id: 'evt-1',
        model: 'copilot-gpt-5',
        inputTokens: 1200,
        cacheReadTokens: 200,
        cacheWriteTokens: 50,
        finishReason: 'stop',
      }),
    );
    const parts = bridge.handle(turnEndEvent({ id: 'evt-2', turnId: 'turn-1' }));
    expect(parts).toEqual([
      {
        type: 'finish',
        usage: {
          inputTokens: { total: 1200, noCache: 1000, cacheRead: 200, cacheWrite: 50 },
          outputTokens: { total: undefined, text: undefined, reasoning: undefined },
        },
        finishReason: { unified: 'stop', raw: 'stop' },
      },
    ]);
  });
});

describe('createCopilotEventStreamBridge: usage accounting output and defaults', () => {
  it('maps disjoint text-output and reasoning-output counters onto the next finish', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(
      usageEvent({ id: 'evt-1', model: 'copilot-gpt-5', outputTokens: 340, reasoningTokens: 90, finishReason: 'stop' }),
    );
    const parts = bridge.handle(turnEndEvent({ id: 'evt-2', turnId: 'turn-1' }));
    expect(parts).toEqual([
      {
        type: 'finish',
        usage: {
          inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 340, text: 250, reasoning: 90 },
        },
        finishReason: { unified: 'stop', raw: 'stop' },
      },
    ]);
  });

  it('reports a fully undefined usage when no assistant.usage preceded the terminal event', () => {
    const bridge = createCopilotEventStreamBridge();
    const parts = bridge.handle(turnEndEvent({ id: 'evt-1', turnId: 'turn-1' }));
    expect(parts).toEqual([
      {
        type: 'finish',
        usage: {
          inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: undefined, text: undefined, reasoning: undefined },
        },
        finishReason: { unified: 'other', raw: undefined },
      },
    ]);
  });
});

describe('createCopilotEventStreamBridge: finish reason mapping at turn end', () => {
  it.each([
    ['tool_calls', 'tool-calls'],
    ['stop', 'stop'],
    ['length', 'length'],
    ['content_filter', 'content-filter'],
    ['refusal', 'other'],
  ] as const)('maps assistant.usage.finishReason %s to unified %s', (raw, unified) => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(usageEvent({ id: 'evt-1', model: 'copilot-gpt-5', finishReason: raw }));
    const parts = bridge.handle(turnEndEvent({ id: 'evt-2', turnId: 'turn-1' }));
    expect(parts).toHaveLength(1);
    const finish = parts[0];
    if (finish.type !== 'finish') throw new Error('expected finish part');
    expect(finish.finishReason).toEqual({ unified, raw });
  });

  it('closes the bridge on assistant.turn_end', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(turnEndEvent({ id: 'evt-1', turnId: 'turn-1' }));
    expect(bridge.closed).toBe(true);
  });
});

describe('createCopilotEventStreamBridge: idle as an alternate terminal boundary', () => {
  it('emits finish and closes on assistant.idle when no turn_end preceded it', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(usageEvent({ id: 'evt-1', model: 'copilot-gpt-5', inputTokens: 10, outputTokens: 5, finishReason: 'stop' }));
    const parts = bridge.handle(idleEvent({ id: 'evt-2' }));
    expect(parts).toEqual([
      {
        type: 'finish',
        usage: {
          inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: undefined, reasoning: undefined },
        },
        finishReason: { unified: 'stop', raw: 'stop' },
      },
    ]);
    expect(bridge.closed).toBe(true);
  });
});

describe('createCopilotEventStreamBridge: session.error', () => {
  it('emits a redacted error part and closes the bridge', () => {
    const bridge = createCopilotEventStreamBridge();
    const parts = bridge.handle(
      sessionErrorEvent({ id: 'evt-1', errorType: 'rate_limit', message: 'redacted-upstream-rate-limit', statusCode: 429 }),
    );
    expect(parts).toEqual([
      { type: 'error', error: { errorType: 'rate_limit', message: 'redacted-upstream-rate-limit', statusCode: 429 } },
    ]);
    expect(bridge.closed).toBe(true);
  });
});

describe('createCopilotEventStreamBridge: abort', () => {
  it('emits a finish part with an "other" unified reason carrying the abort reason', () => {
    const bridge = createCopilotEventStreamBridge();
    const parts = bridge.handle(abortEvent({ id: 'evt-1', reason: 'user_initiated' }));
    expect(parts).toEqual([
      {
        type: 'finish',
        usage: {
          inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: undefined, text: undefined, reasoning: undefined },
        },
        finishReason: { unified: 'other', raw: 'abort:user_initiated' },
      },
    ]);
    expect(bridge.closed).toBe(true);
  });
});

describe('createCopilotEventStreamBridge: subagent event exclusion', () => {
  it('returns no parts for a message_delta carrying an agentId', () => {
    const bridge = createCopilotEventStreamBridge();
    const parts = bridge.handle(
      messageDeltaEvent({ id: 'evt-1', messageId: 'sub-msg', deltaContent: 'from a subagent', agentId: 'agent-2' }),
    );
    expect(parts).toEqual([]);
  });

  it('returns no parts for a tool_call_delta carrying an agentId', () => {
    const bridge = createCopilotEventStreamBridge();
    const parts = bridge.handle(
      toolCallDeltaEvent({ id: 'evt-1', toolCallId: 'sub-call', inputDelta: '{}', agentId: 'agent-2' }),
    );
    expect(parts).toEqual([]);
  });

  it('does not close the bridge on a subagent turn_end', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(turnEndEvent({ id: 'evt-1', turnId: 'sub-turn', agentId: 'agent-2' }));
    expect(bridge.closed).toBe(false);
  });

  it('keeps excluding subagent events even after the root bridge has closed', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(turnEndEvent({ id: 'evt-1', turnId: 'turn-1' }));
    const parts = bridge.handle(messageDeltaEvent({ id: 'evt-2', messageId: 'sub-msg', deltaContent: 'late', agentId: 'agent-2' }));
    expect(parts).toEqual([]);
  });
});

describe('createCopilotEventStreamBridge: duplicate terminal event rejection', () => {
  it('throws when a second terminal event arrives after turn_end', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(turnEndEvent({ id: 'evt-1', turnId: 'turn-1' }));
    expect(() => bridge.handle(idleEvent({ id: 'evt-2' }))).toThrow(CopilotEventStreamClosedError);
  });

  it('throws when a second terminal event arrives after session.error', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(sessionErrorEvent({ id: 'evt-1', errorType: 'internal', message: 'redacted' }));
    expect(() => bridge.handle(turnEndEvent({ id: 'evt-2', turnId: 'turn-1' }))).toThrow(CopilotEventStreamClosedError);
  });

  it('throws for any further root-agent event once aborted', () => {
    const bridge = createCopilotEventStreamBridge();
    bridge.handle(abortEvent({ id: 'evt-1', reason: 'user_initiated' }));
    expect(() => bridge.handle(messageStartEvent({ id: 'evt-2', messageId: 'msg-late' }))).toThrow(
      CopilotEventStreamClosedError,
    );
  });
});
