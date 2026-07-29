import { describe, expect, it } from 'vitest';
import {
  advanceCheckpoint,
  boundedDigest,
  conversationFingerprint,
  createInitialCheckpoint,
  digestMessages,
  isSupportedCheckpoint,
  verifyConversationResend,
  type ExecutionCheckpoint,
} from '../src/execution-checkpoint.js';

const messages = [
  { role: 'system', content: 'be helpful' },
  { role: 'user', content: [{ type: 'text', text: 'hello there' }] },
];

describe('boundedDigest', () => {
  it('never returns the original content, only a fixed-length sha256 hex digest and a byte count', () => {
    const result = boundedDigest('super secret prompt text');
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.byteCount).toBe(Buffer.byteLength('super secret prompt text', 'utf8'));
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('truncates the hashed material for pathologically large input but still reports the true byte count', () => {
    const huge = 'x'.repeat(200 * 1024);
    const result = boundedDigest(huge);
    expect(result.byteCount).toBe(200 * 1024);
    const truncated = boundedDigest('x'.repeat(64 * 1024));
    expect(result.digest).toBe(truncated.digest);
  });
});

describe('digestMessages / conversationFingerprint', () => {
  it('produces one bounded digest per message, never the raw content', () => {
    const digests = digestMessages(messages);
    expect(digests).toHaveLength(2);
    expect(digests[0]).toMatchObject({ role: 'system', index: 0 });
    expect(digests[1]).toMatchObject({ role: 'user', index: 1 });
    for (const d of digests) expect(d.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(digests)).not.toContain('hello there');
  });

  it('is stable for identical input and sensitive to any change', () => {
    const a = conversationFingerprint(messages);
    const b = conversationFingerprint(messages);
    const c = conversationFingerprint([...messages, { role: 'user', content: 'one more' }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('checkpoint allowlist validation', () => {
  it('accepts a well-formed checkpoint produced by createInitialCheckpoint', () => {
    const checkpoint = createInitialCheckpoint({
      executionId: 'exec-1',
      requestId: 'req-1',
      provider: 'anthropic',
      model: 'claude-sonnet',
      route: 'passthrough',
      messages,
    });
    expect(isSupportedCheckpoint(checkpoint as unknown as Record<string, unknown>)).toBe(true);
  });

  it('rejects a document carrying a forbidden secret-shaped field even if every allowlisted field is otherwise valid', () => {
    const checkpoint = createInitialCheckpoint({
      executionId: 'exec-1',
      requestId: 'req-1',
      provider: 'anthropic',
      model: 'claude-sonnet',
      route: 'passthrough',
      messages,
    });
    const poisoned = { ...checkpoint, apiKey: 'sk-should-never-be-here' };
    expect(isSupportedCheckpoint(poisoned as unknown as Record<string, unknown>)).toBe(false);
  });

  it('rejects a document missing required identity fields', () => {
    expect(isSupportedCheckpoint({} as Record<string, unknown>)).toBe(false);
  });

  it('rejects an unknown route value', () => {
    const checkpoint = createInitialCheckpoint({
      executionId: 'exec-1',
      requestId: 'req-1',
      provider: 'anthropic',
      model: 'claude-sonnet',
      route: 'passthrough',
      messages,
    });
    const bad = { ...checkpoint, route: 'nonsense' };
    expect(isSupportedCheckpoint(bad as unknown as Record<string, unknown>)).toBe(false);
  });
});

describe('generation and update tracking', () => {
  it('starts a fresh checkpoint at generation 1', () => {
    const checkpoint = createInitialCheckpoint({
      executionId: 'exec-1',
      requestId: 'req-1',
      provider: 'anthropic',
      model: 'claude-sonnet',
      route: 'passthrough',
      messages,
    });
    expect(checkpoint.generation).toBe(1);
    expect(checkpoint.toolCalls).toEqual([]);
    expect(checkpoint.visibleTextByteCount).toBe(0);
  });

  it('advanceCheckpoint always increments the generation and refreshes updatedAt', () => {
    let now = 1000;
    const checkpoint = createInitialCheckpoint({
      executionId: 'exec-1',
      requestId: 'req-1',
      provider: 'anthropic',
      model: 'claude-sonnet',
      route: 'passthrough',
      messages,
      now: () => now,
    });
    now = 2000;
    const next: ExecutionCheckpoint = advanceCheckpoint({
      checkpoint,
      patch: { visibleTextByteCount: 42 },
      now: () => now,
    });
    expect(next.generation).toBe(2);
    expect(next.visibleTextByteCount).toBe(42);
    expect(next.updatedAt).not.toBe(checkpoint.updatedAt);
    expect(next.createdAt).toBe(checkpoint.createdAt);
  });
});

describe('verifyConversationResend', () => {
  it('accepts an exact resend and rejects any drift', () => {
    const checkpoint = createInitialCheckpoint({
      executionId: 'exec-1',
      requestId: 'req-1',
      provider: 'anthropic',
      model: 'claude-sonnet',
      route: 'passthrough',
      messages,
    });
    expect(verifyConversationResend(checkpoint, messages)).toBe(true);
    expect(verifyConversationResend(checkpoint, [...messages, { role: 'user', content: 'extra' }])).toBe(false);
  });
});
