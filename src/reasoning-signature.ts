const OPENAI_SIGNATURE_PREFIX = 'leverframe:openai:v1:';
const OPENAI_ITEM_SIGNATURE_PREFIX = 'leverframe:openai:v2:';
const OPENAI_ITEM_ID = /^[a-zA-Z0-9_-]{1,192}$/;

export function encodeOpenAiReasoningSignature(signature: string, itemId?: string | null): string {
  if (itemId && OPENAI_ITEM_ID.test(itemId)) return `${OPENAI_ITEM_SIGNATURE_PREFIX}${itemId}:${signature}`;
  return OPENAI_SIGNATURE_PREFIX + signature;
}

export function decodeOpenAiReasoningSignature(
  signature: string | undefined,
): { reasoningEncryptedContent: string; itemId?: string } | undefined {
  if (signature?.startsWith(OPENAI_ITEM_SIGNATURE_PREFIX)) {
    const separator = signature.indexOf(':', OPENAI_ITEM_SIGNATURE_PREFIX.length);
    if (separator === -1) return undefined;
    const itemId = signature.slice(OPENAI_ITEM_SIGNATURE_PREFIX.length, separator);
    const reasoningEncryptedContent = signature.slice(separator + 1);
    if (!OPENAI_ITEM_ID.test(itemId) || !reasoningEncryptedContent) return undefined;
    return { itemId, reasoningEncryptedContent };
  }
  if (!signature?.startsWith(OPENAI_SIGNATURE_PREFIX)) return undefined;
  const reasoningEncryptedContent = signature.slice(OPENAI_SIGNATURE_PREFIX.length);
  return reasoningEncryptedContent ? { reasoningEncryptedContent } : undefined;
}
