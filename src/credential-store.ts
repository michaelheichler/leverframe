import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { durableAtomicWrite, ensurePrivateDirectory, readFileStrict } from './durable-io.js';
import { getAppHome } from './paths.js';
import { withCredentialMutationLock, withRegistryWriteLockSync } from './registry/lock.js';

const KEYRING_SERVICE = 'leverframe';
const LEGACY_KEYRING_SERVICES = ['clodex', 'relay-ai'] as const;
const KEYRING_TIMEOUT_MS = 3_000;
const FALLBACK_FILE_NAME = 'credentials-fallback.json';
const FALLBACK_WARNING = 'Using plaintext credential fallback storage (permissions 0600 in a 0700 directory); no at-rest encryption is available';
const MAX_FALLBACK_BYTES = 16 * 1024 * 1024;

/**
 * The helper is isolated because native keyring calls are synchronous and can
 * block indefinitely. Its transaction protocol is self-contained so a killed
 * helper leaves enough keyring metadata for the next helper to reconcile.
 */
const KEYRING_CHILD_SOURCE = String.raw`
const { createHash, randomUUID } = await import('node:crypto');
const CHUNK_PREFIX = '__relay_chunked__:';
const DELETE_TOMBSTONE_PREFIX = '__leverframe_delete__:';
const INVENTORY_PREFIX = '__leverframe_inventory__:';
const CHUNK_SERVICE = 'leverframe-chunks';
const JOURNAL_SERVICE = 'leverframe-journal';
const DELETED_SERVICE = 'leverframe-deleted';
const CHUNK_SIZE = 1200;
const MAX_CHUNKS = 128;
const MAX_JOURNAL_CHUNKS = 6;
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const integrity = message => new Error('integrity: ' + message);
const digest = value => createHash('sha256').update(value).digest('hex');

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
try {
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const keyring = await import(input.moduleUrl);
  const { Entry } = keyring;

  const raw = (service, account) => {
    const value = new Entry(service, account).getPassword();
    return value === undefined ? null : value;
  };
  const set = (service, account, value) => {
    new Entry(service, account).setPassword(value);
    if (raw(service, account) !== value) throw new Error('keyring write verification failed');
  };
  const remove = (service, account) => {
    const entry = new Entry(service, account);
    const existing = raw(service, account);
    if (existing === null) {
      entry.deletePassword();
      return raw(service, account) === null;
    }
    const tombstone = existing.startsWith(DELETE_TOMBSTONE_PREFIX)
      ? existing
      : DELETE_TOMBSTONE_PREFIX + randomUUID();
    if (existing !== tombstone) set(service, account, tombstone);
    if (!entry.deletePassword()) return false;
    return raw(service, account) === null;
  };
  const chunkAccount = (account, marker, index) => marker.generation
    ? account + '::chunk::' + marker.generation + '::' + index
    : account + '::chunk::' + index;
  const chunkService = marker => marker.version === 3 ? CHUNK_SERVICE : input.service;
  const parseMarker = value => {
    if (!value?.startsWith(CHUNK_PREFIX)) return null;
    const encoded = value.slice(CHUNK_PREFIX.length);
    const v3 = /^v3:([^:]+):(\d+):([0-9a-f]{64})$/.exec(encoded);
    const v2 = /^v2:([^:]+):(\d+)$/.exec(encoded);
    const legacy = /^(\d+)$/.exec(encoded);
    const countText = v3?.[2] ?? v2?.[2] ?? legacy?.[1];
    const count = Number(countText);
    const generation = v3?.[1] ?? v2?.[1];
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CHUNKS) {
      throw integrity('keyring credential has an invalid chunk marker');
    }
    if (generation !== undefined && !GENERATION.test(generation)) {
      throw integrity('keyring credential has an invalid chunk generation');
    }
    return {
      version: v3 ? 3 : v2 ? 2 : 1,
      count,
      ...(generation ? { generation } : {}),
      ...(v3 ? { digest: v3[3] } : {}),
    };
  };
  const markerValue = marker => marker.version === 3
    ? CHUNK_PREFIX + 'v3:' + marker.generation + ':' + marker.count + ':' + marker.digest
    : marker.version === 2
      ? CHUNK_PREFIX + 'v2:' + marker.generation + ':' + marker.count
      : CHUNK_PREFIX + marker.count;
  const markerKey = marker => marker.version + ':' + (marker.generation ?? 'legacy') + ':' + marker.count + ':' + (marker.digest ?? '');
  const readMarker = (account, marker) => {
    let value = '';
    for (let index = 0; index < marker.count; index++) {
      const part = raw(chunkService(marker), chunkAccount(account, marker, index));
      if (part === null || part.startsWith(DELETE_TOMBSTONE_PREFIX)) {
        throw integrity('keyring credential chunk ' + (index + 1) + ' of ' + marker.count + ' is missing');
      }
      value += part;
    }
    if (marker.digest && digest(value) !== marker.digest) {
      throw integrity('keyring credential chunk digest does not match');
    }
    return value;
  };
  const descriptorFor = value => {
    if (value === null) return null;
    const marker = parseMarker(value);
    if (marker) {
      readMarker(input.account, marker);
      return { kind: 'chunks', marker };
    }
    if (value.startsWith(DELETE_TOMBSTONE_PREFIX)) throw integrity('keyring credential is tombstoned');
    return { kind: 'short', digest: digest(value) };
  };
  const descriptorMatches = (descriptor, value) => {
    if (descriptor === null) return value === null;
    if (value === null) return false;
    if (descriptor.kind === 'short') return !value.startsWith(CHUNK_PREFIX) && digest(value) === descriptor.digest;
    try {
      const marker = parseMarker(value);
      return marker !== null && markerKey(marker) === markerKey(descriptor.marker);
    } catch { return false; }
  };
  const parseDescriptor = value => {
    if (value === null) return null;
    if (!value || typeof value !== 'object') throw integrity('keyring journal descriptor is invalid');
    if (value.kind === 'short' && typeof value.digest === 'string' && DIGEST.test(value.digest)) {
      return { kind: 'short', digest: value.digest };
    }
    if (value.kind === 'chunks') {
      const marker = value.marker;
      const validCount = Number.isSafeInteger(marker?.count) && marker.count >= 1 && marker.count <= MAX_CHUNKS;
      const validLegacy = marker?.version === 1 && marker.generation === undefined && marker.digest === undefined;
      const validV2 = marker?.version === 2 && GENERATION.test(marker.generation) && marker.digest === undefined;
      const validV3 = marker?.version === 3 && GENERATION.test(marker.generation) && DIGEST.test(marker.digest);
      if (!validCount || (!validLegacy && !validV2 && !validV3)) {
        throw integrity('keyring journal marker is invalid');
      }
      return {
        kind: 'chunks',
        marker: {
          version: marker.version,
          count: marker.count,
          ...(marker.generation ? { generation: marker.generation } : {}),
          ...(marker.digest ? { digest: marker.digest } : {}),
        },
      };
    }
    throw integrity('keyring journal descriptor is invalid');
  };
  const readJournal = () => {
    const value = raw(JOURNAL_SERVICE, input.account);
    if (value === null) return null;
    let parsed;
    try { parsed = JSON.parse(value); } catch { throw integrity('keyring credential journal is corrupt'); }
    if (!parsed || parsed.schemaVersion !== 1 || !['preparing', 'active', 'delete', 'deleted'].includes(parsed.mode)) {
      throw integrity('keyring credential journal has an invalid schema');
    }
    const retired = Array.isArray(parsed.retired) ? parsed.retired.map(parseDescriptor) : [];
    if (retired.length > MAX_JOURNAL_CHUNKS || retired.some(value => value?.kind !== 'chunks')) {
      throw integrity('keyring credential journal has an invalid inventory');
    }
    return {
      schemaVersion: 1,
      mode: parsed.mode,
      previous: parseDescriptor(parsed.previous ?? null),
      candidate: parseDescriptor(parsed.candidate ?? null),
      active: parseDescriptor(parsed.active ?? null),
      retired,
    };
  };
  const writeJournal = journal => {
    const encoded = JSON.stringify(journal);
    if (encoded.length > CHUNK_SIZE) throw integrity('keyring credential journal exceeds its bounded entry size');
    set(JOURNAL_SERVICE, input.account, encoded);
  };
  const deleteDescriptor = descriptor => {
    if (!descriptor || descriptor.kind !== 'chunks') return true;
    let ok = true;
    for (let index = 0; index < descriptor.marker.count; index++) {
      if (!remove(chunkService(descriptor.marker), chunkAccount(input.account, descriptor.marker, index))) ok = false;
    }
    return ok;
  };
  const inventory = service => {
    if (typeof keyring.findCredentials !== 'function') return null;
    const found = keyring.findCredentials(service);
    if (!Array.isArray(found)) throw integrity('keyring credential inventory is unavailable');
    return found.filter(item => item && typeof item.account === 'string' && typeof item.password === 'string');
  };
  const inventoryChunks = () => {
    if (typeof keyring.findCredentials !== 'function') {
      throw integrity('keyring credential inventory is unavailable');
    }
    const result = [];
    for (const service of [input.service, CHUNK_SERVICE]) {
      const sentinelGeneration = randomUUID();
      const sentinelAccount = input.account + '::chunk::' + sentinelGeneration + '::0';
      const sentinelValue = INVENTORY_PREFIX + sentinelGeneration;
      set(service, sentinelAccount, sentinelValue);
      try {
        const entries = inventory(service);
        if (!entries?.some(item => item.account === sentinelAccount && item.password === sentinelValue)) {
          throw integrity('keyring credential inventory could not be verified');
        }
        for (const item of entries) {
          if (!item.account.startsWith(input.account + '::chunk::') || item.account === sentinelAccount) continue;
          if (item.password.startsWith(INVENTORY_PREFIX)) {
            remove(service, item.account);
            continue;
          }
          result.push({ service, account: item.account });
        }
      } finally {
        if (!remove(service, sentinelAccount)) throw integrity('keyring inventory sentinel could not be removed');
      }
    }
    return result;
  };
  const activeValue = () => raw(input.service, input.account);
  const finalJournal = descriptor => ({ schemaVersion: 1, mode: 'active', active: descriptor, retired: [] });

  const reconcile = () => {
    const guard = raw(DELETED_SERVICE, input.account);
    const journal = readJournal();
    let current = activeValue();
    if (journal?.mode === 'deleted' || guard === 'v1:deleted') return { deleted: true, active: null };
    if (journal?.mode === 'delete' || guard === 'v1:pending') return { deleting: true, journal };
    if (journal?.mode === 'preparing') {
      if (descriptorMatches(journal.candidate, current)) {
        const retired = [journal.previous, ...journal.retired].filter(Boolean);
        writeJournal({ schemaVersion: 1, mode: 'active', active: journal.candidate, retired });
        for (const descriptor of retired) {
          if (!deleteDescriptor(descriptor)) throw new Error('keyring credential cleanup is incomplete');
        }
        writeJournal(finalJournal(journal.candidate));
        return { active: journal.candidate };
      }
      if (descriptorMatches(journal.previous, current)) {
        if (!deleteDescriptor(journal.candidate)) throw new Error('keyring credential cleanup is incomplete');
        writeJournal(finalJournal(journal.previous));
        return { active: journal.previous };
      }
      throw integrity('published keyring state does not match its journal');
    }
    if (journal?.mode === 'active') {
      if (!descriptorMatches(journal.active, current)) {
        throw integrity('published keyring credential does not match its journal');
      }
      if (journal.active?.kind === 'chunks') readMarker(input.account, journal.active.marker);
      for (const descriptor of journal.retired) {
        if (!deleteDescriptor(descriptor)) throw new Error('keyring credential cleanup is incomplete');
      }
      if (journal.retired.length) writeJournal(finalJournal(journal.active));
      return { active: journal.active };
    }
    if (current === null) return { active: null };
    const adopted = descriptorFor(current);
    writeJournal(finalJournal(adopted));
    return { active: adopted, adopted: true };
  };

  const publish = value => {
    const state = reconcile();
    if (state.deleting) throw integrity('keyring credential deletion is pending');
    const previousValue = activeValue();
    const previous = descriptorFor(previousValue);
    const retired = previous?.kind === 'chunks' ? [previous] : [];
    let candidate;
    let publishedValue;
    if (value.length <= CHUNK_SIZE) {
      candidate = { kind: 'short', digest: digest(value) };
      publishedValue = value;
    } else {
      const parts = [];
      for (let start = 0; start < value.length;) {
        let end = Math.min(start + CHUNK_SIZE, value.length);
        if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end -= 1;
        parts.push(value.slice(start, end));
        start = end;
      }
      if (parts.length > MAX_CHUNKS) throw new Error('keyring credential exceeds the supported chunk count');
      const marker = { version: 3, generation: randomUUID(), count: parts.length, digest: digest(value) };
      candidate = { kind: 'chunks', marker };
      publishedValue = markerValue(marker);
      writeJournal({ schemaVersion: 1, mode: 'preparing', previous, candidate, retired });
      for (const [index, part] of parts.entries()) set(CHUNK_SERVICE, chunkAccount(input.account, marker, index), part);
      if (readMarker(input.account, marker) !== value) throw new Error('keyring credential generation verification failed');
    }
    if (candidate.kind === 'short') {
      writeJournal({ schemaVersion: 1, mode: 'preparing', previous, candidate, retired });
    }
    set(input.service, input.account, publishedValue);
    if (candidate.kind === 'chunks' && readMarker(input.account, candidate.marker) !== value) {
      throw new Error('published keyring credential verification failed');
    }
    writeJournal({ schemaVersion: 1, mode: 'active', active: candidate, retired });
    for (const descriptor of retired) {
      if (descriptorMatches(candidate, markerValue(descriptor.marker))) continue;
      if (!deleteDescriptor(descriptor)) throw new Error('keyring credential cleanup is pending');
    }
    writeJournal(finalJournal(candidate));
    if (!remove(DELETED_SERVICE, input.account)) throw new Error('keyring deletion guard could not be cleared');
    return true;
  };

  const readCredential = () => {
    const state = reconcile();
    if (state.deleted || state.deleting) return null;
    const value = activeValue();
    if (value === null) return null;
    const marker = parseMarker(value);
    if (!marker) return value;
    const combined = readMarker(input.account, marker);
    if (marker.version < 3) publish(combined);
    return combined;
  };

  const deleteCredential = () => {
    const guard = raw(DELETED_SERVICE, input.account);
    let journal = readJournal();
    if (journal?.mode === 'deleted' || guard === 'v1:deleted') return true;
    let current = activeValue();
    let descriptors = [];
    if (journal?.mode === 'delete') {
      descriptors = journal.retired;
    } else {
      const descriptor = descriptorFor(current);
      if (descriptor?.kind === 'chunks') descriptors.push(descriptor);
      if (journal?.active?.kind === 'chunks') descriptors.push(journal.active);
      descriptors.push(...(journal?.retired ?? []));
      const unique = new Map(descriptors.map(value => [markerKey(value.marker), value]));
      descriptors = [...unique.values()];
      writeJournal({ schemaVersion: 1, mode: 'delete', active: descriptor, retired: descriptors });
    }
    set(DELETED_SERVICE, input.account, 'v1:pending');
    current = activeValue();
    if (current !== null) {
      const tombstone = DELETE_TOMBSTONE_PREFIX + randomUUID();
      set(input.service, input.account, tombstone);
      if (!remove(input.service, input.account)) throw new Error('keyring credential deletion could not be verified');
    }
    for (const descriptor of descriptors) {
      if (!deleteDescriptor(descriptor)) throw new Error('keyring credential chunk deletion could not be verified');
    }
    for (const item of inventoryChunks()) {
      if (!remove(item.service, item.account)) throw new Error('keyring credential inventory deletion could not be verified');
    }
    if (activeValue() !== null) throw new Error('keyring credential deletion could not be verified');
    writeJournal({ schemaVersion: 1, mode: 'deleted', retired: [] });
    set(DELETED_SERVICE, input.account, 'v1:deleted');
    return true;
  };

  let value = null;
  if (input.operation === 'read') value = readCredential();
  else if (input.operation === 'write') publish(input.value);
  else if (input.operation === 'delete') deleteCredential();
  else throw new Error('Unsupported keyring operation');
  const deleted = input.operation === 'read' && raw(DELETED_SERVICE, input.account) !== null;
  process.stdout.write(JSON.stringify({ ok: true, value, ...(deleted ? { deleted: true } : {}) }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
}
`;

