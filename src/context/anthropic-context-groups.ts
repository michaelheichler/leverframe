import { createHash } from 'node:crypto';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type AnthropicContent = string | JsonValue[];

export interface AnthropicMessage {
  role: 'user' | 'assistant' | 'system' | string;
  content: AnthropicContent;
  [key: string]: JsonValue | undefined;
}

export interface ContextDiagnostic {
  code: 'duplicate_tool_id' | 'duplicate_tool_result' | 'orphan_tool_result' | 'overlapping_tool_result' | 'unresolved_tool_call' | 'wrong_role_tool_use' | 'wrong_role_tool_result' | 'malformed_block';
  messageIndex: number;
  blockIndex?: number;
  toolId?: string;
  compactable: false;
}

export interface ContextGroupView {
  kind: 'system' | 'message' | 'tool_pair';
  sourceDigest: string;
  messageIndexes: readonly number[];
  messages: readonly AnthropicMessage[];
  compactable: boolean;
}

export interface AnthropicContextGroups {
  system: readonly AnthropicMessage[];
  groups: readonly ContextGroupView[];
  diagnostics: readonly ContextDiagnostic[];
}

const DIGEST_PREFIX = 'lfctx1_';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function cloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    const copy = value.map(item => cloneAndFreeze(item));
    return Object.freeze(copy) as T;
  }
  if (isRecord(value)) {
    const copy = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneAndFreeze(item)]));
    return Object.freeze(copy) as T;
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return `${DIGEST_PREFIX}${createHash('sha256').update(stableJson(value), 'utf8').digest('hex')}`;
}

function messageBlocks(message: AnthropicMessage): readonly Record<string, unknown>[] | undefined {
  if (!Array.isArray(message.content)) return undefined;
  const blocks: Record<string, unknown>[] = [];
  for (const block of message.content) {
    if (isRecord(block)) blocks.push(block);
  }
  return blocks;
}

function blockType(block: Record<string, unknown>): string | undefined {
  return typeof block.type === 'string' ? block.type : undefined;
}

function toolUseId(block: Record<string, unknown>): string | undefined {
  return typeof block.id === 'string' && block.id.length > 0 ? block.id : undefined;
}

function toolResultId(block: Record<string, unknown>): string | undefined {
  return typeof block.tool_use_id === 'string' && block.tool_use_id.length > 0 ? block.tool_use_id : undefined;
}

function diagnostic(
  code: ContextDiagnostic['code'],
  messageIndex: number,
  blockIndex: number | undefined,
  toolId: string | undefined,
): ContextDiagnostic {
  return { code, messageIndex, ...(blockIndex === undefined ? {} : { blockIndex }), ...(toolId === undefined ? {} : { toolId }), compactable: false };
}

