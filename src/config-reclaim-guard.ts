import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OWNER_NAME = /^(\d+)\.[0-9a-f-]{36}$/;

function removeEmptyGuard(path: string): boolean {
  try { rmdirSync(path); return true; } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
    throw error;
  }
}

function reclaimDeadGuard(path: string, isAlive: (pid: number) => boolean): boolean {
  try {
    if (!lstatSync(path).isDirectory()) return false;
    const owners = readdirSync(path);
    if (owners.length === 0) return removeEmptyGuard(path);
    if (owners.length !== 1) return false;
    const match = OWNER_NAME.exec(owners[0]);
    if (!match || isAlive(Number(match[1]))) return false;
    try { unlinkSync(join(path, owners[0])); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return removeEmptyGuard(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

export function acquireConfigReclaimGuard(path: string, isAlive: (pid: number) => boolean): (() => void) | null {
  const owner = `${process.pid}.${randomUUID()}`;
  const staged = mkdtempSync(`${path}-`);
  try {
    writeFileSync(join(staged, owner), '', { mode: 0o600, flag: 'wx' });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        renameSync(staged, path);
        return () => {
          try { unlinkSync(join(path, owner)); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          removeEmptyGuard(path);
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOTDIR') return null;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
        if (!reclaimDeadGuard(path, isAlive)) return null;
      }
    }
    return null;
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}