export type KeyringOperation =
  | { operation: 'read'; service: string; account: string }
  | { operation: 'write'; service: string; account: string; value: string }
  | { operation: 'delete'; service: string; account: string };

export type KeyringResult =
  | { ok: true; value: string | null; deleted?: true }
  | { ok: false; error: string };

interface FallbackFile {
  schemaVersion: 1;
  credentials: Record<string, string>;
}

export interface CredentialDiagnostic {
  level: 'info' | 'warn';
  message: string;
}

export function classifyKeyringError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes('timed out')) return 'keyring operation timed out';
  if (lower.includes('integrity:')) return msg.replace(/^integrity:\s*/i, 'keyring integrity error: ');
  if (lower.includes('cannot find module') || lower.includes('module not found') || lower.includes('failed to load')) {
    return 'native keyring module not available on this system';
  }
  if (lower.includes('secret service') || lower.includes('dbus') || lower.includes('daemon')) {
    return 'Secret Service daemon is not running (start GNOME Keyring or KWallet, or provide a D-Bus session)';
  }
  if (lower.includes('denied') || lower.includes('locked') || lower.includes('cancelled') || lower.includes('user refused')) {
    return 'keychain access was denied or the keychain is locked';
  }
  return `keyring error: ${msg}`;
}

function resolveKeyringModule(): string {
  return pathToFileURL(createRequire(import.meta.url).resolve('@napi-rs/keyring')).href;
}

