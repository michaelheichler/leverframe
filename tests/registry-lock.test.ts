import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProvidersPath } from '../src/paths.js';
import { loadRegistryStrict, saveRegistry } from '../src/registry/io.js';
import {
  RegistryLockLostError,
  assertRegistryWriteOwnership,
  getRegistryLockPath,
  tryAcquireRegistryLock,
  withRegistryWriteLockSync,
} from '../src/registry/lock.js';

const originalHome = process.env.LEVERFRAME_HOME;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'leverframe-registry-lock-'));
  process.env.LEVERFRAME_HOME = join(root, 'home');
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = originalHome;
});

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function spawnWorker(id: number, rounds: number, syncDir: string): Promise<void> {
  const child = spawn(process.execPath, [
    join('node_modules', 'vitest', 'vitest.mjs'),
    'run',
    'tests/registry-lock-worker.test.ts',
  ], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      LEVERFRAME_REGISTRY_WORKER_MODE: 'run',
      LEVERFRAME_REGISTRY_WORKER_ID: String(id),
      LEVERFRAME_REGISTRY_WORKER_ROUNDS: String(rounds),
      LEVERFRAME_REGISTRY_WORKER_SYNC: syncDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`registry worker ${id} exited ${code}: ${stderr}`));
    });
  });
}

describe('cross-process provider registry lock', () => {
  it('preserves all concurrent read-modify-write updates', async () => {
    saveRegistry({ schemaVersion: 1, providers: [] });
    const syncDir = join(root, 'sync');
    mkdirSync(syncDir);
    const lease = tryAcquireRegistryLock();
    expect(lease).not.toBeNull();
    if (!lease) throw new Error('could not acquire test lock');

    const workerCount = 3;
    const rounds = 6;
    const workers = Array.from({ length: workerCount }, (_, index) => spawnWorker(index, rounds, syncDir));
    try {
      await Promise.all(Array.from({ length: workerCount }, (_, index) => waitFor(join(syncDir, `${index}.ready`))));
      writeFileSync(join(syncDir, 'start'), '');
    } finally {
      lease.release();
    }
    await Promise.all(workers);

    const ids = loadRegistryStrict().providers.map(provider => provider.id);
    expect(new Set(ids).size).toBe(workerCount * rounds);
  }, 30_000);

  it('fences a lease whose lock inode was replaced', () => {
    const lockPath = getRegistryLockPath();
    const lease = tryAcquireRegistryLock(lockPath);
    expect(lease).not.toBeNull();
    if (!lease) throw new Error('could not acquire test lock');
    lease.release();
    expect(() => withRegistryWriteLockSync(() => assertRegistryWriteOwnership())).not.toThrow();
    expect(() => lease.assertOwned()).toThrow(RegistryLockLostError);
  });

  it('rejects a symlink lock path instead of following it', () => {
    mkdirSync(process.env.LEVERFRAME_HOME!, { recursive: true });
    const target = join(root, 'target-lock');
    writeFileSync(target, '{}');
    symlinkSync(target, getRegistryLockPath());
    expect(() => tryAcquireRegistryLock()).toThrow(/not a regular file/);
    expect(getProvidersPath()).toContain(process.env.LEVERFRAME_HOME!);
  });
});
