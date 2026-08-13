/**
 * Derives deterministic Copilot session identity and transcript transition decisions.
 * Resync diagnostics expose only stable reason codes, never prompt or tool payloads.
 */

import { createHash } from 'node:crypto';
import type { ModelMessage } from 'ai';
import { canonicalJson } from './canonical-json.js';
import {
  historyPrefixHashes,
  serializeHistory,
  type SerializedHistory,
} from './serialized-history.js';

export interface CopilotToolSchema {
  name: string;
  description: string | null;
  inputSchemaJson: unknown;
}

export interface CopilotSessionKeyInput {
  claudeSessionId: string;
  upstreamModel: string;
  reasoningEffort: string | null;
  systemPromptHash: string;
  toolSchemaHash: string;
}

export interface NormalizedPrompt {
  systemPrompt: string;
  systemPromptHash: string;
  history: SerializedHistory;
}

export interface TranscriptComparisonState {
  upstreamModel: string;
  reasoningEffort: string | null;
  systemPromptHash: string;
  toolSchemaHash: string;
  history: SerializedHistory;
}

export type ResyncReason =
  | 'cold-restart'
  | 'model-changed'
  | 'tool-schema-changed'
  | 'system-prompt-changed'
  | 'rewind'
  | 'compaction'
  | 'branch';

export type TranscriptDecision =
  | { kind: 'new-turn' }
  | { kind: 'exact-retry' }
  | { kind: 'tool-result-continuation'; resolvedToolCallIds: readonly string[] }
  | { kind: 'resync'; reason: ResyncReason };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Hashes the normalized system instruction exactly as sent. */
export function hashSystemPrompt(systemPrompt: string): string {
  return sha256(canonicalJson({ systemPrompt }));
}

/** Hashes tool schemas independently of tool and object-key order. */
export function hashToolSchema(tools: readonly CopilotToolSchema[]): string {
  const sorted = [...tools].sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ));
  return sha256(canonicalJson(sorted));
}

/** Derives a session partition key from every behavior-affecting component. */
export function deriveCopilotSessionKey(input: CopilotSessionKeyInput): string {
  return sha256(canonicalJson(input));
}

/** Separates system messages and serializes the remaining immutable history. */
export function normalizePrompt(messages: readonly ModelMessage[]): NormalizedPrompt {
  const systemPrompt = messages
    .filter(message => message.role === 'system')
    .map(message => message.content)
    .join('\n\n');
  const conversation = messages.filter(message => message.role !== 'system');
  return {
    systemPrompt,
    systemPromptHash: hashSystemPrompt(systemPrompt),
    history: serializeHistory(conversation),
  };
}

function sameSessionConfiguration(
  previous: TranscriptComparisonState,
  current: TranscriptComparisonState,
): TranscriptDecision | undefined {
  if (
    previous.upstreamModel !== current.upstreamModel
    || previous.reasoningEffort !== current.reasoningEffort
  ) {
    return { kind: 'resync', reason: 'model-changed' };
  }
  if (previous.toolSchemaHash !== current.toolSchemaHash) {
    return { kind: 'resync', reason: 'tool-schema-changed' };
  }
  if (previous.systemPromptHash !== current.systemPromptHash) {
    return { kind: 'resync', reason: 'system-prompt-changed' };
  }
  return undefined;
}

function toolResultIds(history: SerializedHistory, fromIndex: number): string[] | undefined {
  const appended = history.entries.slice(fromIndex);
  if (appended.length === 0 || appended.some(entry => entry.role !== 'tool')) return undefined;
  const ids = appended.flatMap(entry => entry.parts.flatMap(part => (
    part.type === 'tool-result' ? [part.toolCallId] : []
  )));
  return ids.length > 0 ? ids : undefined;
}

/** Classifies one immutable request against the previous session transcript. */
export function classifyTranscript(
  previous: TranscriptComparisonState | null,
  current: TranscriptComparisonState,
): TranscriptDecision {
  if (previous === null) return { kind: 'resync', reason: 'cold-restart' };
  const configurationChange = sameSessionConfiguration(previous, current);
  if (configurationChange !== undefined) return configurationChange;

  const previousHashes = historyPrefixHashes(previous.history);
  const currentHashes = historyPrefixHashes(current.history);
  const previousLength = previous.history.entries.length;
  const currentLength = current.history.entries.length;
  const sharedLength = Math.min(previousLength, currentLength);
  const sharedPrefixMatches = previousHashes[sharedLength] === currentHashes[sharedLength];

  if (currentLength === previousLength && sharedPrefixMatches) return { kind: 'exact-retry' };
  if (currentLength > previousLength && sharedPrefixMatches) {
    const resolvedToolCallIds = toolResultIds(current.history, previousLength);
    return resolvedToolCallIds === undefined
      ? { kind: 'new-turn' }
      : { kind: 'tool-result-continuation', resolvedToolCallIds };
  }
  if (currentLength < previousLength) {
    return sharedPrefixMatches
      ? { kind: 'resync', reason: 'rewind' }
      : { kind: 'resync', reason: 'compaction' };
  }
  return { kind: 'resync', reason: 'branch' };
}
