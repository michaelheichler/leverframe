import { isUtf8 } from 'node:buffer';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_FILE_BYTES = 64 * 1024;
const PRIVATE_FILE = /(?:\.(?:pem|key|p12|pfx)$|^(?:credentials\.json|secrets\.json|id_rsa|id_ed25519)$)/i;

export interface WorkspaceFiles {
  root: string;
  list(): Promise<string[]>;
  inspectListedFile(path: string): Promise<Buffer | null>;
  read(path: string): Promise<Buffer | null>;
}

function pathParts(path: string): string[] | null {
  const parts = path.split('/');
  if (/[\\:\p{Cc}]/u.test(path) || parts.some(part => !part || part.startsWith('.'))) return null;
  return PRIVATE_FILE.test(parts.at(-1)!) ? null : parts;
}

async function readFileBytes(root: string, path: string): Promise<Buffer | null> {
  const parts = pathParts(path);
  if (!parts) return null;

  try {
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      directory = join(directory, part);
      if (!(await lstat(directory)).isDirectory()) return null;
    }
    const candidate = join(directory, parts.at(-1)!);
    const expected = await lstat(candidate, { bigint: true });
    if (!expected.isFile() || expected.ino === 0n) return null;

    const file = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await file.stat({ bigint: true });
      if (!info.isFile() || info.size > BigInt(MAX_FILE_BYTES) || info.dev !== expected.dev || info.ino !== expected.ino
        || await realpath(candidate) !== candidate) return null;
      const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const bytes = buffer.subarray(0, offset);
      if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES || bytes.includes(0) || !isUtf8(bytes)) return null;
      return bytes;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

export async function openWorkspace(root: string): Promise<WorkspaceFiles> {
  const directory = await realpath(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
  env.GIT_OPTIONAL_LOCKS = '0';
  const git = async (...args: string[]) => (await run('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: directory,
    env,
    maxBuffer: 16 * 1024 * 1024,
  })).stdout;
  const topLevel = (await git('rev-parse', '--show-toplevel')).replace(/\r?\n$/, '');
  if (await realpath(topLevel) !== directory) throw new Error('Choose the Git worktree root.');

  const inspectListedFile = (path: string) => readFileBytes(directory, path);
  return {
    root: directory,
    async list() {
      const inventory = await git('ls-files', '--cached', '-z');
      return [...new Set(inventory.split('\0').filter(path => pathParts(path)))].sort();
    },
    inspectListedFile,
    async read(path) {
      if (!pathParts(path)) return null;
      const tracked = await git('--literal-pathspecs', 'ls-files', '--cached', '-z', '--', path);
      return tracked.split('\0').includes(path) ? inspectListedFile(path) : null;
    },
  };
}
