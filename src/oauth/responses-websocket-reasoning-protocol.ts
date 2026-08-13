import type { ConnectionEntry, RequestContext } from './responses-websocket-types.js';
import {
  boundedDiagnosticIdentifier,
  diagnosticItemIdHash,
  emitContextDiagnostic,
} from './responses-websocket-diagnostics.js';

function reasoningPartIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function emitProtocolAnomaly(
  entry: ConnectionEntry,
  ctx: RequestContext,
  anomaly: string,
  itemId: unknown,
  summaryIndex: number | undefined,
  upstreamEventType: string,
): void {
  const itemIdHash = diagnosticItemIdHash(itemId);
  const key = `${anomaly}:${itemIdHash ?? 'none'}:${summaryIndex ?? 'none'}`;
  if (ctx.emittedProtocolAnomalies.has(key)) return;
  ctx.emittedProtocolAnomalies.add(key);
  const parts = typeof itemId === 'string' ? ctx.reasoningPartsByItemId.get(itemId) : undefined;
  emitContextDiagnostic(entry, ctx, {
    event: 'ws_response_protocol_anomaly',
    source: 'response_event_sequence',
    anomaly,
    upstreamEventType,
    itemIdHash,
    summaryIndex,
    knownSummaryParts: parts
      ? [...parts.entries()].sort(([left], [right]) => left - right)
        .map(([index, state]) => ({ summaryIndex: index, state }))
      : [],
    recentUpstreamEventTypes: [...ctx.recentUpstreamEventTypes],
  });
}

/**
 * Track OpenAI's reasoning-item/summary-part protocol as it streams and emit a
 * diagnostic the first time an event arrives out of the expected sequence
 * (e.g. a summary delta before its part is added, an item done before it was
 * started). Diagnostics-only: never throws, never alters what is forwarded.
 */
export function trackReasoningProtocol(
  entry: ConnectionEntry,
  ctx: RequestContext,
  event: unknown,
  type: string | undefined,
): void {
  if (!type || !event || typeof event !== 'object') return;
  ctx.recentUpstreamEventTypes.push(boundedDiagnosticIdentifier(type) ?? 'unknown');
  if (ctx.recentUpstreamEventTypes.length > 20) ctx.recentUpstreamEventTypes.shift();

  const record = event as Record<string, unknown>;
  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    const item = record.item && typeof record.item === 'object' ? record.item as Record<string, unknown> : undefined;
    if (item?.type !== 'reasoning') return;
    const itemId = item.id;
    if (typeof itemId !== 'string' || itemId.length === 0) return;
    const current = ctx.reasoningPartsByItemId.get(itemId);
    if (type === 'response.output_item.added') {
      if (current) {
        emitProtocolAnomaly(entry, ctx, 'duplicate_reasoning_item_added', itemId, 0, type);
      }
      ctx.reasoningPartsByItemId.set(itemId, new Map([[0, 'active']]));
    } else {
      if (!current) {
        emitProtocolAnomaly(entry, ctx, 'reasoning_start_missing_before_item_done', itemId, undefined, type);
      }
      ctx.reasoningPartsByItemId.delete(itemId);
    }
    return;
  }

  if (!type.startsWith('response.reasoning_summary_')) {
    if (type === 'response.completed' && ctx.reasoningPartsByItemId.size > 0) {
      for (const itemId of ctx.reasoningPartsByItemId.keys()) {
        emitProtocolAnomaly(entry, ctx, 'reasoning_item_done_missing_before_completion', itemId, undefined, type);
      }
    }
    return;
  }

  const itemId = record.item_id;
  const summaryIndex = reasoningPartIndex(record.summary_index);
  if (typeof itemId !== 'string' || summaryIndex === undefined) return;
  const parts = ctx.reasoningPartsByItemId.get(itemId);
  const state = parts?.get(summaryIndex);

  if (type === 'response.reasoning_summary_part.added') {
    if (!parts) {
      emitProtocolAnomaly(entry, ctx, 'reasoning_item_missing_before_summary_part', itemId, summaryIndex, type);
      return;
    }
    if (summaryIndex > 0) {
      for (const [index, partState] of parts) {
        if (partState === 'can_conclude') parts.set(index, 'concluded');
      }
      if (state === 'active' || state === 'can_conclude') {
        emitProtocolAnomaly(entry, ctx, 'duplicate_reasoning_summary_part_added', itemId, summaryIndex, type);
      }
      parts.set(summaryIndex, 'active');
    }
    return;
  }

  if (type === 'response.reasoning_summary_text.delta') {
    if (state === undefined || state === 'concluded') {
      emitProtocolAnomaly(entry, ctx, 'reasoning_start_missing_before_delta', itemId, summaryIndex, type);
    }
    return;
  }

  if (type === 'response.reasoning_summary_part.done') {
    if (state === undefined || state === 'concluded') {
      emitProtocolAnomaly(entry, ctx, 'reasoning_start_missing_before_part_done', itemId, summaryIndex, type);
      return;
    }
    parts!.set(summaryIndex, ctx.originalPayload.store === true ? 'concluded' : 'can_conclude');
  }
}
