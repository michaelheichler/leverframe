import { createHash } from 'node:crypto';
import type { ConnectionEntry, ContinuationMatch, JsonObject } from './responses-websocket-types.js';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const out: JsonObject = {};
  for (const key of Object.keys(value as JsonObject).sort()) {
    const child = (value as JsonObject)[key];
    if (child !== undefined) out[key] = canonicalize(child);
  }
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function inputArray(payload: JsonObject): unknown[] {
  return Array.isArray(payload.input) ? payload.input : [];
}

export function normalizeToolCallJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeToolCallJson);
  if (!value || typeof value !== 'object') return value;
  const record = value as JsonObject;
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(record)) out[key] = normalizeToolCallJson(child);

  // Claude re-serializes tool_use input, so whitespace/key order can drift from the original argument string.
  const jsonField = record.type === 'function_call'
    ? 'arguments'
    : record.type === 'custom_tool_call' ? 'input' : undefined;
  if (jsonField && typeof record[jsonField] === 'string') {
    try {
      out[jsonField] = canonicalJson(JSON.parse(record[jsonField] as string));
    } catch {
      // A malformed/non-JSON custom-tool input must still match byte-for-byte.
    }
  }
  return out;
}

export function arraysEqual(left: unknown[], right: unknown[]): boolean {
  return canonicalJson(normalizeToolCallJson(left)) === canonicalJson(normalizeToolCallJson(right));
}

export function conversationItemKind(value: unknown): string {
  if (!value || typeof value !== 'object') return typeof value;
  const record = value as JsonObject;
  if (typeof record.type === 'string') return record.type;
  if (typeof record.role === 'string') return record.role;
  return 'object';
}

export function conversationItemHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(normalizeToolCallJson(value))).digest('hex').slice(0, 16);
}

export function continuationMismatchDetails(entry: ConnectionEntry, payload: JsonObject): Record<string, unknown> {
  const full = inputArray(payload);
  const prefix = [...(entry.requestInput ?? []), ...(entry.expectedAssistant ?? [])];
  const comparable = Math.min(full.length, prefix.length);
  let mismatch = comparable;
  for (let index = 0; index < comparable; index += 1) {
    if (!arraysEqual([full[index]], [prefix[index]])) {
      mismatch = index;
      break;
    }
  }
  const expected = mismatch < prefix.length ? prefix[mismatch] : undefined;
  const actual = mismatch < full.length ? full[mismatch] : undefined;
  return {
    fullItems: full.length,
    expectedPrefixItems: prefix.length,
    firstMismatch: mismatch,
    expectedKind: expected === undefined ? 'none' : conversationItemKind(expected),
    actualKind: actual === undefined ? 'none' : conversationItemKind(actual),
    ...(expected !== undefined ? { expectedHash: conversationItemHash(expected) } : {}),
    ...(actual !== undefined ? { actualHash: conversationItemHash(actual) } : {}),
  };
}

export function continuationMismatchSummary(entry: ConnectionEntry, payload: JsonObject): string {
  const details = continuationMismatchDetails(entry, payload);
  return `full_items=${details.fullItems} expected_prefix_items=${details.expectedPrefixItems} `
    + `first_mismatch=${details.firstMismatch} expected=${details.expectedKind} actual=${details.actualKind}`;
}

export function continuationMatch(entry: ConnectionEntry, payload: JsonObject): ContinuationMatch | undefined {
  if (!entry.responseId || !entry.requestInput || !entry.expectedAssistant) return undefined;
  const full = inputArray(payload);
  const exactPrefix = [...entry.requestInput, ...entry.expectedAssistant];
  if (full.length > exactPrefix.length && arraysEqual(full.slice(0, exactPrefix.length), exactPrefix)) {
    return { delta: full.slice(exactPrefix.length), mode: 'exact' };
  }

  // Claude sometimes omits echoing an OpenAI reasoning item. that item still belongs to previous_response_id.
  const echoedAssistant = entry.expectedAssistant.filter(item => conversationItemKind(item) !== 'reasoning');
  if (echoedAssistant.length === entry.expectedAssistant.length) return undefined;
  const echoablePrefix = [...entry.requestInput, ...echoedAssistant];
  if (full.length <= echoablePrefix.length || !arraysEqual(full.slice(0, echoablePrefix.length), echoablePrefix)) {
    return undefined;
  }
  return { delta: full.slice(echoablePrefix.length), mode: 'omitted_reasoning' };
}
