import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Linux fails fast on hung D-Bus, other platforms wait for keychain approval and journal writes.
export const KEYRING_TIMEOUT_MS = process.platform === 'linux' ? 3_000 : 45_000;

function keyringChildPath(): string {
  return fileURLToPath(new URL('./keyring-child.mjs', import.meta.url));
}

export type KeyringOperation =
  | { operation: 'read'; service: string; account: string }
  | { operation: 'write'; service: string; account: string; value: string }
  | { operation: 'delete'; service: string; account: string }
  | { operation: 'repair'; service: string; account: string };

export type KeyringResult =
  | { ok: true; value: string | null; deleted?: true }
  | { ok: false; error: string };

export function classifyKeyringError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes('timed out')) return 'keyring operation timed out';
  if (lower.includes('integrity:')) return msg.replace(/^integrity:\s*/i, 'keyring integrity error: ');
  if (lower.includes('d-bus session is unavailable')) {
    return 'D-Bus session is unavailable (preserve XDG_RUNTIME_DIR or provide DBUS_SESSION_BUS_ADDRESS)';
  }
  if (lower.includes('cannot find module') || lower.includes('module not found') || lower.includes('failed to load')) {
    return 'native keyring module not available on this system';
  }
  if (lower.includes('secret service') || lower.includes('org.freedesktop.secrets') || lower.includes('dbus') || lower.includes('d-bus') || lower.includes('daemon')) {
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
  if (process.platform === 'linux' && !env.DBUS_SESSION_BUS_ADDRESS?.trim()) {
    const uid = process.getuid?.();
    if (uid === undefined) return env;
    const runtimeDir = env.XDG_RUNTIME_DIR?.trim() || `/run/user/${uid}`;
    const socketPath = join(runtimeDir, 'bus');
    try {
      const socket = statSync(socketPath);
      if (socket.isSocket() && socket.uid === uid) {
        env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${socketPath}`;
      }
    } catch {
      delete env.DBUS_SESSION_BUS_ADDRESS;
    }
  }
  return env;
}

export function missingDbusReason(env: NodeJS.ProcessEnv): string | null {
  if (process.platform !== 'linux' || env.DBUS_SESSION_BUS_ADDRESS?.trim()) return null;
  return 'D-Bus session is unavailable; Secret Service keyring access cannot be used';
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
  const helperEnv = buildKeyringHelperEnv(sourceEnv);
  if (!options.skipAvailabilityCheck) {
    const reason = missingDbusReason(helperEnv);
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
      child = (options.spawnImpl ?? spawn)(process.execPath, [keyringChildPath()], {
        env: helperEnv,
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
