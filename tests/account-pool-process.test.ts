import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

let tempHome: string;

function viteNodeEntry(): string {
  const require = createRequire(import.meta.url);
  const vitestPackage = require.resolve('vitest/package.json');
  const vitestRequire = createRequire(vitestPackage);
  const viteNodePackage = vitestRequire.resolve('vite-node/package.json');
  return join(dirname(viteNodePackage), 'vite-node.mjs');
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'leverframe-account-pool-process-'));
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

async function waitFor(path: string, workers: readonly Promise<number | null>[]): Promise<void> {
  const marker = async (): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (!existsSync(path)) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for account-pool worker');
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
  };
  const earlyExit = Promise.race(workers.map(async worker => {
    await worker;
    throw new Error(`Account-pool worker exited before creating ${path}`);
  }));
  await Promise.race([marker(), earlyExit]);
}

function startWorker(workerId: string, statePath: string, syncDir: string): Promise<number | null> {
  const child: ChildProcess = spawn(process.execPath, [
    viteNodeEntry(), '--script', 'tests/fixtures/account-pool-process-worker.ts',
  ], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      LEVERFRAME_ACCOUNT_POOL_WORKER_MODE: 'run',
      LEVERFRAME_ACCOUNT_POOL_WORKER_ID: workerId,
      LEVERFRAME_ACCOUNT_POOL_STATE_PATH: statePath,
      LEVERFRAME_ACCOUNT_POOL_SYNC_DIR: syncDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(code);
      else reject(new Error(`Account-pool worker ${workerId} exited with status ${code}: ${stderr}`));
    });
  });
}

it('serializes simultaneous reservations across two fixture processes', async () => {
  const statePath = join(tempHome, 'shared-pool-state.json');
  const syncDir = join(tempHome, 'sync');
  mkdirSync(syncDir);
  const workers = ['first', 'second'].map(id => startWorker(id, statePath, syncDir));

  await Promise.all([
    waitFor(join(syncDir, 'first.ready'), workers),
    waitFor(join(syncDir, 'second.ready'), workers),
  ]);
  writeFileSync(join(syncDir, 'start'), 'go');
  await Promise.all(workers);

  const selected = [
    readFileSync(join(syncDir, 'first.result'), 'utf8'),
    readFileSync(join(syncDir, 'second.result'), 'utf8'),
  ];
  const persisted = readFileSync(statePath, 'utf8');
  const state = JSON.parse(persisted) as {
    reservations: Array<{ accountId: string; expiresAt: number }>;
  };
  const liveReservations = state.reservations.filter(reservation => reservation.expiresAt > 500);

  expect(new Set(selected).size).toBe(2);
  expect(liveReservations).toHaveLength(2);
  expect(new Set(liveReservations.map(reservation => reservation.accountId))).toEqual(new Set(selected));
  expect(persisted).not.toContain('process-session-first');
  expect(persisted).not.toContain('process-session-second');
}, 60_000);
