import { estimateAnthropicInputTokens } from '../anthropic-endpoints.js';
import { groupAnthropicContext, isJsonShapedAnthropicMessage } from './anthropic-context-groups.js';

export interface RequestPolicyInput<T extends object> {
  request: T;
  sessionId: string | undefined;
  routeIdentity: string;
  contextWindow: number | undefined;
  signal: AbortSignal;
}

export interface RequestPolicyResult<T extends object> {
  request: T;
  outcome: 'unchanged' | 'unsupported_policy';
  reason: string;
  estimatedInputTokens?: number;
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
    return { request, outcome: 'unchanged', reason: 'reduction_unavailable', estimatedInputTokens };
  } catch {
    return unchanged('policy_unavailable');
  }
}

export function formatRequestPolicyOutcome(result: RequestPolicyResult<object>, overheadMs: number): string {
  return `context-policy outcome=${result.outcome} reason=${result.reason} estimated_input_tokens=${result.estimatedInputTokens ?? 'unknown'} overhead_ms=${overheadMs}`;
}
