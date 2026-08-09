import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_TEXT_BYTES = 1_048_576;
const MAX_FIELD_LENGTH = 256;
const VERSION = 1;
const DIGEST_PREFIX = 'lfcd1_';

export type MemorySecurityErrorCode = 'invalid_key' | 'malformed_record' | 'authentication_failed' | 'digest_mismatch';

export class MemorySecurityError extends Error {
  readonly code: MemorySecurityErrorCode;

  constructor(code: MemorySecurityErrorCode) {
    super(`encrypted memory ${code}`);
    this.name = 'MemorySecurityError';
    this.code = code;
  }
}

export type EncryptedMemoryRecord = Readonly<{
  version: 1;
  workspaceId: string;
  sessionDigest: string;
  role: string;
  contentId: string;
  generation: number;
  sourceKind: string;
  payloadDigest: string;
  createdAt: string;
  modelRevision: string | null;
  nonce: string;
  ciphertext: string;
  tag: string;
}>;

export type EncryptMemoryPayloadInput = Readonly<{
  key: Uint8Array;
  workspaceId: string;
  sessionDigest: string;
  role: string;
  contentId: string;
  generation: number;
  sourceKind: string;
  createdAt: string;
  modelRevision?: string | null;
  plaintext: string | Uint8Array;
  nonce?: () => Uint8Array;
}>;

const recordFields = ['version', 'workspaceId', 'sessionDigest', 'role', 'contentId', 'generation', 'sourceKind', 'payloadDigest', 'createdAt', 'modelRevision', 'nonce', 'ciphertext', 'tag'];

function securityError(code: MemorySecurityErrorCode): never {
  throw new MemorySecurityError(code);
}

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) securityError('invalid_key');
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function decode(value: unknown, expectedBytes?: number): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_BYTES || !/^[A-Za-z0-9_-]+$/.test(value)) securityError('malformed_record');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value || expectedBytes !== undefined && decoded.byteLength !== expectedBytes) securityError('malformed_record');
  return decoded;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function assertText(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FIELD_LENGTH || hasControlCharacter(value)) securityError('malformed_record');
  if (name === 'digest' && !/^lfcd1_[0-9a-f]{64}$/.test(value)) securityError('malformed_record');
}

function assertTimestamp(value: unknown): asserts value is string {
  assertText(value, 'timestamp');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) securityError('malformed_record');
}

function assertMetadata(input: Omit<EncryptMemoryPayloadInput, 'key' | 'plaintext' | 'nonce'>): void {
  assertText(input.workspaceId, 'workspace');
  assertText(input.sessionDigest, 'digest');
  assertText(input.role, 'role');
  assertText(input.contentId, 'content');
  assertText(input.sourceKind, 'source');
  assertTimestamp(input.createdAt);
  if (!Number.isSafeInteger(input.generation) || input.generation < 0 || input.generation > 0xffffffff) securityError('malformed_record');
  if (input.modelRevision !== null && input.modelRevision !== undefined) assertText(input.modelRevision, 'model');
}

function aadFor(record: Pick<EncryptedMemoryRecord, 'version' | 'workspaceId' | 'sessionDigest' | 'role' | 'contentId' | 'generation' | 'sourceKind' | 'payloadDigest' | 'createdAt' | 'modelRevision'>): Buffer {
  return Buffer.from(JSON.stringify([record.version, record.workspaceId, record.sessionDigest, record.role, record.contentId, record.generation, record.sourceKind, record.payloadDigest, record.createdAt, record.modelRevision]), 'utf8');
}

export function keyedContentDigest(key: Uint8Array, input: string | Uint8Array): string {
  assertKey(key);
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_TEXT_BYTES) securityError('malformed_record');
  return `${DIGEST_PREFIX}${createHmac('sha256', key).update('leverframe:memory-content:v1\0').update(bytes).digest('hex')}`;
}

export function encryptMemoryPayload(input: EncryptMemoryPayloadInput): EncryptedMemoryRecord {
  assertKey(input.key);
  assertMetadata(input);
  const plaintext = typeof input.plaintext === 'string' ? Buffer.from(input.plaintext, 'utf8') : Buffer.from(input.plaintext);
  if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_TEXT_BYTES) securityError('malformed_record');
  const nonce = input.nonce ? Buffer.from(input.nonce()) : randomBytes(NONCE_BYTES);
  if (nonce.byteLength !== NONCE_BYTES) securityError('malformed_record');
  const metadata = { version: 1 as const, workspaceId: input.workspaceId, sessionDigest: input.sessionDigest, role: input.role, contentId: input.contentId, generation: input.generation, sourceKind: input.sourceKind, payloadDigest: keyedContentDigest(input.key, plaintext), createdAt: input.createdAt, modelRevision: input.modelRevision ?? null };
  const cipher = createCipheriv('aes-256-gcm', input.key, nonce);
  cipher.setAAD(aadFor(metadata));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Object.freeze({ ...metadata, nonce: encode(nonce), ciphertext: encode(ciphertext), tag: encode(cipher.getAuthTag()) });
}

export function validateEncryptedMemoryRecord(record: unknown): EncryptedMemoryRecord {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) securityError('malformed_record');
  const candidate = record as Record<string, unknown>;
  if (Object.keys(candidate).sort().join('\0') !== recordFields.slice().sort().join('\0')) securityError('malformed_record');
  if (candidate.version !== VERSION) securityError('malformed_record');
  assertText(candidate.workspaceId, 'workspace');
  assertText(candidate.sessionDigest, 'digest');
  assertText(candidate.role, 'role');
  assertText(candidate.contentId, 'content');
  assertText(candidate.sourceKind, 'source');
  assertText(candidate.payloadDigest, 'digest');
  assertTimestamp(candidate.createdAt);
  if (candidate.modelRevision !== null) assertText(candidate.modelRevision, 'model');
  if (!Number.isSafeInteger(candidate.generation) || (candidate.generation as number) < 0 || (candidate.generation as number) > 0xffffffff) securityError('malformed_record');
  const generation = candidate.generation as number;
  const nonce = decode(candidate.nonce, NONCE_BYTES);
  const ciphertext = decode(candidate.ciphertext);
  const tag = decode(candidate.tag, TAG_BYTES);
  return Object.freeze({ version: 1, workspaceId: candidate.workspaceId, sessionDigest: candidate.sessionDigest, role: candidate.role, contentId: candidate.contentId, generation, sourceKind: candidate.sourceKind, payloadDigest: candidate.payloadDigest, createdAt: candidate.createdAt, modelRevision: candidate.modelRevision as string | null, nonce: encode(nonce), ciphertext: encode(ciphertext), tag: encode(tag) });
}

export function decryptMemoryPayload(key: Uint8Array, input: unknown): string {
  assertKey(key);
  const record = validateEncryptedMemoryRecord(input);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, decode(record.nonce, NONCE_BYTES));
    decipher.setAAD(aadFor(record));
    decipher.setAuthTag(decode(record.tag, TAG_BYTES));
    const plaintext = Buffer.concat([decipher.update(decode(record.ciphertext)), decipher.final()]);
    if (keyedContentDigest(key, plaintext) !== record.payloadDigest) securityError('digest_mismatch');
    return plaintext.toString('utf8');
  } catch (error) {
    if (error instanceof MemorySecurityError) throw error;
    securityError('authentication_failed');
  }
}