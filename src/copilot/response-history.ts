import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { v3History } from './prompt.js';
import type { TranscriptComparisonState } from './transcript.js';

type AssistantContent = Extract<LanguageModelV3Prompt[number], { role: 'assistant' }>['content'];

export function comparisonWithResponse(
  comparison: TranscriptComparisonState,
  parts: readonly LanguageModelV3StreamPart[],
): TranscriptComparisonState {
  const content: AssistantContent = [];
  const blocks = new Map<string, { type: 'text' | 'reasoning'; text: string }>();
  for (const part of parts) {
    if (part.type === 'text-start' || part.type === 'reasoning-start') {
      const block = { type: part.type === 'text-start' ? 'text' as const : 'reasoning' as const, text: '' };
      blocks.set(`${block.type}:${part.id}`, block);
      content.push(block);
    } else if (part.type === 'text-delta' || part.type === 'reasoning-delta') {
      const type = part.type === 'text-delta' ? 'text' : 'reasoning';
      const block = blocks.get(`${type}:${part.id}`);
      if (block === undefined) throw new Error(`Copilot delta for unopened block ${part.id}`);
      block.text += part.delta;
    } else if (part.type === 'tool-call') {
      content.push({ type: 'tool-call', toolCallId: part.toolCallId,
        toolName: part.toolName, input: JSON.parse(part.input) });
    }
  }
  if (content.length === 0) return comparison;
  return { ...comparison, history: { ...comparison.history, entries: [
    ...comparison.history.entries,
    ...v3History([{ role: 'assistant', content }]).entries,
  ] } };
}
