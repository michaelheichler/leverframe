import type { RequestContext } from './responses-websocket-types.js';
import { deleteEntry } from './responses-websocket-connection-pool.js';
import type { ProviderTransportError } from '../provider-error.js';

const activeContexts = new Set<RequestContext>();

export function trackActiveContext(ctx: RequestContext): void {
  activeContexts.add(ctx);
}

export function activeContextsSnapshot(): RequestContext[] {
  return [...activeContexts];
}

export function clearActiveContexts(): void {
  activeContexts.clear();
}

export function settleHandshakeSuccess(ctx: RequestContext): void {
  if (ctx.handshakeSettled) return;
  ctx.handshakeSettled = true;
  ctx.resolveHandshake?.();
}

export function settleHandshakeFailure(ctx: RequestContext, reason: unknown): void {
  if (ctx.handshakeSettled) return;
  ctx.handshakeSettled = true;
  ctx.rejectHandshake?.(reason);
}

function clearContextRuntime(ctx: RequestContext): void {
  if (ctx.retryTimer !== undefined) {
    clearTimeout(ctx.retryTimer);
    ctx.retryTimer = undefined;
  }
  ctx.abortCleanup?.();
  ctx.abortCleanup = undefined;
  activeContexts.delete(ctx);
}

export function closeContext(ctx: RequestContext): void {
  if (ctx.closed) return;
  ctx.closed = true;
  clearContextRuntime(ctx);
  try { ctx.controller.close(); } catch { /* already closed */ }
}

export function errorContext(ctx: RequestContext, error: ProviderTransportError): void {
  if (ctx.closed) return;
  ctx.closed = true;
  clearContextRuntime(ctx);
  settleHandshakeFailure(ctx, error);
  try { ctx.controller.error(error); } catch { /* already closed */ }
}

export function cancelContext(ctx: RequestContext, reason: unknown): void {
  if (ctx.closed) return;
  if (ctx.entry) deleteEntry(ctx.entry);
  settleHandshakeFailure(ctx, reason);
  closeContext(ctx);
}

export function encodeSse(ctx: RequestContext, event: unknown): void {
  if (ctx.closed) return;
  ctx.controller.enqueue(ctx.encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
}

export function flushPending(ctx: RequestContext): void {
  for (const event of ctx.pendingEvents) encodeSse(ctx, event);
  ctx.pendingEvents = [];
}

export function resetContextForRetry(ctx: RequestContext): void {
  ctx.continued = false;
  ctx.sendPayload = ctx.originalPayload;
  ctx.pendingEvents = [];
  ctx.frameCount = 0;
  ctx.emittedModelData = false;
  ctx.responseId = undefined;
  ctx.outputByIndex.clear();
  ctx.outputIndexByItemId.clear();
  ctx.reasoningPartsByItemId.clear();
  ctx.recentUpstreamEventTypes = [];
  ctx.emittedProtocolAnomalies.clear();
}
