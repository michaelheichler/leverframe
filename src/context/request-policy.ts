import { estimateAnthropicInputTokens } from '../anthropic-endpoints.js';
import { groupAnthropicContext, isJsonShapedAnthropicMessage } from './anthropic-context-groups.js';
import { reduceDuplicateToolResults } from './deterministic-reduction.js';
import { openEvidenceStore } from './evidence-runtime.js';
import { loadPreferences } from '../config.js';
import { applySummaryStage, type SummaryUsage } from './summary-engine.js';
import { configuredPaidSummaryEngine } from './paid-summary-engine.js';
import { reserveSummarySpend, settleSummarySpend } from './summary-spend.js';

export interface RequestPolicyInput<T extends object> {
  request: T;
  sessionId: string | undefined;
  routeIdentity: string;
  contextWindow: number | undefined;
  signal: AbortSignal;
}

export interface RequestPolicyResult<T extends object> {
  request: T;
  outcome: 'unchanged' | 'unsupported_policy' | 'reduced';
  reason: string;
  estimatedInputTokens?: number;
  summaryUsage?: SummaryUsage;
  summaryChargedMicros?: number;
}

function containsProviderState(messages: readonly unknown[]): boolean {
  return messages.some(message => {
    if (!message || typeof message !== 'object' || !('content' in message)) return false;
    const content = message.content;
    return Array.isArray(content) && content.some(block =>
      block && typeof block === 'object' && ('signature' in block
        || ('type' in block && (block.type === 'thinking' || block.type === 'redacted_thinking'))));
  });
}

export async function applyRequestContextPolicy<T extends object>(input: RequestPolicyInput<T>): Promise<RequestPolicyResult<T>> {
  const { request, sessionId, contextWindow, signal } = input;
  const body = request as Record<string, unknown>;
  const unchanged = (reason: string): RequestPolicyResult<T> => ({ request, outcome: 'unchanged', reason });
  if (signal.aborted) return unchanged('aborted');
  if (body.context_management !== undefined || (Array.isArray(body.messages) && containsProviderState(body.messages))) {
    return { request, outcome: 'unsupported_policy', reason: 'provider_managed_history' };
  }
  if (!sessionId) return unchanged('missing_session');
  if (!Number.isSafeInteger(contextWindow) || !contextWindow || contextWindow <= 0) return unchanged('unconfirmed_context_window');
  if (!Array.isArray(body.messages) || !body.messages.every(isJsonShapedAnthropicMessage)) return unchanged('invalid_messages');
  try {
    const groups = groupAnthropicContext(body.messages);
    if (groups.diagnostics.length) return unchanged('invalid_context');
    const estimatedInputTokens = estimateAnthropicInputTokens(request);
    let store: ReturnType<typeof openEvidenceStore> | undefined;
    const getStore = () => store ??= openEvidenceStore();
    let storageFailed = false;
    const useStore = async <R>(operation: (store: Awaited<ReturnType<typeof openEvidenceStore>>) => Promise<R>) => {
      try { return await operation(await getStore()); } catch (error) { storageFailed = true; throw error; }
    };
    const reduced = await reduceDuplicateToolResults({ request, sessionId, signal, store: {
      put: (session, content) => useStore(evidence => evidence.put(session, content)),
      get: (session, reference) => useStore(evidence => evidence.get(session, reference)),
    } });
    if (signal.aborted) return unchanged('aborted');
    const fallback: RequestPolicyResult<T> = { request: reduced.request, outcome: reduced.reduced ? 'reduced' : 'unchanged', reason: reduced.reduced ? 'duplicate_evidence' : storageFailed ? 'evidence_unavailable' : 'no_reduction', estimatedInputTokens };
    try {
      const settings = loadPreferences().summarySettings;
      if (!settings?.enabled || !settings.engineId) return fallback;
      const engine = configuredPaidSummaryEngine(settings.engineId);
      if (!engine) return fallback;
      const result = await applySummaryStage({ request: reduced.request as T & { messages: typeof body.messages }, sessionId, routeIdentity: input.routeIdentity, engine, store: await getStore(), signal, ledger: {
        reserve: amount => reserveSummarySpend({ ...amount, authorize: () => JSON.stringify(loadPreferences().summarySettings) === JSON.stringify(settings) }),
        settle: settleSummarySpend,
      }, options: {
        workspaceId: 'default', policyVersion: 'summary-v1', generation: '1', maxInputTokens: 16_384, maxOutputTokens: 1_024, deadlineMs: 30_000, untouchedRecentTail: 4_096, rollingStride: 1_024,
        lifetimeLimitMicros: settings.lifetimeLimitMicros, pricing: settings.pricing, persistentCache: true,
      } });
      return result.summarized ? { request: result.request, outcome: 'reduced', reason: result.reused ? 'summary_reused' : 'summary', estimatedInputTokens, summaryUsage: result.reused ? undefined : result.usage, summaryChargedMicros: result.chargedMicros } : { ...fallback, summaryUsage: result.usage, summaryChargedMicros: result.chargedMicros };
    } catch { return fallback; }
  } catch {
    return unchanged('policy_unavailable');
  }
}

export function formatRequestPolicyOutcome(result: RequestPolicyResult<object>, overheadMs: number): string {
  let finalEstimate: number | undefined;
  try { finalEstimate = estimateAnthropicInputTokens(result.request); } catch { finalEstimate = undefined; }
  const originalEstimate = result.estimatedInputTokens ?? (result.outcome !== 'reduced' ? finalEstimate : undefined);
  return `context-policy outcome=${result.outcome} reason=${result.reason} estimated_input_tokens=${originalEstimate ?? 'unknown'} final_input_tokens=${finalEstimate ?? 'unknown'} summary_input_tokens=${result.summaryUsage?.inputTokens ?? 'unknown'} summary_output_tokens=${result.summaryUsage?.outputTokens ?? 'unknown'} summary_cost_micros=${result.summaryChargedMicros ?? 'unknown'} overhead_ms=${overheadMs}`;
}
