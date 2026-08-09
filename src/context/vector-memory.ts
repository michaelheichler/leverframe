const VECTOR_DIMENSIONS = 1024;
const MAX_FIELD_LENGTH = 256;
const DIGEST_PATTERN = /^lfcd1_[0-9a-f]{64}$/;

export class VectorMetadataError extends Error {
  constructor() {
    super('encrypted memory vector metadata is invalid');
    this.name = 'VectorMetadataError';
  }
}

export type VectorMemoryRow = Readonly<{
  version: 1;
  contentId: string;
  vector: readonly number[];
  workspaceDigest: string;
  sessionDigest: string;
  role: string;
  timestamp: string;
  sourceKind: string;
  modelRevision: string;
  payloadDigest: string;
}>;

const fields = ['version', 'contentId', 'vector', 'workspaceDigest', 'sessionDigest', 'role', 'timestamp', 'sourceKind', 'modelRevision', 'payloadDigest'];

function invalid(): never {
  throw new VectorMetadataError();
}

function hasControlCharacter(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function text(value: unknown, digest = false): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FIELD_LENGTH || hasControlCharacter(value)) invalid();
  if (digest && !DIGEST_PATTERN.test(value)) invalid();
}

function timestamp(value: unknown): asserts value is string {
  text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
}

export function validateVectorMemoryRow(input: unknown): VectorMemoryRow {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid();
  const candidate = input as Record<string, unknown>;
  if (Object.keys(candidate).sort().join('\0') !== fields.slice().sort().join('\0') || candidate.version !== 1) invalid();
  text(candidate.contentId, true);
  text(candidate.workspaceDigest, true);
  text(candidate.sessionDigest, true);
  text(candidate.role);
  timestamp(candidate.timestamp);
  text(candidate.sourceKind);
  text(candidate.modelRevision);
  text(candidate.payloadDigest, true);
  if (!Array.isArray(candidate.vector) || candidate.vector.length !== VECTOR_DIMENSIONS) invalid();
  const vector = candidate.vector.map(value => {
    if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
    return value;
  });
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || Math.abs(magnitude - 1) > 1e-6) invalid();
  return Object.freeze({ version: 1, contentId: candidate.contentId, vector: Object.freeze(vector), workspaceDigest: candidate.workspaceDigest, sessionDigest: candidate.sessionDigest, role: candidate.role, timestamp: candidate.timestamp, sourceKind: candidate.sourceKind, modelRevision: candidate.modelRevision, payloadDigest: candidate.payloadDigest });
}
