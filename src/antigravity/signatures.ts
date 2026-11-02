import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJsonSync } from '../atomic-file.js';
import { getAppHome } from '../paths.js';
import { withRegistryWriteLockSync } from '../registry/lock.js';
import { AntigravityError, objectRecord } from './types.js';

export interface AntigravitySignatureCodec {
  encode(rawId: string, signature?: string): string;
  decode(id: string): { rawId: string; thoughtSignature?: string };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function signatureError(): AntigravityError {
  return new AntigravityError('Antigravity tool signature state is missing or invalid. Restore this conversation state or start a new conversation.', 409);
}

function loadSignature(path: string, reference: string): { rawId: string; thoughtSignature: string } {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > 10 * 1024 * 1024) throw signatureError();
    const value = objectRecord(JSON.parse(readFileSync(path, 'utf8')));
    if (typeof value?.rawId !== 'string' || typeof value.signature !== 'string'
      || `agref_${digest(`${value.rawId}\0${value.signature}`)}` !== reference) throw signatureError();
    return { rawId: value.rawId, thoughtSignature: value.signature };
  } catch { throw signatureError(); }
}

function storeSignature(directory: string, rawId: string, signature: string): string {
  const reference = `agref_${digest(`${rawId}\0${signature}`)}`;
  const target = join(directory, `${reference}.json`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return withRegistryWriteLockSync(() => {
    const files = readdirSync(directory).filter(name => name.endsWith('.json'));
    if (files.includes(`${reference}.json`)) {
      loadSignature(target, reference);
      return reference;
    }
    const payload = { rawId, signature };
    const size = files.reduce((total, file) => total + lstatSync(join(directory, file)).size, Buffer.byteLength(JSON.stringify(payload)));
    if (files.length >= 1000 || size > 10 * 1024 * 1024) {
      throw new AntigravityError('Antigravity conversation signature storage is full. Start a new conversation.', 409);
    }
    atomicWriteJsonSync(target, payload, { mode: 0o600, directoryMode: 0o700 });
    return reference;
  }, { lockPath: join(directory, 'signatures.lock'), waitMs: 1000 });
}

export function createAntigravitySignatureCodec(scope: { accountId: string; sessionId: string }): AntigravitySignatureCodec {
  if (!scope.accountId || !scope.sessionId) throw signatureError();
  const directory = join(getAppHome(), 'antigravity', 'signatures', digest(scope.accountId), digest(scope.sessionId));
  return {
    encode(rawId, signature) {
      if (signature === undefined) return rawId;
      if (!rawId || rawId.length > 4096 || Buffer.byteLength(signature) > 10 * 1024 * 1024) throw signatureError();
      return storeSignature(directory, rawId, signature);
    },
    decode(id) {
      if (!id.startsWith('agref_')) return { rawId: id };
      if (!/^agref_[a-f0-9]{64}$/.test(id)) throw signatureError();
      return loadSignature(join(directory, `${id}.json`), id);
    },
  };
}
