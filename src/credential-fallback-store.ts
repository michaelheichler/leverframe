import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { durableAtomicWrite, ensurePrivateDirectory, readFileStrict } from './durable-io.js';
import { getAppHome } from './paths.js';
import { withRegistryWriteLockSync } from './registry/lock.js';

const FALLBACK_FILE_NAME = 'credentials-fallback.json';
const MAX_FALLBACK_BYTES = 16 * 1024 * 1024;

interface FallbackFile {
  schemaVersion: 1;
  credentials: Record<string, string>;
}

export function getCredentialFallbackPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getAppHome(env), FALLBACK_FILE_NAME);
}

function emptyFallbackFile(): FallbackFile {
  return { schemaVersion: 1, credentials: Object.create(null) as Record<string, string> };
}

function readFallbackFile(path = getCredentialFallbackPath()): FallbackFile {
  if (!existsSync(path)) return emptyFallbackFile();
  const text = readFileStrict(path, {
    maxBytes: MAX_FALLBACK_BYTES,
    requirePrivateMode: true,
    description: 'Credential fallback file',
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Credential fallback file is corrupt: ${path}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Credential fallback file has an invalid format: ${path}`);
  }
  const record = parsed as Record<string, unknown>;
  const credentials = record.credentials;
  const fields = Object.keys(record);
  if (
    fields.length !== 2 || !fields.includes('schemaVersion') || !fields.includes('credentials')
    || record.schemaVersion !== 1 || !credentials || typeof credentials !== 'object' || Array.isArray(credentials)
  ) throw new Error(`Credential fallback file has an invalid format: ${path}`);
  for (const value of Object.values(credentials)) {
    if (typeof value !== 'string') throw new Error(`Credential fallback file has an invalid format: ${path}`);
  }
  return { schemaVersion: 1, credentials: Object.assign(Object.create(null), credentials) as Record<string, string> };
}

function writeFallbackFile(data: FallbackFile, path = getCredentialFallbackPath()): void {
  ensurePrivateDirectory(dirname(path));
  durableAtomicWrite(path, `${JSON.stringify(data, null, 2)}\n`);
}

function withFallbackLock<T>(path: string, operation: () => T): T {
  return withRegistryWriteLockSync(operation, { lockPath: `${path}.lock` });
}

export function readFallbackCredential(account: string, path = getCredentialFallbackPath()): string | null {
  return withFallbackLock(path, () => readFallbackFile(path).credentials[account] ?? null);
}

export function writeFallbackCredential(account: string, value: string, path = getCredentialFallbackPath()): void {
  withFallbackLock(path, () => {
    const data = readFallbackFile(path);
    data.credentials[account] = value;
    writeFallbackFile(data, path);
  });
}

export function deleteFallbackCredential(account: string, path = getCredentialFallbackPath()): boolean {
  return withFallbackLock(path, () => {
    const data = readFallbackFile(path);
    if (!Object.hasOwn(data.credentials, account)) return false;
    delete data.credentials[account];
    writeFallbackFile(data, path);
    return true;
  });
}
