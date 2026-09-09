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
  beforeRename?: () => void;
}

function directoryFsyncIsUnsupported(err: unknown): boolean {
  if (process.platform !== 'win32') return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EBADF' || code === 'EINVAL' || code === 'ENOTSUP' || code === 'EPERM';
}

export function fsyncFileSync(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

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

export function removeFileDurableSync(path: string): void {
  const target = resolve(path);
  rmSync(target, { force: true });
  fsyncDirectorySync(dirname(target));
}

export function sameDirectoryStagePath(targetPath: string, purpose = 'stage'): string {
  const target = resolve(targetPath);
  return `${dirname(target)}/.leverframe-${basename(target)}-${purpose}-${process.pid}-${randomUUID()}`;
}

function canonicalDirectory(path: string): string {
  return realpathSync(dirname(resolve(path)));
}

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
  options.beforeRename?.();
  renameSync(stagePath, targetPath);
  fsyncFileSync(targetPath);
  fsyncDirectorySync(dirname(resolve(targetPath)));
}

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

export function atomicWriteJsonSync(
  targetPath: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): void {
  atomicWriteFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, options);
}

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

    linkSync(stage, target);
    fsyncFileSync(target);
    rmSync(stage);
    fsyncDirectorySync(dirname(target));
  } finally {
    removeFileDurableSync(stage);
  }
}
