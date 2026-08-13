import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { bridgeCopilotSessionEvents } from '../src/copilot/event-readable-stream.js';
import {
  idleEvent,
  messageDeltaEvent,
  messageEvent,
  messageStartEvent,
  sessionErrorEvent,
  turnEndEvent,
  usageEvent,
  type FixtureSessionEvent,
} from './fixtures/copilot-session-events.js';

async function* toAsyncIterable(events: FixtureSessionEvent[]): AsyncGenerator<FixtureSessionEvent> {
  for (const event of events) yield event;
}

async function collect(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3StreamPart[]> {
  const reader = stream.getReader();
  const parts: LanguageModelV3StreamPart[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

describe('bridgeCopilotSessionEvents stream lifecycle', () => {
  it('streams root-agent V3 parts in order and closes once', async () => {
    const events: FixtureSessionEvent[] = [
      messageStartEvent({ id: 'evt-1', messageId: 'msg-1' }),
      messageDeltaEvent({ id: 'evt-2', messageId: 'msg-1', deltaContent: 'hi' }),
      messageEvent({ id: 'evt-3', messageId: 'msg-1', content: 'hi' }),
      usageEvent({
        id: 'evt-4',
        model: 'copilot-gpt-5',
        inputTokens: 3,
        outputTokens: 1,
        finishReason: 'stop',
      }),
      turnEndEvent({ id: 'evt-5', turnId: 'turn-1' }),
    ];

    const parts = await collect(bridgeCopilotSessionEvents(toAsyncIterable(events)));

    expect(parts.map(part => part.type)).toEqual([
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);
    expect(parts.at(-1)).toEqual({
      type: 'finish',
      usage: {
        inputTokens: { total: 3, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: undefined, reasoning: undefined },
      },
      finishReason: { unified: 'stop', raw: 'stop' },
    });
  });

  it('drops a duplicate terminal event without duplicating finish', async () => {
    const events: FixtureSessionEvent[] = [
      turnEndEvent({ id: 'evt-1', turnId: 'turn-1' }),
      idleEvent({ id: 'evt-2' }),
    ];

    const parts = await collect(bridgeCopilotSessionEvents(toAsyncIterable(events)));

    expect(parts.filter(part => part.type === 'finish')).toHaveLength(1);
  });
});

describe('bridgeCopilotSessionEvents source cleanup', () => {
  it('returns the source iterator after a terminal event', async () => {
    let returnCalls = 0;
    let delivered = false;
    const iterator: AsyncIterator<FixtureSessionEvent> = {
      next: async () => {
        if (delivered) return { done: true, value: undefined };
        delivered = true;
        return {
          done: false,
          value: turnEndEvent({ id: 'evt-1', turnId: 'turn-1' }),
        };
      },
      return: async () => {
        returnCalls += 1;
        return { done: true, value: undefined };
      },
    };
    const events: AsyncIterable<FixtureSessionEvent> = {
      [Symbol.asyncIterator]: () => iterator,
    };

    await collect(bridgeCopilotSessionEvents(events));

    expect(returnCalls).toBe(1);
  });
});

describe('bridgeCopilotSessionEvents cancellation', () => {
  it('returns the source iterator when the consumer disconnects', async () => {
    let releaseNext = (_value: IteratorResult<FixtureSessionEvent>): void => undefined;
    const next = new Promise<IteratorResult<FixtureSessionEvent>>(resolve => {
      releaseNext = resolve;
    });
    let returnCalls = 0;
    const iterator: AsyncIterator<FixtureSessionEvent> = {
      next: () => next,
      return: async () => {
        returnCalls += 1;
        releaseNext({ done: true, value: undefined });
        return { done: true, value: undefined };
      },
    };
    const events: AsyncIterable<FixtureSessionEvent> = {
      [Symbol.asyncIterator]: () => iterator,
    };
    const reader = bridgeCopilotSessionEvents(events).getReader();

    const cancelling = reader.cancel('disconnect');
    await Promise.resolve();
    const callsBeforeSourceRelease = returnCalls;
    releaseNext({ done: true, value: undefined });
    await cancelling;

    expect(callsBeforeSourceRelease).toBe(1);
  });
});

describe('bridgeCopilotSessionEvents filtering and errors', () => {
  it('emits session.error without a following finish', async () => {
    const events: FixtureSessionEvent[] = [
      sessionErrorEvent({ id: 'evt-1', errorType: 'internal', message: 'redacted-failure' }),
    ];

    const parts = await collect(bridgeCopilotSessionEvents(toAsyncIterable(events)));

    expect(parts).toEqual([{
      type: 'error',
      error: {
        errorType: 'internal',
        message: 'redacted-failure',
        statusCode: undefined,
      },
    }]);
  });

  it('excludes subagent events and closes on the root turn end', async () => {
    const events: FixtureSessionEvent[] = [
      messageStartEvent({ id: 'evt-1', messageId: 'sub-msg', agentId: 'agent-2' }),
      messageDeltaEvent({
        id: 'evt-2',
        messageId: 'sub-msg',
        deltaContent: 'subagent chatter',
        agentId: 'agent-2',
      }),
      turnEndEvent({ id: 'evt-3', turnId: 'turn-1' }),
    ];

    const parts = await collect(bridgeCopilotSessionEvents(toAsyncIterable(events)));

    expect(parts.map(part => part.type)).toEqual(['finish']);
  });
});
