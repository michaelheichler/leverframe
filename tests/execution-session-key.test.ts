import { describe, expect, it } from 'vitest';
import { resolveExecutionSessionKey } from '../src/execution-session-key.js';
import { workspaceOrSessionHash } from '../src/checkpoint-store.js';

describe('resolveExecutionSessionKey', () => {
  it('is stable for the same session id regardless of provider/model', () => {
    const a = resolveExecutionSessionKey({ claudeSessionId: 'sess-1', provider: 'anthropic', model: 'claude-x' });
    const b = resolveExecutionSessionKey({ claudeSessionId: 'sess-1', provider: 'openai', model: 'gpt-y' });
    expect(a).toBe(b);
    expect(workspaceOrSessionHash(a)).toBe(workspaceOrSessionHash(b));
  });

  it('gives distinct keys (and hashes) for distinct session ids', () => {
    const a = resolveExecutionSessionKey({ claudeSessionId: 'sess-1', provider: 'anthropic', model: 'claude-x' });
    const b = resolveExecutionSessionKey({ claudeSessionId: 'sess-2', provider: 'anthropic', model: 'claude-x' });
    expect(a).not.toBe(b);
    expect(workspaceOrSessionHash(a)).not.toBe(workspaceOrSessionHash(b));
  });

  it('falls back to a provider+model scope when no session id is present', () => {
    const a = resolveExecutionSessionKey({ provider: 'anthropic', model: 'claude-x' });
    const b = resolveExecutionSessionKey({ provider: 'anthropic', model: 'claude-x' });
    expect(a).toBe(b);
  });

  it('gives distinct anonymous scopes for distinct provider/model pairs', () => {
    const a = resolveExecutionSessionKey({ provider: 'anthropic', model: 'claude-x' });
    const b = resolveExecutionSessionKey({ provider: 'anthropic', model: 'claude-y' });
    const c = resolveExecutionSessionKey({ provider: 'openai', model: 'claude-x' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it('rejects unsafe/malformed session ids and falls back to the anonymous scope', () => {
    const unsafe = resolveExecutionSessionKey({ claudeSessionId: 'sess\n1; rm -rf', provider: 'anthropic', model: 'claude-x' });
    const anon = resolveExecutionSessionKey({ provider: 'anthropic', model: 'claude-x' });
    expect(unsafe).toBe(anon);
  });

  it('rejects an empty/whitespace session id and falls back to the anonymous scope', () => {
    const empty = resolveExecutionSessionKey({ claudeSessionId: '   ', provider: 'anthropic', model: 'claude-x' });
    const anon = resolveExecutionSessionKey({ provider: 'anthropic', model: 'claude-x' });
    expect(empty).toBe(anon);
  });

  it('treats blank provider/model as a stable named fallback rather than colliding silently across calls', () => {
    const a = resolveExecutionSessionKey({ provider: '', model: '' });
    const b = resolveExecutionSessionKey({ provider: '  ', model: '  ' });
    expect(a).toBe(b);
    expect(a).toBe('anon:unknown-provider:unknown-model');
  });
});
