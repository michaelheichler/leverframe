import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getAppHome, getProvidersPath } from '../paths.js';

const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_CREDENTIAL_WAIT_MS = 150_000;
const DEFAULT_RETRY_MS = 25;

interface LockOwner {
  pid: number;
  startedAt: number;
  token: string;
}

interface LockSnapshot {
  raw: string;
  device: number;
  inode: number;
  modifiedAt: number;
}

export interface RegistryLockOptions {
  lockPath?: string;
  waitMs?: number;
  retryMs?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
}

interface LockContext {
  leases: ReadonlyMap<string, RegistryLockLease>;
}

export interface RegistryLockLease {
  active: boolean;
  readonly lockPath: string;
  readonly token: string;
  readonly device: number;
  readonly inode: number;
  assertOwned(): void;
  release(): void;
}

const lockContext = new AsyncLocalStorage<LockContext>();

export class RegistryLockLostError extends Error {
  constructor(lockPath: string) {
    super(`Registry lock ownership was lost before publication: ${lockPath}`);
    this.name = 'RegistryLockLostError';
  }
}

export function getRegistryLockPath(registryPath = getProvidersPath()): string {
  return `${registryPath}.lock`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (!Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) return null;
    if (typeof parsed.startedAt !== 'number' || !Number.isFinite(parsed.startedAt)) return null;
    if (typeof parsed.token !== 'string' || parsed.token.length === 0) return null;
    return parsed as LockOwner;
  } catch {
    return null;
  }
}

function createLockRecord(lockPath: string, owner: LockOwner): LockSnapshot | null {
  const raw = JSON.stringify(owner);
  const temporary = `${lockPath}.${process.pid}.${owner.token}.tmp`;
  let fd: number | undefined;
  let snapshot: LockSnapshot | null = null;
  let cleanupError: unknown;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, raw);
    fsyncSync(fd);
    const stats = fstatSync(fd);
    try {
      linkSync(temporary, lockPath);
      snapshot = { raw, device: stats.dev, inode: stats.ino, modifiedAt: stats.mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupError = error;
    }
  }
  if (cleanupError !== undefined) throw cleanupError;
  return snapshot;
}

