import { validateEncryptedMemoryRecord, type EncryptedMemoryRecord } from './encrypted-memory.js';
import { validateVectorMemoryRow, type VectorMemoryRow } from './vector-memory.js';

export const DEFAULT_MEMORY_RETENTION_DAYS = 30;

export type MemoryRetentionPlan = Readonly<{
  cutoff: string;
  expiredPayloadContentIds: readonly string[];
  expiredVectorContentIds: readonly string[];
  orphanPayloadContentIds: readonly string[];
  orphanVectorContentIds: readonly string[];
  quarantinedContentIds: readonly string[];
  retainedPairs: readonly Readonly<{ contentId: string; payloadDigest: string }>[];
}>;

function invalid(): never {
  throw new Error('encrypted memory retention input is invalid');
}

function validTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) invalid();
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) invalid();
  return parsed;
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

export function planMemoryRetention(input: Readonly<{
  now: string;
  retentionDays?: number;
  payloads: readonly unknown[];
  vectors: readonly VectorMemoryRow[];
}>): MemoryRetentionPlan {
  const now = validTimestamp(input.now);
  const retentionDays = input.retentionDays ?? DEFAULT_MEMORY_RETENTION_DAYS;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650) invalid();
  const cutoffTime = now - retentionDays * 86_400_000;
  const cutoff = new Date(cutoffTime).toISOString();
  let payloads: readonly EncryptedMemoryRecord[];
  let vectors: readonly VectorMemoryRow[];
  try {
    payloads = input.payloads.map(validateEncryptedMemoryRecord);
    vectors = input.vectors.map(validateVectorMemoryRow);
  } catch {
    invalid();
  }
  const payloadById = new Map<string, EncryptedMemoryRecord>();
  for (const payload of payloads) {
    if (payloadById.has(payload.contentId) || validTimestamp(payload.createdAt) > now) invalid();
    payloadById.set(payload.contentId, payload);
  }
  const vectorById = new Map<string, VectorMemoryRow>();
  for (const vector of vectors) {
    if (vectorById.has(vector.contentId) || validTimestamp(vector.timestamp) > now) invalid();
    vectorById.set(vector.contentId, vector);
  }
  const expiredPayload = new Set<string>();
  const expiredVector = new Set<string>();
  const orphanPayload = new Set<string>();
  const orphanVector = new Set<string>();
  const quarantined = new Set<string>();
  const retainedPairs: { contentId: string; payloadDigest: string }[] = [];
  for (const payload of payloads) {
    const vector = vectorById.get(payload.contentId);
    if (!vector) {
      if (validTimestamp(payload.createdAt) < cutoffTime) expiredPayload.add(payload.contentId);
      else orphanPayload.add(payload.contentId);
      continue;
    }
    if (vector.payloadDigest !== payload.payloadDigest) {
      quarantined.add(payload.contentId);
      continue;
    }
    if (validTimestamp(payload.createdAt) < cutoffTime || validTimestamp(vector.timestamp) < cutoffTime) {
      expiredPayload.add(payload.contentId);
      expiredVector.add(payload.contentId);
    } else {
      retainedPairs.push({ contentId: payload.contentId, payloadDigest: payload.payloadDigest });
    }
  }
  for (const vector of vectors) {
    if (!payloadById.has(vector.contentId)) {
      if (validTimestamp(vector.timestamp) < cutoffTime) expiredVector.add(vector.contentId);
      else orphanVector.add(vector.contentId);
    }
  }
  retainedPairs.sort((left, right) => left.contentId.localeCompare(right.contentId));
  return Object.freeze({ cutoff, expiredPayloadContentIds: sorted(expiredPayload), expiredVectorContentIds: sorted(expiredVector), orphanPayloadContentIds: sorted(orphanPayload), orphanVectorContentIds: sorted(orphanVector), quarantinedContentIds: sorted(quarantined), retainedPairs: Object.freeze(retainedPairs.map(pair => Object.freeze(pair))) });
}
