/**
 * Records only responses fully consumed by the caller.
 * An interrupted stream has no replay entry, so the connector resynchronizes instead.
 */

import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';

/** Records immutable stream parts after the upstream stream closes normally. */
export function recordCopilotResponse(input: {
  stream: ReadableStream<LanguageModelV3StreamPart>;
  onComplete: (parts: readonly LanguageModelV3StreamPart[]) => void;
  onSettled: () => void;
}): ReadableStream<LanguageModelV3StreamPart> {
  const reader = input.stream.getReader();
  const parts: LanguageModelV3StreamPart[] = [];
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          input.onComplete(Object.freeze([...parts]));
          input.onSettled();
          controller.close();
          return;
        }
        parts.push(next.value);
        controller.enqueue(next.value);
      } catch (error) {
        input.onSettled();
        controller.error(error);
      }
    },
    async cancel(reason) {
      input.onSettled();
      await reader.cancel(reason);
    },
  });
}

/** Creates a fresh stream over previously completed immutable parts. */
export function replayCopilotResponse(
  parts: readonly LanguageModelV3StreamPart[],
): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}
