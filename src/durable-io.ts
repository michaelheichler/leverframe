import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export interface StrictReadOptions {
  maxBytes?: number;
  requirePrivateMode?: boolean;
  description?: string;
}

export interface DurableWriteOptions {
  mode?: number;
  directoryMode?: number;
  fence?: () => void;
  validateExisting?: boolean;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function ensurePrivateDirectory(path: string, mode = PRIVATE_DIRECTORY_MODE): void {
  mkdirSync(path, { recursive: true, mode });
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Private storage path is not a regular directory: ${path}`);
  }
  try {
    chmodSync(path, mode);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

export function assertSafeExistingFile(path: string, description = 'file'): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${description} is not a regular file: ${path}`);
  }
}

/**
 * Open a file only after lstat, then verify that the opened descriptor still
 * names the same inode. Destructive callers use this rather than interpreting
 * an unreadable or replaced file as empty state.
 */
export function readFileStrict(path: string, options: StrictReadOptions = {}): string {
  const description = options.description ?? 'State file';
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${description} is not a regular file: ${path}`);
  }

  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const opened = fstatSync(fd);
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error(`${description} changed while opening: ${path}`);
    }
    if (options.maxBytes !== undefined && opened.size > options.maxBytes) {
      throw new Error(`${description} exceeds ${options.maxBytes} bytes: ${path}`);
    }
    if (typeof process.getuid === 'function' && opened.uid !== process.getuid()) {
      throw new Error(`${description} is owned by another user: ${path}`);
    }
    if (options.requirePrivateMode && process.platform !== 'win32' && (opened.mode & 0o077) !== 0) {
      throw new Error(`${description} permissions are too broad: ${path}`);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function syncParentDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirname(path), 'r');
    fsyncSync(fd);
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EPERM') {
      throw error;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function completeWrite(fd: number, content: string | Buffer): void {
  const payload = Buffer.isBuffer(content) ? content : Buffer.from(content);
  let offset = 0;
  while (offset < payload.length) {
    const written = writeSync(fd, payload, offset, payload.length - offset);
    if (written <= 0) throw new Error('Could not complete durable file write');
    offset += written;
  }
}

/** Publish bytes with O_EXCL 0600 temp, fsync, fenced rename, and parent fsync. */
export function durableAtomicWrite(
  path: string,
  content: string | Buffer,
  options: DurableWriteOptions = {},
): void {
  const mode = options.mode ?? PRIVATE_FILE_MODE;
  const directoryMode = options.directoryMode ?? PRIVATE_DIRECTORY_MODE;
  const directory = dirname(path);
  ensurePrivateDirectory(directory, directoryMode);
  if (options.validateExisting !== false) assertSafeExistingFile(path);

  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let renamed = false;
  let cleanupError: unknown;
  try {
    fd = openSync(temporary, 'wx', mode);
    completeWrite(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    options.fence?.();
    if (options.validateExisting !== false) assertSafeExistingFile(path);
    options.fence?.();
    renameSync(temporary, path);
    renamed = true;
    syncParentDirectory(path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!renamed) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') cleanupError = error;
      }
    }
  }
  if (cleanupError !== undefined) throw cleanupError;
}
