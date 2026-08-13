import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { getAppHome } from './paths.js';

export const CONFIG_DIR_MODE = 0o700;

const CONFIG_LOCK_STALE_MS = 10_000;
const CONFIG_LOCK_WAIT_MS = 5_000;
const CONFIG_LOCK_RETRY_MS = 25;
const CONFIG_LOCK_MALFORMED_GRACE_MS = 500;
const CONFIG_LOCK_FUTURE_SKEW_MS = 5_000;
const CONFIG_LOCK_BUSY_ERROR = 'ConfigLockBusyError';

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

interface ConfigLockContent {
  pid: number;
  startedAt: number;
  nonce: string;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function getConfigLockPath(): string {
  return join(getAppHome(), 'config.lock');
}

function getServerPasswordLockPath(): string {
  return join(getAppHome(), 'server-password.lock');
}

export class ConfigLockBusyError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string, waitedMs: number) {
    super(
      `Could not acquire the config lock at ${lockPath} after ${waitedMs}ms. `
        + 'Another leverframe process is likely writing preferences or migrating a server password. '
        + 'If no leverframe process is running, remove the lock file and re-run.',
    );
    this.name = CONFIG_LOCK_BUSY_ERROR;
    this.lockPath = lockPath;
  }
}

/** @internal Exported for deterministic lock-behavior tests. */
export const _configLockInternals = {
  lockPath: getConfigLockPath,
  serverPasswordLockPath: getServerPasswordLockPath,
  tryAcquire: tryAcquireConfigLock,
  release: releaseConfigLock,
  staleMs: CONFIG_LOCK_STALE_MS,
  waitMs: CONFIG_LOCK_WAIT_MS,
  malformedGraceMs: CONFIG_LOCK_MALFORMED_GRACE_MS,
  futureSkewMs: CONFIG_LOCK_FUTURE_SKEW_MS,
  isRegularFile: isRegularLockPath,
  buildContent: (nonce: string, now: number): ConfigLockContent => ({ pid: process.pid, startedAt: now, nonce }),
  setMtime: (lockPath: string, mtimeMs: number): void => {
    const t = new Date(mtimeMs);
    utimesSync(lockPath, t, t);
  },
};

function isRegularLockPath(lockPath: string): boolean {
  try {
    return lstatSync(lockPath).isFile();
  } catch {
    return true;
  }
}

function assertLockPathIsRegular(lockPath: string): void {
  if (!isRegularLockPath(lockPath)) {
    throw new Error(`Config lock path is not a regular file: ${lockPath}`);
  }
}

function tryAcquireConfigLock(
  lockPath = getConfigLockPath(),
  opts: { now?: number; isAlive?: (pid: number) => boolean } = {},
): (() => void) | null {
  const now = opts.now ?? Date.now();
  const alive = opts.isAlive ?? pidIsAlive;
  const nonce = randomUUID();
  mkdirSync(dirname(lockPath), { recursive: true, mode: CONFIG_DIR_MODE });

  for (let attempt = 0; attempt < 3; attempt++) {
    assertLockPathIsRegular(lockPath);

    let fd: number | undefined;
    try {
      fd = openSync(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EEXIST') {
        if (maybeUnlinkStaleLock(lockPath, alive, { now })) continue;
        return null;
      }
      if (code === 'ELOOP') {
        throw new Error(`Config lock path is a symlink and cannot be used: ${lockPath}`);
      }
      throw err;
    }

    let dataWritten = false;
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now, nonce } satisfies ConfigLockContent));
      dataWritten = true;
      closeSync(fd);
      fd = undefined;
    } catch (publishErr) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best-effort: fd may already be closed */ }
        fd = undefined;
      }
      if (dataWritten) {
        unlinkLockIfOwned(lockPath, nonce);
      } else {
        try { unlinkSync(lockPath); } catch { /* best-effort: file may be partial or already gone */ }
      }
      throw publishErr;
    }

    return () => releaseConfigLock(lockPath, nonce);
  }
  return null;
}

function readLockMetadata(lockPath: string): ConfigLockContent | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Partial<ConfigLockContent>;
  if (typeof obj.pid !== 'number' || !Number.isFinite(obj.pid)) return null;
  if (typeof obj.startedAt !== 'number' || !Number.isFinite(obj.startedAt)) return null;
  if (typeof obj.nonce !== 'string' || obj.nonce.length === 0) return null;
  return { pid: obj.pid, startedAt: obj.startedAt, nonce: obj.nonce };
}

function readLockMtimeMs(lockPath: string): number | null {
  try {
    return lstatSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

function maybeUnlinkStaleLock(
  lockPath: string,
  alive: (pid: number) => boolean,
  opts: { now?: number } = {},
): boolean {
  const now = opts.now ?? Date.now();
  const meta = readLockMetadata(lockPath);
  if (meta === null) {
    const mtime = readLockMtimeMs(lockPath);
    if (mtime === null) return false;
    const age = now - mtime;
    if (age >= 0) {
      if (age < CONFIG_LOCK_MALFORMED_GRACE_MS) return false;
    } else if (-age < CONFIG_LOCK_FUTURE_SKEW_MS) {
      return false;
    }
    try { unlinkSync(lockPath); return true; } catch { return false; }
  }
  if (!alive(meta.pid)) {
    try { unlinkSync(lockPath); return true; } catch { return false; }
  }
  return false;
}

function unlinkLockIfOwned(lockPath: string, nonce: string): void {
  const current = readLockMetadata(lockPath);
  if (current === null || current.nonce !== nonce) return;
  try { unlinkSync(lockPath); } catch { /* already gone or not owned */ }
}

function releaseConfigLock(lockPath: string, nonce: string): void {
  try {
    const current = JSON.parse(readFileSync(lockPath, 'utf8')) as ConfigLockContent;
    if (current.nonce !== nonce) return;
  } catch {
    return;
  }
  try { unlinkSync(lockPath); } catch { /* already gone */ }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withConfigWriteLock<T>(mutate: () => T): T {
  const lockPath = getConfigLockPath();
  const release = acquireConfigLockSync(lockPath);
  try {
    return mutate();
  } finally {
    release();
  }
}

function acquireConfigLockSync(lockPath = getConfigLockPath()): () => void {
  const deadline = Date.now() + CONFIG_LOCK_WAIT_MS;
  for (;;) {
    const release = tryAcquireConfigLock(lockPath);
    if (release) return release;
    if (Date.now() >= deadline) {
      throw new ConfigLockBusyError(lockPath, CONFIG_LOCK_WAIT_MS);
    }
    sleepSync(CONFIG_LOCK_RETRY_MS);
  }
}

export async function acquireServerPasswordLock(): Promise<() => void> {
  const lockPath = getServerPasswordLockPath();
  const deadline = Date.now() + CONFIG_LOCK_WAIT_MS;
  for (;;) {
    const release = tryAcquireConfigLock(lockPath);
    if (release) return release;
    if (Date.now() >= deadline) {
      throw new ConfigLockBusyError(lockPath, CONFIG_LOCK_WAIT_MS);
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, CONFIG_LOCK_RETRY_MS);
      timer.unref?.();
    });
  }
}
