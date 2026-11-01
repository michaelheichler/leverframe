import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { durableAtomicWrite, ensurePrivateDirectory, readFileStrict } from '../durable-io.js';
import { withRegistryWriteLock } from '../registry/lock.js';
import { decryptMemoryPayload, encryptMemoryPayload, keyedContentDigest, validateEncryptedMemoryRecord } from './encrypted-memory.js';

const RETENTION_MS = 30 * 86_400_000;
const DEFAULT_CAP = 32 * 1024 * 1024;
const REF = /^lfe1_[a-f0-9]{48}$/;

export interface EvidenceStore {
  put(sessionId: string, content: string): Promise<string>;
  get(sessionId: string, reference: string): Promise<string>;
}

function scanEvidence(options: { directory: string; key: Uint8Array; workspaceId: string; time: number; sessionDigest?: string; content?: string; ignoreInvalid?: boolean }): { total: number; reference?: string } {
  let total = 0;
  let reference: string | undefined;
  for (const name of readdirSync(options.directory).sort()) {
    if (!/^lfe1_[a-f0-9]{48}\.json$/.test(name)) continue;
    try {
      const path = join(options.directory, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe evidence');
      const record = validateEncryptedMemoryRecord(JSON.parse(readFileStrict(path, { requirePrivateMode: true, maxBytes: 1_500_000 })));
      const content = decryptMemoryPayload(options.key, record);
      const id = name.slice(0, -5);
      if (record.workspaceId !== options.workspaceId || record.contentId !== id) throw new Error('invalid evidence');
      const age = options.time - Date.parse(record.createdAt);
      if (age >= RETENTION_MS) unlinkSync(path);
      else {
        total += stat.size;
        if (age >= 0 && record.sessionDigest === options.sessionDigest && content === options.content) reference ??= id;
      }
    } catch (error) {
      if (!options.ignoreInvalid) throw error;
    }
  }
  return { total, reference };
}

export function createEvidenceStore(options: { directory: string; key: Uint8Array; workspaceId: string; maxBytes?: number; now?: () => number }): EvidenceStore {
  const { directory, key, workspaceId } = options;
  const cap = options.maxBytes ?? DEFAULT_CAP;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error('invalid evidence cap');
  const sessionDigest = (sessionId: string) => keyedContentDigest(key, sessionId);
  const pathFor = (reference: string) => {
    if (!REF.test(reference)) throw new Error('invalid evidence reference');
    return join(directory, `${reference}.json`);
  };
  const locked = <T>(operation: () => T) => {
    const parent = lstatSync(dirname(directory));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (typeof process.getuid === 'function' && parent.uid !== process.getuid())) throw new Error('unsafe evidence parent');
    ensurePrivateDirectory(directory);
    return withRegistryWriteLock(operation, { lockPath: join(directory, '.lock') });
  };
  const read = (reference: string) => validateEncryptedMemoryRecord(JSON.parse(readFileStrict(pathFor(reference), { requirePrivateMode: true, maxBytes: 1_500_000 })));
  const get = async (sessionId: string, reference: string): Promise<string> => locked(() => {
    pathFor(reference);
    const digest = sessionDigest(sessionId);
    scanEvidence({ directory, key, workspaceId, time: now(), ignoreInvalid: true });
    const record = read(reference);
    const age = now() - Date.parse(record.createdAt);
    if (record.workspaceId !== workspaceId || record.contentId !== reference || record.sessionDigest !== digest || age < 0 || age >= RETENTION_MS) throw new Error('evidence unavailable');
    return decryptMemoryPayload(key, record);
  });
  const put = async (sessionId: string, content: string): Promise<string> => locked(() => {
    const digest = sessionDigest(sessionId);
    const time = now();
    const existing = scanEvidence({ directory, key, workspaceId, time, sessionDigest: digest, content });
    if (existing.reference) return existing.reference;
    const reference = `lfe1_${randomBytes(24).toString('hex')}`;
    const record = encryptMemoryPayload({ key, workspaceId, sessionDigest: digest, role: 'tool', contentId: reference, generation: 0, sourceKind: 'tool_result', createdAt: new Date(time).toISOString(), plaintext: content });
    const payload = JSON.stringify(record);
    if (existing.total + Buffer.byteLength(payload) > cap) throw new Error('evidence capacity exceeded');
    durableAtomicWrite(pathFor(reference), payload);
    const saved = read(reference);
    if (decryptMemoryPayload(key, saved) !== content || saved.sessionDigest !== digest) throw new Error('evidence verification failed');
    return reference;
  });
  return { put, get };
}
