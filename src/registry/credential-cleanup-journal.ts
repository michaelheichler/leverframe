import { existsSync } from 'node:fs';
import { getCredentialCleanupPath } from '../paths.js';
import { durableAtomicWrite, readFileStrict } from '../durable-io.js';
import { parseAuthRef } from '../env.js';
import {
  assertRegistryWriteOwnership,
  withRegistryWriteLock,
} from './lock.js';
import { isValidProviderId } from './validate.js';

const JOURNAL_SCHEMA_VERSION = 1;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_PENDING = 1024;
const MAX_REF_BYTES = 4096;
const CREDENTIAL_INSTANCE_SEPARATOR = '::credential::';
const CREDENTIAL_INSTANCE_PATTERN = /^v1:[0-9a-f]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CredentialCleanupJournal {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  pendingCredentialDeletes: string[];
}

function emptyJournal(): CredentialCleanupJournal {
  return { schemaVersion: JOURNAL_SCHEMA_VERSION, pendingCredentialDeletes: [] };
}

function accountBase(account: string): string | null {
  const index = account.lastIndexOf(CREDENTIAL_INSTANCE_SEPARATOR);
  if (index === -1) return account;
  if (
    index === 0
    || account.indexOf(CREDENTIAL_INSTANCE_SEPARATOR) !== index
    || !CREDENTIAL_INSTANCE_PATTERN.test(account.slice(index + CREDENTIAL_INSTANCE_SEPARATOR.length))
  ) return null;
  return account.slice(0, index);
}

function isManagedAccount(account: string): boolean {
  const base = accountBase(account);
  if (!base) return false;
  const oauth = /^oauth:provider:(.+)$/.exec(base);
  if (oauth) return isValidProviderId(oauth[1]!);
  const provider = /^provider:([^:]+)(?::(.+))?$/.exec(base);
  if (!provider || !isValidProviderId(provider[1]!)) return false;
  const suffix = provider[2];
  if (!suffix) return true;
  if (UUID_PATTERN.test(suffix)) return true;
  return suffix.startsWith('replacement:') && UUID_PATTERN.test(suffix.slice('replacement:'.length));
}

export function isStoredCredentialRef(value: string): boolean {
  const parsed = parseAuthRef(value);
  return parsed?.kind === 'keyring' && isManagedAccount(parsed.account);
}

function normalize(values: unknown[]): string[] {
  if (values.length > MAX_PENDING) throw new Error('Credential cleanup journal contains too many pending entries.');
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (
      typeof value !== 'string'
      || Buffer.byteLength(value) > MAX_REF_BYTES
      || !isStoredCredentialRef(value)
    ) throw new Error(`Credential cleanup journal has an invalid entry at index ${index}.`);
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function parseJournal(raw: unknown): CredentialCleanupJournal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Credential cleanup journal must be a JSON object.');
  }
  const data = raw as Record<string, unknown>;
  const keys = Object.keys(data);
  if (keys.length !== 2 || !keys.includes('schemaVersion') || !keys.includes('pendingCredentialDeletes')) {
    throw new Error('Credential cleanup journal has unexpected fields.');
  }
  if (data.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    throw new Error('Unsupported credential cleanup journal schema.');
  }
  if (!Array.isArray(data.pendingCredentialDeletes)) {
    throw new Error('Credential cleanup journal is missing its pending list.');
  }
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    pendingCredentialDeletes: normalize(data.pendingCredentialDeletes),
  };
}

function readUnlocked(path: string): CredentialCleanupJournal {
  if (!existsSync(path)) return emptyJournal();
  try {
    const raw = readFileStrict(path, {
      maxBytes: MAX_JOURNAL_BYTES,
      requirePrivateMode: true,
      description: 'Credential cleanup journal',
    });
    return parseJournal(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Could not read credential cleanup journal: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeUnlocked(journal: CredentialCleanupJournal, path: string): void {
  assertRegistryWriteOwnership(path);
  durableAtomicWrite(path, `${JSON.stringify(journal, null, 2)}\n`, {
    fence: () => assertRegistryWriteOwnership(path),
  });
}

function lockPath(path: string): string {
  return `${path}.lock`;
}

export function loadPendingCredentialDeletes(path = getCredentialCleanupPath()): Promise<string[]> {
  return withRegistryWriteLock(
    () => [...readUnlocked(path).pendingCredentialDeletes],
    { lockPath: lockPath(path) },
  );
}

async function updatePending(
  update: (pending: string[]) => string[],
  path = getCredentialCleanupPath(),
): Promise<{ before: string[]; after: string[] }> {
  return withRegistryWriteLock(() => {
    const before = readUnlocked(path).pendingCredentialDeletes;
    const after = normalize(update([...before]));
    if (after.length !== before.length || after.some((value, index) => value !== before[index])) {
      writeUnlocked({ schemaVersion: JOURNAL_SCHEMA_VERSION, pendingCredentialDeletes: after }, path);
    }
    return { before, after };
  }, { lockPath: lockPath(path) });
}

export async function queueCredentialDelete(authRef: string): Promise<boolean> {
  if (!isStoredCredentialRef(authRef)) return false;
  const result = await updatePending(pending => pending.includes(authRef) ? pending : [...pending, authRef]);
  return result.after.includes(authRef);
}

export async function cancelCredentialDelete(authRef: string): Promise<boolean> {
  const result = await updatePending(pending => pending.filter(value => value !== authRef));
  return result.before.includes(authRef) && !result.after.includes(authRef);
}
