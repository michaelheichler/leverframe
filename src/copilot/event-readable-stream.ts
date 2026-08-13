/**
 * Owns the cancellable ReadableStream adapter for callback-backed Copilot events.
 * Closing a V3 response returns the source iterator and releases its session listener.
 */

import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import {
  createCopilotEventStreamBridge,
  type CopilotSessionEvent,
} from './event-stream.js';

async function pumpEvents(input: {
  iterator: AsyncIterator<CopilotSessionEvent>;
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>;
  cancelled: () => boolean;
  close: () => Promise<void>;
}): Promise<void> {
  const bridge = createCopilotEventStreamBridge();
  try {
    while (!input.cancelled()) {
      const next = await input.iterator.next();
      if (next.done || input.cancelled()) break;
      for (const part of bridge.handle(next.value)) input.controller.enqueue(part);
      if (bridge.closed) break;
    }
    if (!input.cancelled()) input.controller.close();
  } catch (error) {
    if (!input.cancelled()) input.controller.error(error);
  } finally {
    await input.close();
  }
}

/** Streams mapped events and returns the source iterator at every terminal boundary. */
export function bridgeCopilotSessionEvents(
  events: AsyncIterable<CopilotSessionEvent>,
): ReadableStream<LanguageModelV3StreamPart> {
  const iterator = events[Symbol.asyncIterator]();
  let cancelled = false;
  let returned = false;
  const close = async (): Promise<void> => {
    if (returned) return;
    returned = true;
    await iterator.return?.();
  };
  return new ReadableStream({
    start(controller) {
      void pumpEvents({ iterator, controller, cancelled: () => cancelled, close });
    },
    async cancel() {
      cancelled = true;
      await close();
    },
  });
}
