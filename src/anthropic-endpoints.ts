const MESSAGE_PATH = '/v1/messages';
const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';

export type AnthropicMessagesEndpoint = 'messages' | 'count_tokens';

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

const IMAGE_INPUT_TOKEN_ESTIMATE = 1600;

function isAnthropicImageBlock(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as { type?: unknown; source?: unknown };
  return rec.type === 'image' && !!rec.source && typeof rec.source === 'object';
}

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

  const totalBytes = Buffer.byteLength(serialized, 'utf8');
  const structuralBytes = Math.max(0, totalBytes - textBytes);
  const textTokens = Math.ceil(textBytes / 4) + Math.ceil(structuralBytes / 6);
  return Math.max(1, textTokens + imageCount * IMAGE_INPUT_TOKEN_ESTIMATE);
}

export function estimateAnthropicOutputTokens(outputBytes: number): number {
  return outputBytes > 0 ? Math.max(1, Math.ceil(outputBytes / 4)) : 0;
}

export function anthropicPromptTooLongMessage(body: object, contextWindow: number): string {
  const maximum = Math.max(1, Math.floor(contextWindow));

  const estimatedPromptTokens = estimateAnthropicInputTokens(body);
  const promptTokens = Math.max(estimatedPromptTokens, maximum + 1);
  return `prompt is too long: ${promptTokens} tokens > ${maximum} maximum`;
}
