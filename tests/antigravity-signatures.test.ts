import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAntigravitySignatureCodec } from '../src/antigravity/signatures.js';

async function withSignatureHome(operation: () => Promise<void> | void): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-antigravity-signatures-'));
  vi.stubEnv('LEVERFRAME_HOME', home);
  try {
    await operation();
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
}

describe('Antigravity tool signature references', () => {
  it.each([257, 4096])('round trips a %i-byte signature through a compact tool id', size => withSignatureHome(() => {
    const codec = createAntigravitySignatureCodec({ accountId: 'account-a', sessionId: 'session-a' });
    const signature = 's'.repeat(size);
    const reference = codec.encode('tool-1', signature);

    expect(reference.length).toBeLessThan(256);
    expect(codec.decode(reference)).toEqual({ rawId: 'tool-1', thoughtSignature: signature });
  }));

  it('restores a tool signature reference after a fresh module load', () => withSignatureHome(async () => {
    const codec = createAntigravitySignatureCodec({ accountId: 'account-a', sessionId: 'session-a' });
    const reference = codec.encode('tool-1', 'signature-from-prior-turn');
    vi.resetModules();

    const restarted = await import('../src/antigravity/signatures.js');
    expect(restarted.createAntigravitySignatureCodec({ accountId: 'account-a', sessionId: 'session-a' }).decode(reference))
      .toEqual({ rawId: 'tool-1', thoughtSignature: 'signature-from-prior-turn' });
  }));

  it('does not make a tool signature reference portable to another account', () => withSignatureHome(() => {
    const origin = createAntigravitySignatureCodec({ accountId: 'account-a', sessionId: 'session-a' });
    const reference = origin.encode('tool-1', 'private-signature');
    const otherAccount = createAntigravitySignatureCodec({ accountId: 'account-b', sessionId: 'session-a' });

    expect(() => otherAccount.decode(reference)).toThrow(/signature|reference|tool/i);
  }));

  it('does not make a tool signature reference portable to another session', () => withSignatureHome(() => {
    const origin = createAntigravitySignatureCodec({ accountId: 'account-a', sessionId: 'session-a' });
    const reference = origin.encode('tool-1', 'private-signature');
    const otherSession = createAntigravitySignatureCodec({ accountId: 'account-a', sessionId: 'session-b' });

    expect(() => otherSession.decode(reference)).toThrow(/signature|reference|tool/i);
  }));

  it('keeps unsigned legacy tool ids usable without creating signature state', () => withSignatureHome(() => {
    const codec = createAntigravitySignatureCodec({ accountId: 'account-a', sessionId: 'session-a' });

    expect(codec.decode('legacy-tool-id')).toEqual({ rawId: 'legacy-tool-id' });
  }));

  it('rejects a persisted signature reference whose backing state is missing', () => withSignatureHome(() => {
    const origin = createAntigravitySignatureCodec({ accountId: 'account-a', sessionId: 'session-a' });
    const reference = origin.encode('tool-1', 'private-signature');
    const emptyHome = mkdtempSync(join(tmpdir(), 'leverframe-antigravity-empty-signatures-'));
    vi.stubEnv('LEVERFRAME_HOME', emptyHome);
    try {
      const restartedWithoutState = createAntigravitySignatureCodec({ accountId: 'account-a', sessionId: 'session-a' });
      expect(() => restartedWithoutState.decode(reference)).toThrow(/signature|reference|tool/i);
    } finally {
      vi.unstubAllEnvs();
      rmSync(emptyHome, { recursive: true, force: true });
    }
  }));

  it('fails closed when persisted signature state is corrupted', () => {
    const home = mkdtempSync(join(tmpdir(), 'leverframe-antigravity-corrupt-signatures-'));
    vi.stubEnv('LEVERFRAME_HOME', home);
    try {
      const codec = createAntigravitySignatureCodec({ accountId: 'account-a', sessionId: 'session-a' });
      const reference = codec.encode('tool-1', 'private-signature');
      const files = readdirSync(home, { recursive: true }) as string[];
      const persistedFile = files.find(file => file.endsWith('.json'))!;
      writeFileSync(join(home, persistedFile), '{');

      expect(() => codec.decode(reference)).toThrow(/signature|state|conversation/i);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Antigravity signature storage limits', () => {
  it('refuses to persist a signature larger than the supported record size', () => withSignatureHome(() => {
    const codec = createAntigravitySignatureCodec({ accountId: 'account-a', sessionId: 'session-a' });

    expect(() => codec.encode('tool-1', 's'.repeat(11 * 1024 * 1024))).toThrow(/signature|size|full/i);
  }));

  it('refuses to decode a signature record larger than the supported record size', () => {
    const home = mkdtempSync(join(tmpdir(), 'leverframe-antigravity-large-signature-'));
    vi.stubEnv('LEVERFRAME_HOME', home);
    try {
      const codec = createAntigravitySignatureCodec({ accountId: 'account-a', sessionId: 'session-a' });
      const reference = codec.encode('tool-1', 'valid-signature');
      const files = readdirSync(home, { recursive: true }) as string[];
      const persistedFile = files.find(file => file.endsWith('.json'))!;
      writeFileSync(join(home, persistedFile), JSON.stringify({ rawId: 'tool-1', signature: 's'.repeat(11 * 1024 * 1024) }));

      expect(() => codec.decode(reference)).toThrow(/signature|size|state/i);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses new signature references after the supported entry capacity is reached', () => withSignatureHome(() => {
    const codec = createAntigravitySignatureCodec({ accountId: 'account-a', sessionId: 'session-a' });
    for (let index = 0; index < 1000; index += 1) codec.encode(`tool-${index}`, `signature-${index}`);

    expect(() => codec.encode('next-tool', 'next-signature')).toThrow(/full|storage|entry/i);
  }));
});
