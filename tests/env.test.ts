import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildChildEnv } from '../src/env.js';

describe('buildChildEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not set a maximum context override without a confirmed window', () => {
    const env = buildChildEnv('http://127.0.0.1:9999', 'gpt-5.6-sol', 'token', 9999);

    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
  });

  it('removes an inherited maximum context override without a confirmed window', () => {
    vi.stubEnv('CLAUDE_CODE_MAX_CONTEXT_TOKENS', '1000000');

    const env = buildChildEnv('http://127.0.0.1:9999', 'gpt-5.6-sol', 'token', 9999);

    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
  });

  it('sets the maximum context override from a confirmed positive window', () => {
    const env = buildChildEnv('http://127.0.0.1:9999', 'gpt-5.6-sol', 'token', 9999, 272_000);

    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('272000');
  });
});