export function groupAnthropicContext(messages: readonly AnthropicMessage[]): AnthropicContextGroups {
  const source = messages.map(message => cloneAndFreeze(message));
  const system: AnthropicMessage[] = [];
  const groups: ContextGroupView[] = [];
  const diagnostics: ContextDiagnostic[] = [];
  const toolUses = new Map<string, { messageIndex: number; blockIndex: number }>();
  const pairedMessages = new Set<number>();
  const pairedToolUses = new Set<string>();

  for (let messageIndex = 0; messageIndex < source.length; messageIndex += 1) {
    const message = source[messageIndex];
    if (message.role === 'system') {
      system.push(message);
      continue;
    }
    const blocks = messageBlocks(message);
    if (Array.isArray(message.content)) {
      message.content.forEach((block, blockIndex) => {
        if (!isRecord(block) || typeof blockType(block) !== 'string') {
          diagnostics.push(diagnostic('malformed_block', messageIndex, blockIndex, undefined));
          return;
        }
        if (blockType(block) === 'tool_use') {
          const id = toolUseId(block);
          if (!id) {
            diagnostics.push(diagnostic('malformed_block', messageIndex, blockIndex, undefined));
          } else if (message.role !== 'assistant') {
            diagnostics.push(diagnostic('wrong_role_tool_use', messageIndex, blockIndex, id));
          } else if (toolUses.has(id)) {
            diagnostics.push(diagnostic('duplicate_tool_id', messageIndex, blockIndex, id));
          } else {
            toolUses.set(id, { messageIndex, blockIndex });
          }
        } else if (blockType(block) === 'tool_result') {
          const id = toolResultId(block);
          if (!id) {
            diagnostics.push(diagnostic('malformed_block', messageIndex, blockIndex, undefined));
          } else if (message.role !== 'user') {
            diagnostics.push(diagnostic('wrong_role_tool_result', messageIndex, blockIndex, id));
          }
        }
      });
    }
    if (!blocks && typeof message.content !== 'string') {
      diagnostics.push(diagnostic('malformed_block', messageIndex, undefined, undefined));
    }
  }

  for (let messageIndex = 0; messageIndex < source.length; messageIndex += 1) {
    const message = source[messageIndex];
    if (message.role === 'system' || pairedMessages.has(messageIndex)) continue;
    const blocks = messageBlocks(message);
    const resultIds = message.role === 'user' ? blocks?.flatMap(block => blockType(block) === 'tool_result' ? [toolResultId(block)] : []) ?? [] : [];
    const validResultIds = resultIds.filter((id): id is string => id !== undefined);
    const matchingUses = validResultIds.map(id => toolUses.get(id));
    const hasOrphan = validResultIds.some(id => !toolUses.has(id));
    if (hasOrphan) {
      validResultIds.filter(id => !toolUses.has(id)).forEach(id => {
        const blockIndex = blocks?.findIndex(block => blockType(block) === 'tool_result' && toolResultId(block) === id);
        diagnostics.push(diagnostic('orphan_tool_result', messageIndex, blockIndex === -1 ? undefined : blockIndex, id));
      });
    }
    const alreadyPairedIds = validResultIds.filter(id => pairedToolUses.has(id));
    alreadyPairedIds.forEach(id => {
      const blockIndex = blocks?.findIndex(block => blockType(block) === 'tool_result' && toolResultId(block) === id);
      diagnostics.push(diagnostic('duplicate_tool_result', messageIndex, blockIndex === -1 ? undefined : blockIndex, id));
    });
    if (message.role === 'user' && validResultIds.length > 0 && !hasOrphan && alreadyPairedIds.length === 0 && matchingUses.every(Boolean)) {
      const useIndexes = matchingUses.map(use => use!.messageIndex);
      const firstUseIndex = Math.min(...useIndexes);
      const intervalIndexes = Array.from({ length: messageIndex - firstUseIndex + 1 }, (_, offset) => firstUseIndex + offset);
      const validInterval = useIndexes.every(index => index < messageIndex) && new Set(validResultIds).size === validResultIds.length;
      const overlapsPairedMessages = intervalIndexes.some(index => pairedMessages.has(index));
      if (validInterval && !overlapsPairedMessages) {
        const pairMessages = source.slice(firstUseIndex, messageIndex + 1);
        groups.push(Object.freeze({
          kind: 'tool_pair',
          sourceDigest: digest(pairMessages),
          messageIndexes: Object.freeze(intervalIndexes),
          messages: Object.freeze(pairMessages),
          compactable: true,
        }));
        intervalIndexes.forEach(index => pairedMessages.add(index));
        validResultIds.forEach(id => pairedToolUses.add(id));
      } else if (validInterval && overlapsPairedMessages) {
        validResultIds.forEach(id => {
          const blockIndex = blocks?.findIndex(block => blockType(block) === 'tool_result' && toolResultId(block) === id);
          diagnostics.push(diagnostic('overlapping_tool_result', messageIndex, blockIndex === -1 ? undefined : blockIndex, id));
        });
      }
    }
  }

  for (const [id, use] of toolUses) {
    if (!pairedToolUses.has(id)) diagnostics.push(diagnostic('unresolved_tool_call', use.messageIndex, use.blockIndex, id));
  }

  for (let messageIndex = 0; messageIndex < source.length; messageIndex += 1) {
    const message = source[messageIndex];
    if (message.role === 'system' || pairedMessages.has(messageIndex)) continue;
    const compactable = !diagnostics.some(item => item.messageIndex === messageIndex);
    groups.push(Object.freeze({
      kind: 'message',
      sourceDigest: digest([messageIndex, message]),
      messageIndexes: Object.freeze([messageIndex]),
      messages: Object.freeze([message]),
      compactable,
    }));
  }

  groups.sort((left, right) => left.messageIndexes[0] - right.messageIndexes[0]);
  const finalizedGroups = groups.map(group => Object.freeze({
    ...group,
    compactable: group.compactable && !diagnostics.some(item => group.messageIndexes.includes(item.messageIndex)),
  }));
  return Object.freeze({
    system: Object.freeze(system),
    groups: Object.freeze(finalizedGroups),
    diagnostics: Object.freeze(diagnostics.map(item => Object.freeze(item))),
  });
}

export function isJsonShapedAnthropicMessage(value: unknown): value is AnthropicMessage {
  return isRecord(value) && typeof value.role === 'string' && isJsonValue(value.content);
}