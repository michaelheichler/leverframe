import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { getAppHome } from './paths.js';

const KEYRING_SERVICE = 'leverframe';
const LEGACY_KEYRING_SERVICES = ['clodex', 'relay-ai'] as const;
const KEYRING_TIMEOUT_MS = 3_000;
const FALLBACK_FILE_NAME = 'credentials-fallback.json';
const FALLBACK_WARNING = 'Using plaintext credential fallback storage (permissions 0600 in a 0700 directory); no at-rest encryption is available';

const KEYRING_CHILD_SOURCE = String.raw`
const CHUNK_PREFIX = '__relay_chunked__:';
const CHUNK_SIZE = 1200;
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
try {
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const { Entry } = await import(input.moduleUrl);
  const entry = new Entry(input.service, input.account);
  let value = null;
  if (input.operation === 'read') {
    value = entry.getPassword() ?? null;
    if (value?.startsWith(CHUNK_PREFIX)) {
      const count = Number(value.slice(CHUNK_PREFIX.length));
      if (!Number.isSafeInteger(count) || count < 1) throw new Error('Keyring credential has an invalid chunk marker');
      const parts = [];
      for (let index = 0; index < count; index++) {
        const part = new Entry(input.service, input.account + '::chunk::' + index).getPassword();
        if (!part) throw new Error('Keyring credential is incomplete');
        parts.push(part);
      }
      value = parts.join('');
      if (!value) throw new Error('Keyring credential is incomplete');
    }
  } else if (input.operation === 'write') {
    if (input.value.length <= CHUNK_SIZE) entry.setPassword(input.value);
    else {
      const count = Math.ceil(input.value.length / CHUNK_SIZE);
      for (let index = 0; index < count; index++) {
        new Entry(input.service, input.account + '::chunk::' + index)
          .setPassword(input.value.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE));
      }
      entry.setPassword(CHUNK_PREFIX + count);
    }
  } else if (input.operation === 'delete') {
    value = entry.getPassword() ?? null;
    if (value?.startsWith(CHUNK_PREFIX)) {
      const count = Number(value.slice(CHUNK_PREFIX.length));
      if (!Number.isSafeInteger(count) || count < 1) throw new Error('Keyring credential has an invalid chunk marker');
      for (let index = 0; index < count; index++) {
        new Entry(input.service, input.account + '::chunk::' + index).deletePassword();
      }
    }
    entry.deletePassword();
    value = null;
  }
  else throw new Error('Unsupported keyring operation');
  process.stdout.write(JSON.stringify({ ok: true, value }));
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
  | { ok: true; value: string | null }
  | { ok: false; error: string };

interface FallbackFile {
  schemaVersion: 1;
  credentials: Record<string, string>;
}

export interface CredentialDiagnostic {
  level: 'info' | 'warn';
  message: string;
}

/** Classify a keyring error into a human-readable reason without exposing secrets. */
export function classifyKeyringError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes('timed out')) return 'keyring operation timed out';
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
  const resolved = createRequire(import.meta.url).resolve('@napi-rs/keyring');
  return pathToFileURL(resolved).href;
}

const KEYRING_ENV_NAMES = [
  'APPDATA',
  'COMSPEC',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'ProgramData',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WAYLAND_DISPLAY',
  'WINDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
] as const;

export function buildKeyringHelperEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of KEYRING_ENV_NAMES) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

/**
 * Run one synchronous native keyring call outside the parent process.
 *
 * On Linux, when the D-Bus session bus is unavailable the Secret Service
 * backend cannot respond and the native helper would block until the deadline.
 * Fast-fail in that case so callers fall through to the plaintext fallback
 * immediately instead of spawning a child that is guaranteed to time out.
 * Callers exercising the spawn machinery directly pass
 * `skipAvailabilityCheck: true` to opt out of the prerequisite probe.
 */
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
  if (!options.skipAvailabilityCheck) {
    const dbusReason = missingDbusReason(options.env ?? process.env);
    if (dbusReason) return Promise.resolve({ ok: false, error: dbusReason });
  }

  let moduleUrl: string;
  try {
    moduleUrl = options.moduleUrl ?? resolveKeyringModule();
  } catch (err) {
    return Promise.resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }

  return new Promise(resolve => {
    let child: ChildProcessByStdio<Writable, Readable, null>;
    try {
      child = (options.spawnImpl ?? spawn)(process.execPath, ['--input-type=module', '--eval', KEYRING_CHILD_SOURCE], {
        env: buildKeyringHelperEnv(),
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      }) as ChildProcessByStdio<Writable, Readable, null>;
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
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
    const onStdoutData = (chunk: Buffer | string): void => {
      stdout.push(Buffer.from(chunk));
    };
    const onStdinError = (err: Error): void => {
      finish({ ok: false, error: err.message }, true);
    };
    const onChildError = (err: Error): void => {
      finish({ ok: false, error: err.message }, true);
    };
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
    timer = setTimeout(() => {
      finish({ ok: false, error: `keyring operation timed out after ${timeoutMs}ms` }, true);
    }, timeoutMs);
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
  if (!lstatSync(path).isFile()) throw new Error(`Credential fallback path is not a regular file: ${path}`);
  chmodSync(dirname(path), 0o700);
  chmodSync(path, 0o600);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Credential fallback file is corrupt: ${path}`, { cause: err });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Credential fallback file has an invalid format: ${path}`);
  }
  const record = parsed as Record<string, unknown>;
  const credentials = record['credentials'];
  const fields = Object.keys(record);
  if (
    fields.length !== 2
    || !fields.includes('schemaVersion')
    || !fields.includes('credentials')
    || record['schemaVersion'] !== 1
    || !credentials
    || typeof credentials !== 'object'
    || Array.isArray(credentials)
  ) {
    throw new Error(`Credential fallback file has an invalid format: ${path}`);
  }
  for (const value of Object.values(credentials)) {
    if (typeof value !== 'string') throw new Error(`Credential fallback file has an invalid format: ${path}`);
  }
  return {
    schemaVersion: 1,
    credentials: Object.assign(Object.create(null) as Record<string, string>, credentials),
  };
}

function writeFallbackFile(data: FallbackFile, path = getCredentialFallbackPath()): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readFallbackCredential(account: string, path = getCredentialFallbackPath()): string | null {
  return readFallbackFile(path).credentials[account] ?? null;
}

export function writeFallbackCredential(account: string, value: string, path = getCredentialFallbackPath()): void {
  const data = readFallbackFile(path);
  data.credentials[account] = value;
  writeFallbackFile(data, path);
}

export function deleteFallbackCredential(account: string, path = getCredentialFallbackPath()): boolean {
  const data = readFallbackFile(path);
  if (!Object.hasOwn(data.credentials, account)) return false;
  delete data.credentials[account];
  writeFallbackFile(data, path);
  return true;
}

function missingDbusReason(env: NodeJS.ProcessEnv): string | null {
  if (process.platform !== 'linux' || env['DBUS_SESSION_BUS_ADDRESS']?.trim()) return null;
  return 'D-Bus session is unavailable; Secret Service keyring access cannot be used';
}

function reportCredentialWarning(diag: ((msg: string) => void) | undefined, message: string): void {
  if (diag) diag(message);
  else console.warn(`leverframe: ${message}`);
}

async function keyringOperation(input: KeyringOperation): Promise<KeyringResult> {
  return runIsolatedKeyringOperation(input);
}

export const _credentialStoreInternals = {
  keyringOperation,
};

async function readKeyringService(service: string, account: string): Promise<KeyringResult> {
  return _credentialStoreInternals.keyringOperation({ operation: 'read', service, account });
}

export async function readStoredCredential(account: string, diag?: (msg: string) => void): Promise<string | null> {
  const primary = await readKeyringService(KEYRING_SERVICE, account);
  if (primary.ok && primary.value !== null) return primary.value;

  if (!primary.ok) reportCredentialWarning(diag, classifyKeyringError(primary.error));

  // Invariant: no previously checked keychain service contains this account.
  // Variant: the number of unchecked legacy services strictly decreases.
  for (const service of LEGACY_KEYRING_SERVICES) {
    const legacy = await readKeyringService(service, account);
    if (legacy.ok && legacy.value !== null) {
      await writeStoredCredential(account, legacy.value, diag);
      return legacy.value;
    }
    if (!legacy.ok) reportCredentialWarning(diag, classifyKeyringError(legacy.error));
  }

  const fallback = readFallbackCredential(account);
  if (fallback !== null) reportCredentialWarning(diag, `${FALLBACK_WARNING}: ${getCredentialFallbackPath()}`);
  return fallback;
}

export async function writeStoredCredential(account: string, value: string, diag?: (msg: string) => void): Promise<boolean> {
  const result = await _credentialStoreInternals.keyringOperation({ operation: 'write', service: KEYRING_SERVICE, account, value });
  if (result.ok) {
    try {
      deleteFallbackCredential(account);
    } catch (err) {
      reportCredentialWarning(diag, `Keyring save succeeded, but stale fallback material was not removed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  reportCredentialWarning(diag, classifyKeyringError(result.error));
  try {
    writeFallbackCredential(account, value);
    reportCredentialWarning(diag, `${FALLBACK_WARNING}: ${getCredentialFallbackPath()}`);
    return true;
  } catch (err) {
    reportCredentialWarning(diag, `Could not write credential fallback: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function deleteStoredCredential(account: string, diag?: (msg: string) => void): Promise<boolean> {
  const result = await _credentialStoreInternals.keyringOperation({ operation: 'delete', service: KEYRING_SERVICE, account });
  if (!result.ok) reportCredentialWarning(diag, classifyKeyringError(result.error));
  let fallbackDeleted = false;
  try {
    fallbackDeleted = deleteFallbackCredential(account);
  } catch (err) {
    reportCredentialWarning(diag, `Could not update credential fallback: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result.ok || fallbackDeleted;
}

export async function diagnoseCredentialStorage(env: NodeJS.ProcessEnv = process.env): Promise<CredentialDiagnostic[]> {
  if (process.platform !== 'linux') return [];
  const headless = Boolean(env['SSH_CONNECTION'] || env['SSH_TTY'] || (!env['DISPLAY'] && !env['WAYLAND_DISPLAY']));
  const diagnostics: CredentialDiagnostic[] = [];
  if (headless) {
    diagnostics.push({ level: 'info', message: 'Headless/SSH session detected; OpenAI device-code sign-in does not require a GUI.' });
  }
  const dbusReason = missingDbusReason(env);
  const probe = dbusReason
    ? { ok: false as const, error: dbusReason }
    : await runIsolatedKeyringOperation({ operation: 'read', service: KEYRING_SERVICE, account: '__leverframe_probe__' });
  if (!probe.ok) {
    diagnostics.push({
      level: 'warn',
      message: `${classifyKeyringError(probe.error)}. ${FALLBACK_WARNING}: ${getCredentialFallbackPath(env)}.`,
    });
  }
  return diagnostics;
}
