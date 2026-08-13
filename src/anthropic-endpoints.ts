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
 * Rough vision-input cost per image. Images are forwarded as real image parts
 * (never inline base64 text), so they cost tile-based vision tokens — for a
 * typical screenshot on GPT-family and Claude models that lands around 1-2k.
 */
const IMAGE_INPUT_TOKEN_ESTIMATE = 1600;

function isAnthropicImageBlock(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as { type?: unknown; source?: unknown };
  return rec.type === 'image' && !!rec.source && typeof rec.source === 'object';
}

/**
 * Provider-neutral local estimate for translated models, whose SDKs do not expose
 * a token-count API. It is intentionally conservative and, unlike inference, is
 * immediate, local, free, and side-effect free. Claude Code labels /context counts
 * as estimates already.
 *
 * Image blocks (top-level or inside tool_result content) are excluded from the
 * bytes/4 text heuristic — base64 payloads are huge but are delivered as vision
 * parts — and counted at a flat per-image estimate instead.
 */
export function estimateAnthropicInputTokens(body: object): number {
  const contextBody = Object.fromEntries(
    Object.entries(body).filter(([key]) => !NON_CONTEXT_FIELDS.has(key)),
  );
  let imageCount = 0;
  let textBytes = 0;
  const serialized = JSON.stringify(contextBody, (_key, value: unknown) => {
    if (isAnthropicImageBlock(value)) {
      imageCount += 1;
      return { type: 'image' };
    }
    if (typeof value === 'string') {
      textBytes += Buffer.byteLength(value, 'utf8');
    }
    return value;
  });
  if (!serialized || serialized === '{}') return 0;
  // Two-weight estimate: prose (string values) tokenizes near bytes/4, but JSON
  // structural overhead (keys, quotes, braces, escaping) tokenizes denser than
  // that — a flat bytes/4 over the whole serialized body over-counted ~20-25%
  // against real provider counts (observed 297K displayed vs ~239K real). Weight
  // the non-text bytes at /6 instead of /4 while still counting them, not
  // dropping them.
  const totalBytes = Buffer.byteLength(serialized, 'utf8');
  const structuralBytes = Math.max(0, totalBytes - textBytes);
  const textTokens = Math.ceil(textBytes / 4) + Math.ceil(structuralBytes / 6);
  return Math.max(1, textTokens + imageCount * IMAGE_INPUT_TOKEN_ESTIMATE);
}

/**
 * Rough local estimate for locally-produced output content (assistant text
 * and/or serialized tool-call input), used only when a provider omits real
 * output-token usage. Mirrors the bytes/4 prose weighting in
 * {@link estimateAnthropicInputTokens} without its structural-JSON split,
 * since the input here is the exact bytes already delivered to the client
 * rather than a full request body.
 */
export function estimateAnthropicOutputTokens(outputBytes: number): number {
  return outputBytes > 0 ? Math.max(1, Math.ceil(outputBytes / 4)) : 0;
}

/**
 * Anthropic-compatible message for an upstream context-length rejection.
 *
 * Contract: Claude Code parses this exact shape client-side —
 * `prompt is too long: (\d+) tokens > (\d+) maximum` — and only triggers its
 * compaction/truncation handling when the parsed N (tokens) is strictly greater
 * than M (maximum). `promptTokens` below is therefore a synthetic lower bound
 * (`max(estimate, maximum + 1)`), not a real token count: it exists solely to
 * guarantee N > M so Claude Code's parser fires. Do not "fix" this into the raw
 * estimate — doing so can produce N <= M and silently break compaction.
 */
export function anthropicPromptTooLongMessage(body: object, contextWindow: number): string {
  const maximum = Math.max(1, Math.floor(contextWindow));
  // The translated providers do not expose an exact token-count endpoint. Keep the
  // message structurally compatible with Anthropic while ensuring the rejected
  // prompt count is represented as larger than the advertised maximum.
  const estimatedPromptTokens = estimateAnthropicInputTokens(body);
  const promptTokens = Math.max(estimatedPromptTokens, maximum + 1);
  return `prompt is too long: ${promptTokens} tokens > ${maximum} maximum`;
}
