/**
 * Collects a V3 stream into the non-streaming result shape.
 * Block IDs keep interleaved text and reasoning content separated.
 */

import type {
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';

interface CollectedBlock {
  type: 'text' | 'reasoning';
  value: string;
}

/** Consumes one complete V3 stream and retains generated content plus terminal metadata. */
export async function collectCopilotGenerateResult(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3GenerateResult> {
  const reader = stream.getReader();
  const blocks = new Map<string, CollectedBlock>();
  const order: string[] = [];
  const immediate: LanguageModelV3Content[] = [];
  let finish: Extract<LanguageModelV3StreamPart, { type: 'finish' }> | undefined;

  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const part = next.value;
    if (part.type === 'text-start' || part.type === 'reasoning-start') {
      blocks.set(part.id, { type: part.type === 'text-start' ? 'text' : 'reasoning', value: '' });
      order.push(part.id);
    } else if (part.type === 'text-delta' || part.type === 'reasoning-delta') {
      const block = blocks.get(part.id);
      if (block === undefined) throw new Error(`V3 delta for unopened block "${part.id}"`);
      block.value += part.delta;
    } else if (part.type === 'tool-call' || part.type === 'file' || part.type === 'source') {
      immediate.push(part);
    } else if (part.type === 'finish') {
      finish = part;
    } else if (part.type === 'error') {
      throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
  }

  if (finish === undefined) throw new Error('Copilot stream ended without a finish part');
  const content: LanguageModelV3Content[] = order.map(id => {
    const block = blocks.get(id);
    if (block === undefined) throw new Error(`Missing generated block "${id}"`);
    return block.type === 'text'
      ? { type: 'text', text: block.value }
      : { type: 'reasoning', text: block.value };
  });
  return {
    content: [...content, ...immediate],
    finishReason: finish.finishReason,
    usage: finish.usage,
    warnings: [],
  };
}
