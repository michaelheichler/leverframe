import { describe, expect, it } from 'vitest';
import { encryptMemoryPayload } from '../src/context/encrypted-memory.js';
import { planMemoryRetention } from '../src/context/memory-retention.js';
import { validateVectorMemoryRow } from '../src/context/vector-memory.js';

const key = new Uint8Array(32).fill(9);
const digest = (value: string): string => 'lfcd1_' + value.repeat(64).slice(0, 64);
const payload = (contentId: string, createdAt: string, text: string) => encryptMemoryPayload({ key, workspaceId: digest('a'), sessionDigest: digest('b'), role: 'main', contentId, generation: 1, sourceKind: 'summary', createdAt, plaintext: text, nonce: () => new Uint8Array(12).fill(text.length) });
const vector = (contentId: string, payloadDigest: string, timestamp: string) => validateVectorMemoryRow({ version: 1, contentId, vector: [1, ...Array.from({ length: 1023 }, () => 0)], workspaceDigest: digest('a'), sessionDigest: digest('b'), role: 'main', timestamp, sourceKind: 'summary', modelRevision: 'model-r1', payloadDigest });

describe('memory retention planning', () => {
  it('keeps the exact 30-day boundary, deletes only expired valid pairs, and sorts output', () => {
    const now = '2026-08-08T12:00:00.000Z';
    const boundary = payload(digest('b'), '2026-07-09T12:00:00.000Z', 'boundary');
    const expired = payload(digest('a'), '2026-07-09T11:59:59.999Z', 'expired');
    const validBoundary = vector(boundary.contentId, boundary.payloadDigest, boundary.createdAt);
    const validExpired = vector(expired.contentId, expired.payloadDigest, expired.createdAt);
    const plan = planMemoryRetention({ now, payloads: [expired, boundary], vectors: [validExpired, validBoundary] });
    expect(plan.expiredPayloadContentIds).toEqual([expired.contentId]);
    expect(plan.expiredVectorContentIds).toEqual([expired.contentId]);
    expect(plan.retainedPairs).toEqual([{ contentId: boundary.contentId, payloadDigest: boundary.payloadDigest }]);
  });

  it('reports orphans, quarantines digest mismatches, and is deterministic', () => {
    const now = '2026-08-08T12:00:00.000Z';
    const onlyPayload = payload(digest('c'), now, 'payload');
    const onlyVectorPayload = payload(digest('d'), now, 'vector source');
    const mismatchPayload = payload(digest('e'), now, 'mismatch');
    const rows = [vector(onlyVectorPayload.contentId, onlyVectorPayload.payloadDigest, now), vector(mismatchPayload.contentId, digest('f'), now)];
    const first = planMemoryRetention({ now, payloads: [mismatchPayload, onlyPayload], vectors: rows });
    const second = planMemoryRetention({ now, payloads: [mismatchPayload, onlyPayload], vectors: rows });
    expect(first).toEqual(second);
    expect(first.orphanPayloadContentIds).toEqual([onlyPayload.contentId]);
    expect(first.orphanVectorContentIds).toEqual([onlyVectorPayload.contentId]);
    expect(first.quarantinedContentIds).toEqual([mismatchPayload.contentId]);
  });

  it('rejects malformed payloads before planning and redacts their fields', () => {
    const malformed = { ...payload(digest('a'), '2026-08-08T12:00:00.000Z', 'payload'), unexpected: 'secret-field' } as unknown;
    expect(() => planMemoryRetention({ now: '2026-08-08T12:00:00.000Z', payloads: [malformed], vectors: [] })).toThrow('encrypted memory retention input is invalid');
    try { planMemoryRetention({ now: '2026-08-08T12:00:00.000Z', payloads: [malformed], vectors: [] }); } catch (error) { expect(String(error)).not.toContain('secret-field'); }
  });

  it('rejects impossible retention timestamps', () => {
    expect(() => planMemoryRetention({ now: '2026-02-30T12:00:00.000Z', payloads: [], vectors: [] })).toThrow('encrypted memory retention input is invalid');
  });
});