function readSnapshot(lockPath: string): LockSnapshot {
  const pathStats = lstatSync(lockPath);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new Error(`Lock path is not a regular file: ${lockPath}`);
  }
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, 'r');
    const opened = fstatSync(fd);
    if (opened.dev !== pathStats.dev || opened.ino !== pathStats.ino) {
      throw new Error(`Lock changed while opening: ${lockPath}`);
    }
    return {
      raw: readFileSync(fd, 'utf8'),
      device: opened.dev,
      inode: opened.ino,
      modifiedAt: opened.mtimeMs,
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function lockMatches(lease: RegistryLockLease): boolean {
  try {
    const snapshot = readSnapshot(lease.lockPath);
    const owner = parseOwner(snapshot.raw);
    const current = statSync(lease.lockPath);
    return owner?.token === lease.token
      && snapshot.device === lease.device
      && snapshot.inode === lease.inode
      && current.dev === lease.device
      && current.ino === lease.inode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function createLease(lockPath: string, owner: LockOwner, snapshot: LockSnapshot): RegistryLockLease {
  const lease: RegistryLockLease = {
    active: true,
    lockPath,
    token: owner.token,
    device: snapshot.device,
    inode: snapshot.inode,
    assertOwned() {
      if (!lease.active || !lockMatches(lease)) {
        lease.active = false;
        throw new RegistryLockLostError(lockPath);
      }
    },
    release() {
      if (!lease.active) return;
      const owned = lockMatches(lease);
      lease.active = false;
      if (owned) unlinkSync(lockPath);
    },
  };
  return lease;
}

export function assertRegistryWriteOwnership(registryPath = getProvidersPath()): void {
  const lockPath = getRegistryLockPath(registryPath);
  const lease = lockContext.getStore()?.leases.get(lockPath);
  if (!lease) throw new RegistryLockLostError(lockPath);
  lease.assertOwned();
}

function staleSnapshot(lockPath: string, alive: (pid: number) => boolean): LockSnapshot | null {
  const snapshot = readSnapshot(lockPath);
  const owner = parseOwner(snapshot.raw);
  return owner && alive(owner.pid) ? null : snapshot;
}

function removeSnapshot(lockPath: string, expected: LockSnapshot): boolean {
  try {
    const current = readSnapshot(lockPath);
    if (
      current.raw !== expected.raw
      || current.device !== expected.device
      || current.inode !== expected.inode
      || current.modifiedAt !== expected.modifiedAt
    ) return false;
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function tryAcquireReaper(lockPath: string, now: number, alive: (pid: number) => boolean): RegistryLockLease | null {
  const guardPath = `${lockPath}.reap`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner = { pid: process.pid, startedAt: now, token: randomUUID() };
    try {
      const snapshot = createLockRecord(guardPath, owner);
      if (snapshot) return createLease(guardPath, owner, snapshot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let stale: LockSnapshot | null;
    try {
      stale = staleSnapshot(guardPath, alive);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stale) return null;
    if (!removeSnapshot(guardPath, stale)) continue;
  }
  return null;
}

export function tryAcquireRegistryLock(
  lockPath = getRegistryLockPath(),
  options: Pick<RegistryLockOptions, 'now' | 'isAlive'> = {},
): RegistryLockLease | null {
  const now = options.now?.() ?? Date.now();
  const alive = options.isAlive ?? isPidAlive;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner = { pid: process.pid, startedAt: now, token: randomUUID() };
    try {
      const snapshot = createLockRecord(lockPath, owner);
      if (snapshot) return createLease(lockPath, owner, snapshot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    let stale: LockSnapshot | null;
    try {
      stale = staleSnapshot(lockPath, alive);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stale) return null;
    const reaper = tryAcquireReaper(lockPath, now, alive);
    if (!reaper) return null;
    try {
      let current: LockSnapshot | null;
      try {
        current = staleSnapshot(lockPath, alive);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!current) return null;
      if (!removeSnapshot(lockPath, current)) continue;
    } finally {
      reaper.release();
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function timeoutError(lockPath: string, waitMs: number, alive: (pid: number) => boolean): Error {
  let owner: LockOwner | null = null;
  try {
    owner = parseOwner(readSnapshot(lockPath).raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (owner && alive(owner.pid)) {
    return new Error(`Timed out after ${waitMs}ms waiting for lock held by Leverframe process (pid ${owner.pid}): ${lockPath}`);
  }
  return new Error(`Timed out after ${waitMs}ms waiting for lock: ${lockPath}`);
}

export async function withRegistryWriteLock<T>(
  operation: () => Promise<T> | T,
  options: RegistryLockOptions = {},
): Promise<T> {
  const lockPath = options.lockPath ?? getRegistryLockPath();
  const inherited = lockContext.getStore()?.leases;
  if (inherited?.get(lockPath)?.active) return operation();

  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + waitMs;
  let lease: RegistryLockLease | null = null;
  while (!lease) {
    lease = tryAcquireRegistryLock(lockPath, { now, isAlive: options.isAlive });
    if (lease) break;
    if (now() >= deadline) throw timeoutError(lockPath, waitMs, options.isAlive ?? isPidAlive);
    await sleep(retryMs);
  }

  const leases = new Map(inherited);
  leases.set(lockPath, lease);
  return lockContext.run({ leases }, async () => {
    try {
      return await operation();
    } finally {
      lease.release();
    }
  });
}

export function withRegistryWriteLockSync<T>(
  operation: () => T,
  options: RegistryLockOptions = {},
): T {
  const lockPath = options.lockPath ?? getRegistryLockPath();
  const inherited = lockContext.getStore()?.leases;
  if (inherited?.get(lockPath)?.active) return operation();

  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + waitMs;
  let lease: RegistryLockLease | null = null;
  while (!lease) {
    lease = tryAcquireRegistryLock(lockPath, { now, isAlive: options.isAlive });
    if (lease) break;
    if (now() >= deadline) throw timeoutError(lockPath, waitMs, options.isAlive ?? isPidAlive);
    sleepSync(retryMs);
  }

  const leases = new Map(inherited);
  leases.set(lockPath, lease);
  return lockContext.run({ leases }, () => {
    try {
      return operation();
    } finally {
      lease.release();
    }
  });
}

export function getCredentialMutationLockPath(authRef: string): string {
  const digest = createHash('sha256').update('leverframe-credential\0').update(authRef).digest('hex');
  return join(getAppHome(), 'credential-locks', `${digest}.lock`);
}

export function withCredentialMutationLock<T>(
  authRef: string,
  operation: () => Promise<T> | T,
  options: Pick<RegistryLockOptions, 'waitMs' | 'retryMs'> = {},
): Promise<T> {
  return withRegistryWriteLock(operation, {
    ...options,
    lockPath: getCredentialMutationLockPath(authRef),
    waitMs: options.waitMs ?? DEFAULT_CREDENTIAL_WAIT_MS,
  });
}

export function getProviderMutationLockPath(providerSlot: string): string {
  const digest = createHash('sha256').update('leverframe-provider\0').update(providerSlot).digest('hex');
  return `${getProvidersPath()}.provider-${digest}.lock`;
}

export function withProviderMutationLock<T>(providerSlot: string, operation: () => Promise<T> | T): Promise<T> {
  return withRegistryWriteLock(operation, { lockPath: getProviderMutationLockPath(providerSlot) });
}
