import { describe, expect, it } from 'vitest';
import { decryptMemoryPayload, encryptMemoryPayload, keyedContentDigest, MemorySecurityError, validateEncryptedMemoryRecord } from '../src/context/encrypted-memory.js';

const key = new Uint8Array(32).fill(7);
const metadata = { workspaceId: 'workspace:v1:opaque', sessionDigest: 'lfcd1_' + '1'.repeat(64), role: 'main', contentId: 'lfcd1_' + '2'.repeat(64), generation: 3, sourceKind: 'summary', createdAt: '2026-08-08T12:00:00.000Z', modelRevision: 'model-r1' };

describe('encrypted memory payloads', () => {
  it('round trips with an injected nonce and keeps plaintext out of records and errors', () => {
    const record = encryptMemoryPayload({ ...metadata, key, plaintext: 'fixture secret text', nonce: () => new Uint8Array(12).fill(1) });
    expect(decryptMemoryPayload(key, record)).toBe('fixture secret text');
    expect(JSON.stringify(record)).not.toContain('fixture secret text');
    expect(() => decryptMemoryPayload(new Uint8Array(32).fill(8), record)).toThrow(MemorySecurityError);
    try { decryptMemoryPayload(new Uint8Array(32).fill(8), record); } catch (error) { expect(String(error)).not.toContain('fixture secret text'); }
  });

  it('uses fresh nonces by default and rejects AAD, ciphertext, and tag tampering', () => {
    const first = encryptMemoryPayload({ ...metadata, key, plaintext: 'fixture payload' });
    const second = encryptMemoryPayload({ ...metadata, key, plaintext: 'fixture payload' });
    expect(first.nonce).not.toBe(second.nonce);
    expect(() => decryptMemoryPayload(key, { ...first, role: 'subagent' })).toThrow(MemorySecurityError);
    expect(() => decryptMemoryPayload(key, { ...first, ciphertext: first.ciphertext.slice(0, -1) + (first.ciphertext.endsWith('A') ? 'B' : 'A') })).toThrow(MemorySecurityError);
    expect(() => decryptMemoryPayload(key, { ...first, tag: first.tag.slice(0, -1) + (first.tag.endsWith('A') ? 'B' : 'A') })).toThrow(MemorySecurityError);
  });

  it('provides stable domain-separated keyed content digests', () => {
    expect(keyedContentDigest(key, 'fixture payload')).toBe(keyedContentDigest(key, new TextEncoder().encode('fixture payload')));
    expect(keyedContentDigest(key, 'fixture payload')).not.toBe(keyedContentDigest(key, 'fixture payload\0'));
    expect(keyedContentDigest(new Uint8Array(32).fill(8), 'fixture payload')).not.toBe(keyedContentDigest(key, 'fixture payload'));
  });

  it('rejects empty plaintext before creating an undecryptable record', () => {
    expect(() => encryptMemoryPayload({ ...metadata, key, plaintext: '' })).toThrow(MemorySecurityError);
    expect(() => keyedContentDigest(key, '')).toThrow(MemorySecurityError);
  });

  it('validates encrypted records without decrypting and returns an immutable record', () => {
    const record = encryptMemoryPayload({ ...metadata, key, plaintext: 'fixture payload', nonce: () => new Uint8Array(12).fill(2) });
    const validated = validateEncryptedMemoryRecord(record);
    expect(validated).toEqual(record);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(() => validateEncryptedMemoryRecord({ ...record, createdAt: '2026-02-30T12:00:00.000Z' })).toThrow(MemorySecurityError);
  });
});