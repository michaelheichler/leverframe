/**
 * Converts AI SDK prompts into versioned, privacy-safe transcript fingerprints.
 * Tool arguments and result bodies are intentionally excluded from serialized history.
 */

import { createHash } from 'node:crypto';
import type { LanguageModelV3Prompt } from '@ai-sdk/provider';
import type { ModelMessage } from 'ai';
import { canonicalJson } from './canonical-json.js';
import { copilotImageReference } from './image-part.js';
import { renderCopilotHistory as renderHistory } from './history-renderer.js';

export const SERIALIZED_HISTORY_VERSION = 1;

export type SerializedHistoryRole = 'system' | 'user' | 'assistant' | 'tool';

export type SerializedHistoryPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; reference: string; mediaType: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; payloadHash: string }
  | {
      type: 'tool-result';
      toolCallId: string;
      toolName: string;
      status: 'ok' | 'error';
      payloadHash: string;
    };

export interface SerializedHistoryEntry {
  role: SerializedHistoryRole;
  parts: readonly SerializedHistoryPart[];
}

export interface SerializedHistory {
  version: number;
  entries: readonly SerializedHistoryEntry[];
}

export class UnsupportedContentError extends Error {
  readonly messageIndex: number;
  readonly partType: string;

  constructor(messageIndex: number, partType: string) {
    super(`Copilot does not support ${partType} content at message index ${messageIndex}`);
    this.name = 'UnsupportedContentError';
    this.messageIndex = messageIndex;
    this.partType = partType;
  }
}

type PromptPart = {
  type?: unknown;
  text?: unknown;
  image?: unknown;
  data?: unknown;
  mediaType?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  output?: unknown;
  input?: unknown;
};

function requireString(value: unknown, field: string, messageIndex: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new UnsupportedContentError(messageIndex, field);
  }
  return value;
}

function requireText(value: unknown, field: string, messageIndex: number): string {
  if (typeof value !== 'string') throw new UnsupportedContentError(messageIndex, field);
  return value;
}

function payloadHash(value: unknown, messageIndex: number, partType: string): string {
  try {
    return createHash('sha256').update(canonicalJson(value)).digest('hex');
  } catch {
    throw new UnsupportedContentError(messageIndex, partType);
  }
}

/** Stores only non-secret HTTP location identity, never URL credentials or signed queries. */

function urlReference(value: unknown): string | undefined {
  const candidate = value instanceof URL
    ? value
    : typeof value === 'string' && /^https?:\/\//.test(value)
      ? new URL(value)
      : value !== null
        && typeof value === 'object'
        && (value as Record<string, unknown>).type === 'url'
        ? (value as Record<string, unknown>).url
        : undefined;
  const url = candidate instanceof URL
    ? candidate
    : typeof candidate === 'string' && /^https?:\/\//.test(candidate)
      ? new URL(candidate)
      : undefined;
  if (
    url === undefined
    || !['http:', 'https:'].includes(url.protocol)
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
  ) return undefined;
  return url.href;
}

function serializeToolResult(part: PromptPart, messageIndex: number): SerializedHistoryPart {
  const output = part.output;
  if (output === null || typeof output !== 'object') {
    throw new UnsupportedContentError(messageIndex, 'tool-result');
  }
  const outputType = (output as Record<string, unknown>).type;
  const successfulTypes = new Set(['text', 'json', 'content']);
  const errorTypes = new Set(['error-text', 'error-json', 'execution-denied']);
  if (typeof outputType !== 'string' || !successfulTypes.has(outputType) && !errorTypes.has(outputType)) {
    throw new UnsupportedContentError(messageIndex, 'tool-result output');
  }
  return {
    type: 'tool-result',
    toolCallId: requireString(part.toolCallId, 'tool-result id', messageIndex),
    toolName: requireString(part.toolName, 'tool-result name', messageIndex),
    status: errorTypes.has(outputType) ? 'error' : 'ok',
    payloadHash: payloadHash(output, messageIndex, 'tool-result output'),
  };
}

function serializePart(part: PromptPart, messageIndex: number): SerializedHistoryPart {
  if (part.type === 'text') {
    return { type: 'text', text: requireText(part.text, 'text', messageIndex) };
  }
  if (part.type === 'reasoning') {
    return { type: 'reasoning', text: requireText(part.text, 'reasoning', messageIndex) };
  }
  if (part.type === 'tool-call') {
    return {
      type: 'tool-call',
      toolCallId: requireString(part.toolCallId, 'tool-call id', messageIndex),
      toolName: requireString(part.toolName, 'tool-call name', messageIndex),
      payloadHash: payloadHash(
        part.input,
        messageIndex,
        'tool-call input',
      ),
    };
  }
  if (part.type === 'tool-result') return serializeToolResult(part, messageIndex);
  if (part.type === 'image') {
    const reference = urlReference(part.image);
    if (reference === undefined) throw new UnsupportedContentError(messageIndex, 'raw image');
    return {
      type: 'image',
      reference,
      mediaType: typeof part.mediaType === 'string' ? part.mediaType : 'image',
    };
  }
  if (part.type === 'file') {
    if (typeof part.mediaType !== 'string') {
      throw new UnsupportedContentError(messageIndex, 'file');
    }
    const remote = urlReference(part.data);
    if (remote !== undefined) {
      if (part.mediaType !== 'image' && !part.mediaType.startsWith('image/')) {
        throw new UnsupportedContentError(messageIndex, 'file');
      }
      return { type: 'image', reference: remote, mediaType: part.mediaType };
    }
    try {
      const image = copilotImageReference(part.data, part.mediaType);
      return { type: 'image', reference: image.reference, mediaType: image.mediaType };
    } catch {
      throw new UnsupportedContentError(messageIndex, 'file');
    }
  }
  throw new UnsupportedContentError(messageIndex, String(part.type ?? 'unknown'));
}

function messageParts(message: ModelMessage, messageIndex: number): SerializedHistoryPart[] {
  if (typeof message.content === 'string') {
    return [{ type: 'text', text: message.content }];
  }
  if (!Array.isArray(message.content)) {
    throw new UnsupportedContentError(messageIndex, 'content');
  }
  return message.content.map(part => serializePart(part as PromptPart, messageIndex));
}

/** Serializes supported prompt structure without retaining tool payloads. */
export function serializeHistory(messages: readonly ModelMessage[]): SerializedHistory {
  return {
    version: SERIALIZED_HISTORY_VERSION,
    entries: messages.map((message, messageIndex) => ({
      role: message.role,
      parts: messageParts(message, messageIndex),
    })),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Renders full prior history when a new isolated session must be synchronized. */
export function renderCopilotHistory(prompt: LanguageModelV3Prompt): string {
  return renderHistory(prompt, SERIALIZED_HISTORY_VERSION);
}

/** Builds a stable rolling hash for every transcript prefix. */
export function historyPrefixHashes(history: SerializedHistory): readonly string[] {
  const hashes: string[] = [sha256(`history-v${history.version}`)];
  for (const entry of history.entries) {
    hashes.push(sha256(`${hashes.at(-1)}\0${canonicalJson(entry)}`));
  }
  return hashes;
}
