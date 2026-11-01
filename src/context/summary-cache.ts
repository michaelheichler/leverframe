import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { withConfigWriteLock } from '../config-lock.js';
import { durableAtomicWrite, readFileStrict } from '../durable-io.js';
import { getAppHome } from '../paths.js';

interface Entry { reference: string; createdAt: number }
type Index = Record<string, Entry>;
const TTL = 30 * 86_400_000;

function indexPath(): string { return join(getAppHome(), 'summary-cache-index.json'); }
function keyHash(key: string): string { return createHash('sha256').update(key).digest('hex'); }

function readIndex(): Index {
  const path = indexPath();
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileStrict(path, { requirePrivateMode: true, maxBytes: 2_000_000 }));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid summary cache');
  const index = value as Index;
  if (!Object.entries(index).every(([key, entry]) => /^[a-f0-9]{64}$/.test(key) && entry && /^lfe1_[a-f0-9]{48}$/.test(entry.reference) && Number.isSafeInteger(entry.createdAt))) throw new Error('invalid summary cache');
  return index;
}

export function findSummaryCache(key: string): string | undefined {
  return withConfigWriteLock(() => {
    const entry = readIndex()[keyHash(key)];
    const age = entry ? Date.now() - entry.createdAt : -1;
    return entry && age >= 0 && age < TTL ? entry.reference : undefined;
  });
}

export function saveSummaryCache(key: string, reference: string): void {
  if (!/^lfe1_[a-f0-9]{48}$/.test(reference)) throw new Error('invalid summary cache reference');
  withConfigWriteLock(() => {
    const index = readIndex();
    const now = Date.now();
    for (const [id, entry] of Object.entries(index)) if (now - entry.createdAt >= TTL) delete index[id];
    index[keyHash(key)] = { reference, createdAt: now };
    durableAtomicWrite(indexPath(), `${JSON.stringify(index)}\n`);
  });
}