const KEYRING_ENV_NAMES = [
  'APPDATA', 'COMSPEC', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'HOME', 'HOMEDRIVE',
  'HOMEPATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOCALAPPDATA', 'PATH', 'PATHEXT',
  'ProgramData', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'WAYLAND_DISPLAY',
  'WINDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
] as const;

export function buildKeyringHelperEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of KEYRING_ENV_NAMES) if (source[name] !== undefined) env[name] = source[name];
  return env;
}

export function runIsolatedKeyringOperation(
  input: KeyringOperation,
  options: {
    timeoutMs?: number;
    moduleUrl?: string;
    spawnImpl?: typeof spawn;
    env?: NodeJS.ProcessEnv;
    skipAvailabilityCheck?: boolean;
  } = {},
): Promise<KeyringResult> {
  const sourceEnv = options.env ?? process.env;
  if (!options.skipAvailabilityCheck) {
    const reason = missingDbusReason(sourceEnv);
    if (reason) return Promise.resolve({ ok: false, error: reason });
  }

  let moduleUrl: string;
  try {
    moduleUrl = options.moduleUrl ?? resolveKeyringModule();
  } catch (error) {
    return Promise.resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }

  return new Promise(resolve => {
    let child: ChildProcessByStdio<Writable, Readable, null>;
    try {
      child = (options.spawnImpl ?? spawn)(process.execPath, ['--input-type=module', '--eval', KEYRING_CHILD_SOURCE], {
        env: buildKeyringHelperEnv(sourceEnv),
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      }) as ChildProcessByStdio<Writable, Readable, null>;
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const stdout: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      child.stdin.removeListener('error', onStdinError);
      child.stdout.removeListener('data', onStdoutData);
      child.removeListener('error', onChildError);
      child.removeListener('close', onClose);
    };
    const finish = (result: KeyringResult, terminate = false): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminate) {
        child.kill('SIGKILL');
        child.stdin.destroy();
        child.stdout.destroy();
        child.unref();
      }
      resolve(result);
    };
    const onStdoutData = (chunk: Buffer | string): void => { stdout.push(Buffer.from(chunk)); };
    const onStdinError = (error: Error): void => { finish({ ok: false, error: error.message }, true); };
    const onChildError = (error: Error): void => { finish({ ok: false, error: error.message }, true); };
    const onClose = (): void => {
      try {
        const result = JSON.parse(Buffer.concat(stdout).toString('utf8')) as KeyringResult;
        if (result?.ok === true && (result.value === null || typeof result.value === 'string')) finish(result);
        else if (result?.ok === false && typeof result.error === 'string') finish(result);
        else finish({ ok: false, error: 'keyring helper returned an invalid response' });
      } catch {
        finish({ ok: false, error: 'keyring helper returned an invalid response' });
      }
    };
    const timeoutMs = options.timeoutMs ?? KEYRING_TIMEOUT_MS;
    timer = setTimeout(() => finish({ ok: false, error: `keyring operation timed out after ${timeoutMs}ms` }, true), timeoutMs);
    timer.unref();
    child.stdout.on('data', onStdoutData);
    child.stdin.on('error', onStdinError);
    child.on('error', onChildError);
    child.on('close', onClose);
    child.stdin.end(JSON.stringify({ ...input, moduleUrl }));
  });
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

