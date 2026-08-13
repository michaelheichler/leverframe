import type { JsonObject, OutputAccumulator, RequestContext } from './responses-websocket-types.js';

export const TERMINAL_EVENT_TYPES = new Set(['response.completed', 'response.failed', 'response.incomplete']);

export function eventType(event: unknown): string | undefined {
  return event && typeof event === 'object' && typeof (event as JsonObject).type === 'string'
    ? (event as JsonObject).type as string
    : undefined;
}

export function responseErrorCode(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as JsonObject;
  if (typeof record.code === 'string') return record.code;
  const error = record.error && typeof record.error === 'object' ? record.error as JsonObject : undefined;
  if (typeof error?.code === 'string') return error.code;
  const response = record.response && typeof record.response === 'object' ? record.response as JsonObject : undefined;
  const responseError = response?.error && typeof response.error === 'object' ? response.error as JsonObject : undefined;
  return typeof responseError?.code === 'string' ? responseError.code : undefined;
}

function responseIdFromEvent(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const response = (event as JsonObject).response;
  if (!response || typeof response !== 'object') return undefined;
  return typeof (response as JsonObject).id === 'string' ? (response as JsonObject).id as string : undefined;
}

interface ResponseUsage {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export function responseUsage(event: unknown): ResponseUsage | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const response = (event as JsonObject).response;
  if (!response || typeof response !== 'object') return undefined;
  const usage = (response as JsonObject).usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const usageRecord = usage as JsonObject;
  const details = usageRecord.input_tokens_details && typeof usageRecord.input_tokens_details === 'object'
    ? usageRecord.input_tokens_details as JsonObject
    : {};
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return {
    inputTokens: number(usageRecord.input_tokens),
    cachedTokens: number(details.cached_tokens),
    cacheWriteTokens: number(details.cache_write_tokens ?? usageRecord.cache_write_tokens),
    outputTokens: number(usageRecord.output_tokens),
  };
}

export function responseUsageDebug(usage: ResponseUsage): string {
  return `usage input_tokens=${usage.inputTokens} `
    + `cached_tokens=${usage.cachedTokens} `
    + `cache_write_tokens=${usage.cacheWriteTokens} `
    + `output_tokens=${usage.outputTokens}`;
}

function outputAccumulator(ctx: RequestContext, index: number): OutputAccumulator {
  let accumulator = ctx.outputByIndex.get(index);
  if (!accumulator) {
    accumulator = { text: '', summaries: new Map() };
    ctx.outputByIndex.set(index, accumulator);
  }
  return accumulator;
}

/** Accumulate streamed Responses events into per-output-index text/reasoning state. */
export function captureOutput(ctx: RequestContext, event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const record = event as JsonObject;
  const type = eventType(event);
  if (type === 'response.created') {
    ctx.responseId = responseIdFromEvent(event) ?? ctx.responseId;
    return;
  }
  if (type === 'response.output_item.added' && typeof record.output_index === 'number') {
    const item = record.item && typeof record.item === 'object' ? record.item as JsonObject : {};
    const accumulator = outputAccumulator(ctx, record.output_index);
    accumulator.type = typeof item.type === 'string' ? item.type : accumulator.type;
    accumulator.itemId = typeof item.id === 'string' ? item.id : accumulator.itemId;
    if (accumulator.itemId) ctx.outputIndexByItemId.set(accumulator.itemId, record.output_index);
    return;
  }
  if (type === 'response.output_text.delta' && typeof record.item_id === 'string') {
    const index = ctx.outputIndexByItemId.get(record.item_id);
    if (index !== undefined && typeof record.delta === 'string') outputAccumulator(ctx, index).text += record.delta;
    return;
  }
  if (type === 'response.reasoning_summary_text.delta' && typeof record.item_id === 'string') {
    const index = ctx.outputIndexByItemId.get(record.item_id);
    if (index !== undefined && typeof record.delta === 'string') {
      const accumulator = outputAccumulator(ctx, index);
      const summaryIndex = typeof record.summary_index === 'number' ? record.summary_index : 0;
      accumulator.summaries.set(summaryIndex, (accumulator.summaries.get(summaryIndex) ?? '') + record.delta);
    }
    return;
  }
  if (type === 'response.output_item.done' && typeof record.output_index === 'number') {
    const item = record.item && typeof record.item === 'object' ? record.item as JsonObject : {};
    const accumulator = outputAccumulator(ctx, record.output_index);
    accumulator.type = typeof item.type === 'string' ? item.type : accumulator.type;
    accumulator.done = item;
    return;
  }
  if (TERMINAL_EVENT_TYPES.has(type ?? '')) {
    ctx.responseId = responseIdFromEvent(event) ?? ctx.responseId;
    const response = record.response && typeof record.response === 'object' ? record.response as JsonObject : undefined;
    if (Array.isArray(response?.output) && ctx.outputByIndex.size === 0) {
      response.output.forEach((item, index) => {
        if (item && typeof item === 'object') {
          outputAccumulator(ctx, index).done = item as JsonObject;
          outputAccumulator(ctx, index).type = typeof (item as JsonObject).type === 'string'
            ? (item as JsonObject).type as string
            : undefined;
        }
      });
    }
  }
}

function withoutEphemeralFields(item: JsonObject): JsonObject {
  const out = { ...item };
  delete out.id;
  delete out.status;
  delete out.phase;
  delete out.role;
  for (const [key, value] of Object.entries(out)) {
    if (value == null) delete out[key];
  }
  return out;
}

/** Reconstruct the assistant-turn items expected to be echoed back on the next request. */
export function expectedAssistantItems(ctx: RequestContext): unknown[] {
  const output: unknown[] = [];
  for (const [, accumulator] of [...ctx.outputByIndex.entries()].sort(([left], [right]) => left - right)) {
    const done = accumulator.done ?? {};
    const type = accumulator.type ?? (typeof done.type === 'string' ? done.type : undefined);
    if (type === 'message') {
      const doneContent = Array.isArray(done.content) ? done.content : undefined;
      const text = accumulator.text || (doneContent
        ? doneContent.filter(part => part && typeof part === 'object' && (part as JsonObject).type === 'output_text')
          .map(part => String((part as JsonObject).text ?? '')).join('')
        : '');
      output.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      continue;
    }
    if (type === 'reasoning') {
      const summary = accumulator.summaries.size
        ? [...accumulator.summaries.entries()].sort(([a], [b]) => a - b)
          .map(([, text]) => ({ type: 'summary_text', text }))
        : Array.isArray(done.summary) ? done.summary : [];
      output.push({ ...withoutEphemeralFields(done), type: 'reasoning', summary });
      continue;
    }
    if (type === 'function_call' || type === 'custom_tool_call') {
      output.push({ ...withoutEphemeralFields(done), type });
    }
  }
  return output;
}
