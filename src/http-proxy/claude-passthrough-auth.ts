// Why: placeholder --bare requests must carry Claude's real auth upstream
// without leaking tokens into argv, logs, or test fixtures.

import type { ClaudeCodeAuthMaterial } from '../claude-code-credentials.js';
import { CLAUDE_CODE_USER_AGENT } from '../oauth/claude-identity.js';

const OAUTH_BETA = 'oauth-2025-04-20';

function headerNameEquals(name: string, expected: string): boolean {
  return name.toLowerCase() === expected.toLowerCase();
}

function ensureOauthBeta(existing: string | undefined): string {
  if (!existing?.trim()) return OAUTH_BETA;
  const parts = existing.split(',').map(part => part.trim()).filter(Boolean);
  if (parts.some(part => part === OAUTH_BETA)) return parts.join(',');
  return [OAUTH_BETA, ...parts].join(',');
}

/** Rewrite Claude --bare placeholder auth into real Claude OAuth or API-key headers. */
export function rewriteUpstreamAuthHeaders(
  rawHeaders: string[],
  auth: ClaudeCodeAuthMaterial,
): string[] {
  const out: string[] = [];
  let sawAuthorization = false;
  let sawUserAgent = false;
  let sawXApp = false;
  let sawBeta = false;
  let sawApiKey = false;

  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] ?? '';
    const value = rawHeaders[i + 1] ?? '';
    if (headerNameEquals(name, 'authorization')) {
      sawAuthorization = true;
      out.push(name, `Bearer ${auth.token}`);
      continue;
    }
    if (headerNameEquals(name, 'x-api-key')) {
      sawApiKey = true;
      if (auth.kind === 'api_key') out.push(name, auth.token);
      continue;
    }
    if (headerNameEquals(name, 'user-agent')) {
      sawUserAgent = true;
      if (auth.kind === 'oauth') out.push(name, CLAUDE_CODE_USER_AGENT);
      else out.push(name, value);
      continue;
    }
    if (headerNameEquals(name, 'x-app')) {
      sawXApp = true;
      if (auth.kind === 'oauth') out.push(name, 'cli');
      else out.push(name, value);
      continue;
    }
    if (headerNameEquals(name, 'anthropic-beta')) {
      sawBeta = true;
      out.push(name, auth.kind === 'oauth' ? ensureOauthBeta(value) : value);
      continue;
    }
    out.push(name, value);
  }

  if (!sawAuthorization) out.push('Authorization', `Bearer ${auth.token}`);
  if (auth.kind === 'api_key' && !sawApiKey) out.push('x-api-key', auth.token);
  if (auth.kind === 'oauth') {
    if (!sawUserAgent) out.push('User-Agent', CLAUDE_CODE_USER_AGENT);
    if (!sawXApp) out.push('x-app', 'cli');
    if (!sawBeta) out.push('anthropic-beta', OAUTH_BETA);
  }
  return out;
}