function missingDbusReason(env: NodeJS.ProcessEnv): string | null {
  if (process.platform !== 'linux' || env.DBUS_SESSION_BUS_ADDRESS?.trim()) return null;
  return 'D-Bus session is unavailable; Secret Service keyring access cannot be used';
}

const emittedCredentialWarnings = new Set<string>();

function reportWarning(diag: ((msg: string) => void) | undefined, message: string): void {
  if (diag) {
    diag(message);
    return;
  }
  if (emittedCredentialWarnings.has(message)) return;
  emittedCredentialWarnings.add(message);
  console.warn(`leverframe: ${message}`);
}

async function keyringOperation(input: KeyringOperation): Promise<KeyringResult> {
  return runIsolatedKeyringOperation(input);
}

export const _credentialStoreInternals = { keyringOperation };

function readKeyringService(service: string, account: string): Promise<KeyringResult> {
  return _credentialStoreInternals.keyringOperation({ operation: 'read', service, account });
}

function isIntegrityError(error: string): boolean {
  return /^integrity:/i.test(error);
}

export async function readStoredCredential(account: string, diag?: (msg: string) => void): Promise<string | null> {
  return withCredentialMutationLock(`keyring:${account}`, async () => {
    const primary = await readKeyringService(KEYRING_SERVICE, account);
    if (primary.ok && primary.deleted) return null;
    if (primary.ok && primary.value !== null) return primary.value;
    if (!primary.ok) {
      reportWarning(diag, classifyKeyringError(primary.error));
      if (isIntegrityError(primary.error)) return null;
    }

    for (const service of LEGACY_KEYRING_SERVICES) {
      const legacy = await readKeyringService(service, account);
      if (legacy.ok && legacy.value !== null) {
        await writeStoredCredentialUnlocked(account, legacy.value, diag);
        return legacy.value;
      }
      if (!legacy.ok) {
        reportWarning(diag, classifyKeyringError(legacy.error));
        if (isIntegrityError(legacy.error)) return null;
      }
    }

    const fallback = readFallbackCredential(account);
    if (fallback !== null) reportWarning(diag, `${FALLBACK_WARNING}: ${getCredentialFallbackPath()}`);
    return fallback;
  });
}

