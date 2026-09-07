

const GOOGLE_MODEL_PREFIX = 'models/';

export function stripGoogleModelPrefix(id: string): string {
  return id.startsWith(GOOGLE_MODEL_PREFIX) ? id.slice(GOOGLE_MODEL_PREFIX.length) : id;
}

export function normalizeGoogleModelId(
  rawId: string,
  npm?: string,
): { id: string; upstreamModelId: string } {
  if (npm !== '@ai-sdk/google') {
    return { id: rawId, upstreamModelId: rawId };
  }
  const bare = stripGoogleModelPrefix(rawId);
  return { id: bare, upstreamModelId: bare };
}

export function normalizeGoogleDisplayName(rawName: string | undefined, bareId: string): string {
  const trimmed = rawName?.trim();
  if (!trimmed) return bareId;
  return stripGoogleModelPrefix(trimmed);
}
