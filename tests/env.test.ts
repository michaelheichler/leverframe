import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildChildEnv,
  buildHttpProxyChildEnv,
  HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY,
  withProxyAnthropicOriginSettings,
} from '../src/env.js';

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

describe('buildHttpProxyChildEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lets the upstream provider enforce unknown-model context windows', () => {
    const env = buildHttpProxyChildEnv(9999, '/tmp/leverframe-ca.pem');

    expect(env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT).toBe('1');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
  });

  it('injects a placeholder Anthropic API key so Claude --bare can send MITM-routed requests', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    const env = buildHttpProxyChildEnv(9999, '/tmp/leverframe-ca.pem');
    expect(env.ANTHROPIC_API_KEY).toBe(HTTP_PROXY_ANTHROPIC_PLACEHOLDER_KEY);
  });

  it('does not overwrite a real Anthropic API key from the parent environment', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-user-key');
    const env = buildHttpProxyChildEnv(9999, '/tmp/leverframe-ca.pem');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-user-key');
  });
});

describe('withProxyAnthropicOriginSettings', () => {
  it('prepends --settings pinning ANTHROPIC_BASE_URL when the user did not pass --settings', () => {
    const out = withProxyAnthropicOriginSettings(['--bare', '--print', 'OK']);
    expect(out[0]).toBe('--settings');
    expect(JSON.parse(out[1]!)).toEqual({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } });
    expect(out.slice(2)).toEqual(['--bare', '--print', 'OK']);
  });

  it('does not override an explicit user --settings flag', () => {
    const args = ['--settings', '{"permissions":{"allow":["Bash"]}}', '--print', 'OK'];
    expect(withProxyAnthropicOriginSettings(args)).toEqual(args);
  });
});

