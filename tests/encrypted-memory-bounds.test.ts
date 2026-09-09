import { describe, expect, it } from 'vitest';
import { decryptMemoryPayload, encryptMemoryPayload, MemorySecurityError, validateEncryptedMemoryRecord } from '../src/context/encrypted-memory.js';

const key = new Uint8Array(32).fill(7);
const metadata = { workspaceId: 'workspace:fixture', sessionDigest: 'lfcd1_' + '1'.repeat(64), role: 'main', contentId: 'fixture', generation: 1, sourceKind: 'summary', createdAt: '2026-08-08T12:00:00.000Z' };
const maxBytes = 1_048_576;

describe('encrypted memory byte bounds', () => {
  it.each([786_432, 786_433, maxBytes - 1, maxBytes])('round trips %i plaintext bytes', size => {
    const plaintext = 'x'.repeat(size);
    const record = encryptMemoryPayload({ ...metadata, key, plaintext });
    expect(validateEncryptedMemoryRecord(record)).toEqual(record);
    expect(decryptMemoryPayload(key, record)).toBe(plaintext);
  });

  it('round trips multibyte UTF-8 at the byte limit', () => {
    const plaintext = '😀'.repeat(maxBytes / 4);
    const record = encryptMemoryPayload({ ...metadata, key, plaintext });
    expect(Buffer.byteLength(plaintext)).toBe(maxBytes);
    expect(decryptMemoryPayload(key, record)).toBe(plaintext);
    expect(() => encryptMemoryPayload({ ...metadata, key, plaintext: plaintext + 'x' })).toThrow(MemorySecurityError);
  });

  it('rejects oversized plaintext and decoded ciphertext', () => {
    expect(() => encryptMemoryPayload({ ...metadata, key, plaintext: new Uint8Array(maxBytes + 1) })).toThrow(MemorySecurityError);
    const record = encryptMemoryPayload({ ...metadata, key, plaintext: 'fixture' });
    for (const size of [maxBytes + 1, maxBytes + 2]) {
      const ciphertext = Buffer.alloc(size).toString('base64url');
      expect(() => validateEncryptedMemoryRecord({ ...record, ciphertext })).toThrow(MemorySecurityError);
    }
  });
});