async function writeStoredCredentialUnlocked(account: string, value: string, diag?: (msg: string) => void): Promise<boolean> {
  const result = await _credentialStoreInternals.keyringOperation({ operation: 'write', service: KEYRING_SERVICE, account, value });
  if (result.ok) {
    try {
      deleteFallbackCredential(account);
    } catch (error) {
      reportWarning(diag, `Keyring save succeeded, but stale fallback material was not removed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  }
  reportWarning(diag, classifyKeyringError(result.error));
  if (isIntegrityError(result.error)) return false;
  try {
    writeFallbackCredential(account, value);
    reportWarning(diag, `${FALLBACK_WARNING}: ${getCredentialFallbackPath()}`);
    return true;
  } catch (error) {
    reportWarning(diag, `Could not write credential fallback: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function writeStoredCredential(account: string, value: string, diag?: (msg: string) => void): Promise<boolean> {
  return withCredentialMutationLock(
    `keyring:${account}`,
    () => writeStoredCredentialUnlocked(account, value, diag),
  );
}

export function deleteStoredCredential(account: string, diag?: (msg: string) => void): Promise<boolean> {
  return withCredentialMutationLock(`keyring:${account}`, async () => {
    const result = await _credentialStoreInternals.keyringOperation({ operation: 'delete', service: KEYRING_SERVICE, account });
    if (!result.ok) reportWarning(diag, classifyKeyringError(result.error));
    let fallbackAbsent = false;
    try {
      deleteFallbackCredential(account);
      fallbackAbsent = readFallbackCredential(account) === null;
    } catch (error) {
      reportWarning(diag, `Could not verify credential fallback deletion: ${error instanceof Error ? error.message : String(error)}`);
    }
    return result.ok && fallbackAbsent;
  });
}

export async function diagnoseCredentialStorage(env: NodeJS.ProcessEnv = process.env): Promise<CredentialDiagnostic[]> {
  if (process.platform !== 'linux') return [];
  const headless = Boolean(env.SSH_CONNECTION || env.SSH_TTY || (!env.DISPLAY && !env.WAYLAND_DISPLAY));
  const diagnostics: CredentialDiagnostic[] = [];
  if (headless) diagnostics.push({ level: 'info', message: 'Headless/SSH session detected; OpenAI device-code sign-in does not require a GUI.' });
  const dbusReason = missingDbusReason(env);
  const probe = dbusReason
    ? { ok: false as const, error: dbusReason }
    : await runIsolatedKeyringOperation({ operation: 'read', service: KEYRING_SERVICE, account: '__leverframe_probe__' }, { env });
  if (!probe.ok) {
    diagnostics.push({
      level: 'warn',
      message: `${classifyKeyringError(probe.error)}. ${FALLBACK_WARNING}: ${getCredentialFallbackPath(env)}.`,
    });
  }
  return diagnostics;
}
