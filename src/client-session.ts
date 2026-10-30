const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validClaudeSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return SESSION_ID_RE.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

export function extractClaudeSessionId(
  body: { metadata?: unknown },
  headerFallback?: string,
): string | undefined {
  const metadata = body.metadata;
  const userId = metadata && typeof metadata === 'object' && 'user_id' in metadata
    ? metadata.user_id : undefined;
  if (typeof userId === 'string') {
    const legacySession = userId.match(/^user_[a-f0-9]+_account_[\w-]*_session_([\w-]+)$/i);
    const fromLegacy = validClaudeSessionId(legacySession?.[1]);
    if (fromLegacy) return fromLegacy;
    try {
      const parsed: unknown = JSON.parse(userId);
      const fromMetadata = parsed && typeof parsed === 'object' && 'session_id' in parsed
        ? validClaudeSessionId(parsed.session_id) : undefined;
      if (fromMetadata) return fromMetadata;
    } catch {
      return validClaudeSessionId(headerFallback);
    }
  }
  return validClaudeSessionId(headerFallback);
}
