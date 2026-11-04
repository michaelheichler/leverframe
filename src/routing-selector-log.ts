import { createHash, randomUUID } from 'node:crypto';
import { getInferenceRequestLogPath } from './log-paths.js';
import { writeSecureLogLine } from './trace-log.js';
import { routingMeasuredCost } from './routing-inference-log.js';
import { selectorNoticeReason } from './routing-notice-contract.js';
import type { ModelRef } from './model-routing.js';
import type { CostSnapshot, RoutingCatalogSnapshot } from './model-routing-catalog.js';
import type { ResponseUsage } from './http-proxy/response-usage.js';
import type { RoutingBinding } from './routing-bindings.js';
import { httpProxyModelId } from './http-proxy/routes.js';

export interface SelectorTrace { requestId: string; sessionHash: string; launchHash: string }
export const SELECTOR_TRACE_HEADER = 'x-leverframe-selector-trace';
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function reference(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : undefined;
}
function validTrace(value: unknown): value is SelectorTrace {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const trace = value as Record<string, unknown>;
  return Object.keys(trace).length === 3 && Object.keys(trace).every(key => ['requestId', 'sessionHash', 'launchHash'].includes(key))
    && typeof trace.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(trace.requestId)
    && ['sessionHash', 'launchHash'].every(key => typeof trace[key] === 'string' && /^[0-9a-f]{64}$/.test(trace[key] as string));
}
export function createSelectorTrace(sessionId: string, launchId: string): SelectorTrace {
  return { requestId: randomUUID(), sessionHash: hash(sessionId), launchHash: hash(launchId) };
}
export function encodeSelectorTrace(trace: SelectorTrace): string {
  if (!validTrace(trace)) throw new Error('Invalid selector trace.');
  return Buffer.from(JSON.stringify(trace), 'utf8').toString('base64url');
}
export function decodeSelectorTrace(raw: unknown): SelectorTrace | undefined {
  if (typeof raw !== 'string' || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return undefined;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    if (Buffer.from(json, 'utf8').toString('base64url') !== raw) return undefined;
    const parsed: unknown = JSON.parse(json);
    return validTrace(parsed) ? parsed : undefined;
  } catch { return undefined; }
}
export function selectorTargetForAlias(catalog: RoutingCatalogSnapshot, alias: string): ModelRef | undefined {
  const matches = catalog.models.filter(model => httpProxyModelId(model.ref.providerId, model.ref.modelId) === alias);
  const first = matches[0]?.ref;
  return first && matches.every(model => model.ref.providerId === first.providerId && model.ref.modelId === first.modelId)
    ? { providerId: first.providerId, modelId: first.modelId } : undefined;
}
export function selectorCostSnapshot(catalog: RoutingCatalogSnapshot, target: ModelRef): CostSnapshot | undefined {
  const rows = catalog.models.filter(model => model.ref.providerId === target.providerId && model.ref.modelId === target.modelId);
  const snapshot = rows[0]?.estimate;
  try { return snapshot && rows.every(model => JSON.stringify(model.estimate) === JSON.stringify(snapshot)) ? snapshot : undefined; }
  catch { return undefined; }
}
export function writeSelectorTrace(path: string | undefined, trace: SelectorTrace, event: 'attempt' | 'send' | 'usage' | 'failed' | 'outcome',
  options: { target?: ModelRef; snapshot?: CostSnapshot; usage?: ResponseUsage; reason?: string; bindingHash?: string } = {}): void {
  try {
    if (!validTrace(trace)) return;
    const reason = options.reason && selectorNoticeReason(options.reason) ? options.reason : undefined;
    const measured = options.snapshot && options.usage ? routingMeasuredCost(options.snapshot, options.usage) : undefined;
    writeSecureLogLine(path ?? getInferenceRequestLogPath(), JSON.stringify({
      timestamp: new Date().toISOString(), event: `routing_selector_${event}`, ...trace,
      ...(options.bindingHash && /^[0-9a-f]{64}$/.test(options.bindingHash) ? { bindingHash: options.bindingHash } : {}),
      ...(options.target ? { provider: reference(options.target.providerId), model: reference(options.target.modelId),
        targetRole: event === 'outcome' ? 'selected_target' : 'selector' } : {}),
      ...(reason ? { reason } : {}),
      ...(event === 'send' ? { transport: 'guarded_http_send_invoked', acceptance: 'unknown' } : {}),
      ...(event === 'outcome' && reason === 'selector_cache_hit' ? { inference: 'no_new_send' } : {}),
      measuredApiEquivalent: { kind: measured?.kind ?? 'unknown',
        ...(measured?.kind === 'known' ? { amount: measured.amount } : {}), currency: 'USD', basis: 'provider_usage',
        source: reference(options.snapshot?.source),
        freshness: options.snapshot && ['current', 'stale', 'unknown'].includes(options.snapshot.freshness)
          ? options.snapshot.freshness : 'unknown' },
      actualBilling: 'unknown', subscriptionConsumption: 'unknown',
      ...(options.usage ? { usageStage: options.usage.usageStage, usageIsCumulative: true,
        inputTokens: count(options.usage.inputTokens), outputTokens: count(options.usage.outputTokens),
        cacheReadInputTokens: count(options.usage.cacheReadInputTokens), cacheCreationInputTokens: count(options.usage.cacheCreationInputTokens),
        cacheCreation5mInputTokens: count(options.usage.cacheCreation5mInputTokens), cacheCreation1hInputTokens: count(options.usage.cacheCreation1hInputTokens) } : {}),
    }));
  } catch { /* Selector logging must not change transport or launch outcomes. */ }
}
export function logSelectorOutcome(path: string | undefined, binding: RoutingBinding): void {
  try {
    const event = [...binding.decision.events].reverse().find(item => selectorNoticeReason(item.reason));
    if (event) writeSelectorTrace(path, createSelectorTrace(binding.sessionId, binding.launchId), 'outcome',
      { target: binding.decision.target, reason: event.reason, bindingHash: hash(binding.id) });
  } catch { /* A logging projection must not change launch outcomes. */ }
}
