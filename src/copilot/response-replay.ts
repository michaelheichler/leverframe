

import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';

export function recordCopilotResponse(input: {
  stream: ReadableStream<LanguageModelV3StreamPart>;
  onComplete: (parts: readonly LanguageModelV3StreamPart[]) => void;
  onSettled: () => void;
}): ReadableStream<LanguageModelV3StreamPart> {
  const reader = input.stream.getReader();
  const parts: LanguageModelV3StreamPart[] = [];
  let settled = false;
  let cancelled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    input.onSettled();
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (settled || cancelled) return;
        if (next.done) {
          const terminal = parts.at(-1);
          if (!parts.some(part => part.type === 'error') && terminal?.type === 'finish'
            && terminal.finishReason.unified !== 'error'
            && terminal.finishReason.unified !== 'other') {
            input.onComplete(Object.freeze([...parts]));
          }
          settle();
          controller.close();
          return;
        }
        parts.push(next.value);
        controller.enqueue(next.value);
      } catch (error) {
        if (settled || cancelled) return;
        settle();
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      try { await reader.cancel(reason); }
      finally { settle(); }
    },
  });
}

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
