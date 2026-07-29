import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, parse, resolve } from 'node:path';

export interface AtomicWriteOptions {
  mode?: number;
  directoryMode?: number;
}

export interface CommitStageOptions {
  mode?: number;
}

function directoryFsyncIsUnsupported(err: unknown): boolean {
  if (process.platform !== 'win32') return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EBADF' || code === 'EINVAL' || code === 'ENOTSUP' || code === 'EPERM';
}

/** Flush a file's contents and metadata to durable storage. */
export function fsyncFileSync(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Flush directory-entry changes. Windows does not expose a portable directory fsync. */
export function fsyncDirectorySync(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (err) {
    if (!directoryFsyncIsUnsupported(err)) throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Create a directory tree and durably publish every newly-created directory
 * entry. Existing directories are left untouched.
 */
export function ensureDirectoryDurableSync(path: string, mode = 0o700): void {
  const target = resolve(path);
  const missing: string[] = [];
  let cursor = target;
  const root = parse(target).root;

  while (cursor !== root && !existsSync(cursor)) {
    missing.push(cursor);
    cursor = dirname(cursor);
  }

  for (const directory of missing.reverse()) {
    mkdirSync(directory, { mode });
    fsyncDirectorySync(dirname(directory));
  }
}

/** Remove a file and durably publish the directory-entry deletion. */
export function removeFileDurableSync(path: string): void {
  const target = resolve(path);
  rmSync(target, { force: true });
  fsyncDirectorySync(dirname(target));
}

/** Return a collision-resistant stage path in the target's own directory. */
export function sameDirectoryStagePath(targetPath: string, purpose = 'stage'): string {
  const target = resolve(targetPath);
  return `${dirname(target)}/.leverframe-${basename(target)}-${purpose}-${process.pid}-${randomUUID()}`;
}

function canonicalDirectory(path: string): string {
  return realpathSync(dirname(resolve(path)));
}

/**
 * Commit a fully-written stage with an atomic same-directory rename, then
 * flush both the committed file and its containing directory.
 */
export function commitSameDirectoryStageSync(
  stagePath: string,
  targetPath: string,
  options: CommitStageOptions = {},
): void {
  if (canonicalDirectory(stagePath) !== canonicalDirectory(targetPath)) {
    throw new Error(`Refusing cross-directory atomic commit from ${stagePath} to ${targetPath}`);
  }

  if (options.mode !== undefined) chmodSync(stagePath, options.mode);
  fsyncFileSync(stagePath);
  renameSync(stagePath, targetPath);
  fsyncFileSync(targetPath);
  fsyncDirectorySync(dirname(resolve(targetPath)));
}

/** Atomically and durably replace a file using a stage beside the target. */
export function atomicWriteFileSync(
  targetPath: string,
  data: string | NodeJS.ArrayBufferView,
  options: AtomicWriteOptions = {},
): void {
  const target = resolve(targetPath);
  ensureDirectoryDurableSync(dirname(target), options.directoryMode);
  const stage = sameDirectoryStagePath(target, 'write');
  const mode = options.mode ?? 0o600;
  let fd: number | undefined;

  try {
    fd = openSync(stage, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    writeFileSync(fd, data);
    chmodSync(stage, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    commitSameDirectoryStageSync(stage, target, { mode });
  } finally {
    if (fd !== undefined) closeSync(fd);
    removeFileDurableSync(stage);
  }
}

/** Atomically write newline-terminated, human-readable JSON. */
export function atomicWriteJsonSync(
  targetPath: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): void {
  atomicWriteFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, options);
}

/**
 * Publish a new immutable file by content-addressed path. The destination must
 * not already exist; callers must verify an existing object's hash instead of
 * replacing it.
 */
export function copyImmutableFileSync(
  sourcePath: string,
  targetPath: string,
  options: AtomicWriteOptions = {},
): void {
  const source = resolve(sourcePath);
  const target = resolve(targetPath);
  ensureDirectoryDurableSync(dirname(target), options.directoryMode);
  const stage = sameDirectoryStagePath(target, 'copy');
  const mode = options.mode ?? (statSync(source).mode & 0o777);

  try {
    copyFileSync(source, stage, constants.COPYFILE_EXCL);
    chmodSync(stage, mode);
    fsyncFileSync(stage);

    // A hard-link publication is the portable no-replace primitive: unlike
    // rename, it fails with EEXIST rather than overwriting an immutable object.
    linkSync(stage, target);
    fsyncFileSync(target);
    rmSync(stage);
    fsyncDirectorySync(dirname(target));
  } finally {
    removeFileDurableSync(stage);
  }
}
