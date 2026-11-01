import { groupAnthropicContext, isJsonShapedAnthropicMessage } from './anthropic-context-groups.js';
import { estimateAnthropicInputTokens } from '../anthropic-endpoints.js';
import type { EvidenceStore } from './evidence-store.js';

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function evidenceText(sessionId: string, reference: string): string {
  return `Leverframe evidence: ${reference}\nRetrieve: leverframe evidence get '${sessionId}' '${reference}'`;
}

export async function reduceDuplicateToolResults<T extends object>(input: { request: T; sessionId: string; store: EvidenceStore; signal: AbortSignal }): Promise<{ request: T; reduced: boolean }> {
  const unchanged = { request: input.request, reduced: false };
  const body = input.request as RecordValue;
  if (input.signal.aborted || !/^[A-Za-z0-9_-]{1,128}$/.test(input.sessionId) || !Array.isArray(body.messages) || !body.messages.every(isJsonShapedAnthropicMessage)) return unchanged;
  try {
    if (groupAnthropicContext(body.messages).diagnostics.length) return unchanged;
    const uses = new Map<string, string>();
    const seen = new Set<string>();
    const replacements: { message: number; block: number; content: string }[] = [];
    for (const [messageIndex, message] of body.messages.entries()) {
      if (!Array.isArray(message.content)) continue;
      for (const [blockIndex, block] of message.content.entries()) {
        if (!record(block)) continue;
        if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && record(block.input)) {
          uses.set(block.id, JSON.stringify([block.name, block.input]));
        }
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string' || typeof block.content !== 'string' || block.is_error === true) continue;
        const use = uses.get(block.tool_use_id);
        if (!use) continue;
        const identity = JSON.stringify([use, block.content]);
        if (seen.has(identity) && Buffer.byteLength(JSON.stringify(block.content)) > Buffer.byteLength(JSON.stringify(evidenceText(input.sessionId, `lfe1_${'0'.repeat(48)}`)))) replacements.push({ message: messageIndex, block: blockIndex, content: block.content });
        else seen.add(identity);
      }
    }
    if (!replacements.length) return unchanged;
    const messages = body.messages.map(message => ({ ...message, content: Array.isArray(message.content) ? [...message.content] : message.content }));
    for (const replacement of replacements) {
      if (input.signal.aborted) return unchanged;
      const reference = await input.store.put(input.sessionId, replacement.content);
      if (input.signal.aborted || !/^lfe1_[a-f0-9]{48}$/.test(reference) || await input.store.get(input.sessionId, reference) !== replacement.content) return unchanged;
      const message = messages[replacement.message]!;
      const blocks = message.content as RecordValue[];
      blocks[replacement.block] = { ...blocks[replacement.block], content: evidenceText(input.sessionId, reference) };
    }
    const request = { ...input.request, messages } as T;
    if (input.signal.aborted || Buffer.byteLength(JSON.stringify(request)) >= Buffer.byteLength(JSON.stringify(input.request))) return unchanged;
    if (estimateAnthropicInputTokens(request) >= estimateAnthropicInputTokens(input.request)) return unchanged;
    if (groupAnthropicContext(messages).diagnostics.length) return unchanged;
    return { request, reduced: true };
  } catch {
    return unchanged;
  }
}
