const MESSAGE_PATH = '/v1/messages';
const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';

export type AnthropicMessagesEndpoint = 'messages' | 'count_tokens';

/** Match Anthropic message endpoints by pathname, never by a shared prefix. */
export function anthropicMessagesEndpoint(url: string | undefined): AnthropicMessagesEndpoint | null {
  if (!url) return null;
  let pathname: string;
  try {
    pathname = new URL(url, 'http://relay.local').pathname;
  } catch {
    return null;
  }
  if (pathname === MESSAGE_PATH) return 'messages';
  if (pathname === COUNT_TOKENS_PATH) return 'count_tokens';
  return null;
}

const NON_CONTEXT_FIELDS = new Set([
  'model',
  'stream',
  'max_tokens',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'metadata',
]);

/**
 * Provider-neutral local estimate for translated models, whose SDKs do not expose
 * a token-count API. It is intentionally conservative and, unlike inference, is
 * immediate, local, free, and side-effect free. Claude Code labels /context counts
 * as estimates already.
 */
export function estimateAnthropicInputTokens(body: object): number {
  const contextBody = Object.fromEntries(
    Object.entries(body).filter(([key]) => !NON_CONTEXT_FIELDS.has(key)),
  );
  const serialized = JSON.stringify(contextBody);
  if (!serialized || serialized === '{}') return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(serialized, 'utf8') / 4));
}

/** Anthropic-compatible message for an upstream context-length rejection. */
export function anthropicPromptTooLongMessage(body: object, contextWindow: number): string {
  const maximum = Math.max(1, Math.floor(contextWindow));
  // The translated providers do not expose an exact token-count endpoint. Keep the
  // message structurally compatible with Anthropic while ensuring the rejected
  // prompt count is represented as larger than the advertised maximum.
  const estimatedPromptTokens = estimateAnthropicInputTokens(body);
  const promptTokens = Math.max(estimatedPromptTokens, maximum + 1);
  return `prompt is too long: ${promptTokens} tokens > ${maximum} maximum`;
}
