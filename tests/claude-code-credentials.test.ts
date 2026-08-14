import { describe, expect, it } from 'vitest';
import {
  claudeCodeApiKeyServiceName,
  claudeCodeCredentialsServiceName,
  parseClaudeSecureStorageJson,
} from '../src/claude-code-credentials.js';

describe('parseClaudeSecureStorageJson', () => {
  it('reads claudeAiOauth.accessToken without retaining other fields in the return value', () => {
    const material = parseClaudeSecureStorageJson(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'oauth-access-token',
        refreshToken: 'oauth-refresh-token',
        expiresAt: 1,
      },
    }));
    expect(material).toEqual({ kind: 'oauth', token: 'oauth-access-token' });
  });

  it('returns null for malformed or empty storage payloads', () => {
    expect(parseClaudeSecureStorageJson('{')).toBeNull();
    expect(parseClaudeSecureStorageJson('{}')).toBeNull();
    expect(parseClaudeSecureStorageJson(JSON.stringify({ claudeAiOauth: {} }))).toBeNull();
  });
});

describe('claude keychain service names', () => {
  it('uses Claude Code-credentials for the default config dir', () => {
    expect(claudeCodeCredentialsServiceName({})).toBe('Claude Code-credentials');
    expect(claudeCodeApiKeyServiceName({})).toBe('Claude Code');
  });

  it('suffixes a stable hash when CLAUDE_CONFIG_DIR is overridden', () => {
    const env = { CLAUDE_CONFIG_DIR: '/tmp/custom-claude-config' };
    expect(claudeCodeCredentialsServiceName(env)).toMatch(/^Claude Code-credentials-[a-f0-9]{8}$/);
    expect(claudeCodeApiKeyServiceName(env)).toMatch(/^Claude Code-[a-f0-9]{8}$/);
  });
});

describe('readMacSecurityPassword', () => {
  it('returns stdout password and never requires stderr', async () => {
    const { readMacSecurityPassword } = await import('../src/claude-code-credentials.js');
    const { EventEmitter } = await import('node:events');
    const fakeSpawn = ((_cmd: string, _args: readonly string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter & { resume: () => void };
      };
      child.stdout = new EventEmitter();
      child.stderr = Object.assign(new EventEmitter(), { resume() { /* discard */ } });
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('secret-value\n'));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    await expect(readMacSecurityPassword('Claude Code-credentials', 'michael', fakeSpawn)).resolves.toBe(
      'secret-value',
    );
  });

  it('returns null when security exits non-zero', async () => {
    const { readMacSecurityPassword } = await import('../src/claude-code-credentials.js');
    const { EventEmitter } = await import('node:events');
    const fakeSpawn = (() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter & { resume: () => void };
      };
      child.stdout = new EventEmitter();
      child.stderr = Object.assign(new EventEmitter(), { resume() { /* discard */ } });
      queueMicrotask(() => child.emit('close', 44));
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    await expect(readMacSecurityPassword('Claude Code-credentials', 'michael', fakeSpawn)).resolves.toBeNull();
  });
});
