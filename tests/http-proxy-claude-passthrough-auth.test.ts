import { describe, expect, it } from 'vitest';
import { rewriteUpstreamAuthHeaders } from '../src/http-proxy/claude-passthrough-auth.js';
import { HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY } from '../src/env.js';
import { CLAUDE_CODE_USER_AGENT } from '../src/oauth/claude-identity.js';

describe('rewriteUpstreamAuthHeaders', () => {
  it('replaces placeholder Bearer auth with Claude OAuth headers', () => {
    const rewritten = rewriteUpstreamAuthHeaders([
      'Authorization', `Bearer ${HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY}`,
      'x-api-key', HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY,
      'anthropic-beta', 'claude-code-20250219',
      'Content-Type', 'application/json',
    ], { kind: 'oauth', token: 'claude-oauth-token' });

    const asObject = Object.fromEntries(
      Array.from({ length: rewritten.length / 2 }, (_, i) => [
        rewritten[i * 2]!.toLowerCase(),
        rewritten[i * 2 + 1],
      ]),
    );
    expect(asObject['authorization']).toBe('Bearer claude-oauth-token');
    expect(asObject['x-api-key']).toBeUndefined();
    expect(asObject['user-agent']).toBe(CLAUDE_CODE_USER_AGENT);
    expect(asObject['x-app']).toBe('cli');
    expect(asObject['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(rewritten.join('\0')).not.toContain(HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY);
  });

  it('keeps x-api-key when substituting a managed Claude API key', () => {
    const rewritten = rewriteUpstreamAuthHeaders([
      'Authorization', `Bearer ${HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY}`,
      'x-api-key', HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY,
    ], { kind: 'api_key', token: 'sk-ant-real-key' });
    expect(rewritten).toContain('x-api-key');
    expect(rewritten).toContain('sk-ant-real-key');
    expect(rewritten.join('\0')).not.toContain(HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY);
  });
});
