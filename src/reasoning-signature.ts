const OPENAI_SIGNATURE_PREFIX = 'leverframe:openai:v1:';

export function encodeOpenAiReasoningSignature(signature: string): string {
  return OPENAI_SIGNATURE_PREFIX + signature;
}

export function decodeOpenAiReasoningSignature(signature: string | undefined): string | undefined {
  if (!signature?.startsWith(OPENAI_SIGNATURE_PREFIX)) return undefined;
  return signature.slice(OPENAI_SIGNATURE_PREFIX.length) || undefined;
}
