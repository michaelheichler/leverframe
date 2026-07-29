// src/execution-session-key.ts — canonical session-key derivation for
// execution tracking (stabilization plan §8.1). A single, tested factory
// replaces the ad-hoc `claudeSessionId ?? \`anon:${provider}:${model}\`` string
// concatenation previously duplicated across the Anthropic and OpenAI route
// handlers, so both routes hash to the same execution scope for a given
// client session and fall back identically when no session id is present.

/** A Claude Code session id is a short opaque token; reject anything that looks unsafe or absurdly long. */
const SAFE_SESSION_ID = /^[A-Za-z0-9._:-]{1,256}$/;

export interface ExecutionSessionKeyInput {
  /** Client-supplied session id (e.g. `x-claude-code-session-id` / request body), when present. */
  claudeSessionId?: string;
  provider: string;
  model: string;
}

/**
 * Derive the stable string that {@link workspaceOrSessionHash} (checkpoint-store.ts)
 * hashes into an execution scope directory.
 *
 * - A present, well-formed session id always wins and is scoped by itself
 *   only, so the same client session maps to the same execution scope across
 *   provider/model switches within that session (matching the underlying
 *   Claude Code conversation, not a single request).
 * - Otherwise the key falls back to a provider+model scope so unrelated
 *   anonymous callers hitting different models never collide.
 */
export function resolveExecutionSessionKey(input: ExecutionSessionKeyInput): string {
  const provider = input.provider.trim() || 'unknown-provider';
  const model = input.model.trim() || 'unknown-model';
  const sessionId = input.claudeSessionId?.trim();
  if (sessionId && SAFE_SESSION_ID.test(sessionId)) {
    return `session:${sessionId}`;
  }
  return `anon:${provider}:${model}`;
}
