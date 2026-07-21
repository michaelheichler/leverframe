import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetLegacyMigrationForTests } from '../src/paths.js';
import { _configLockInternals } from '../src/config.js';

const CAPABILITY_MARKER_NAME = '.lock-worker-capability';
const CHILD_TIMEOUT_MS = 60_000;
const MARKER_WAIT_MS = 15_000;
const MARKER_POLL_MS = 25;

let tempHome: string;
let previousHome: string | undefined;
let previousLeverframeHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'leverframe-contention-'));
  previousHome = process.env['HOME'];
  previousLeverframeHome = process.env['LEVERFRAME_HOME'];
  process.env['HOME'] = tempHome;
  process.env['LEVERFRAME_HOME'] = join(tempHome, 'app-home');
  resetLegacyMigrationForTests();
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  if (previousLeverframeHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousLeverframeHome;
  resetLegacyMigrationForTests();
});

interface WorkerResult {
  workerId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface SpawnedWorker {
  child: ChildProcess;
  result: Promise<WorkerResult>;
}

function spawnProductionWorker(
  workerId: string,
  homeDir: string,
  rounds: number,
  capability: string,
  syncDir: string,
): SpawnedWorker {
  const child: ChildProcess = spawn(
      process.execPath,
      [join('node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/config-lock-contention-worker.test.ts'],
      {
        env: {
          ...process.env,
          LEVERFRAME_HOME: homeDir,
          LEVERFRAME_LOCK_WORKER_MODE: 'run',
          LEVERFRAME_LOCK_WORKER_ID: workerId,
          LEVERFRAME_LOCK_WORKER_ROUNDS: String(rounds),
          LEVERFRAME_LOCK_WORKER_HOME: homeDir,
          LEVERFRAME_LOCK_WORKER_CAPABILITY: capability,
          LEVERFRAME_LOCK_WORKER_SYNC_DIR: syncDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  const result = new Promise<WorkerResult>(resolve => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CHILD_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ workerId, exitCode: null, stdout, stderr, timedOut });
    });
    child.on('close', status => {
      clearTimeout(timer);
      resolve({ workerId, exitCode: status, stdout, stderr, timedOut });
    });
  });
  return { child, result };
}

async function waitForMarker(markerPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(markerPath)) {
    if (Date.now() >= deadline) {
      throw new Error(`marker ${markerPath} did not appear within ${timeoutMs}ms`);
    }
    await new Promise<void>(resolve => setTimeout(resolve, MARKER_POLL_MS));
  }
}

describe('cross-process config lock (production config entry points, real child processes)', () => {
  it('serializes concurrent production setAppPathOverride calls so every worker key survives', async () => {
    const homeDir = process.env['LEVERFRAME_HOME']!;
    mkdirSync(homeDir, { recursive: true });

    // Fresh per-run capability. The worker matches it against a marker in LEVERFRAME_HOME.
    const capability = randomUUID();
    writeFileSync(join(homeDir, CAPABILITY_MARKER_NAME), capability, { mode: 0o600 });

    const syncDir = mkdtempSync(join(tmpdir(), 'leverframe-contention-sync-'));
    try {
      // Acquire the production lock BEFORE spawning so children hit a held lock.
      const lockPath = _configLockInternals.lockPath();
      mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
      const releaseLock = _configLockInternals.tryAcquire(lockPath);
      expect(releaseLock).not.toBeNull();

      const workerCount = 4;
      const rounds = 8;

      const workers = Array.from({ length: workerCount }, (_, i) =>
        spawnProductionWorker(`${i}`, homeDir, rounds, capability, syncDir));
      const childPromises = workers.map(worker => worker.result);

      let lockReleased = false;
      let results: WorkerResult[];
      try {
        for (let i = 0; i < workerCount; i++) {
          await waitForMarker(join(syncDir, `${i}.ready`), MARKER_WAIT_MS);
        }

        // START is written WHILE the lock is held, so every child piles up on it.
        writeFileSync(join(syncDir, 'start.marker'), '', { mode: 0o600 });

        // Attempt markers prove each child was live and contending before release.
        for (let i = 0; i < workerCount; i++) {
          await waitForMarker(join(syncDir, `${i}.attempt`), MARKER_WAIT_MS);
        }

        releaseLock();
        lockReleased = true;
        results = await Promise.all(childPromises);
      } finally {
        if (!lockReleased) releaseLock();
        for (const { child } of workers) {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
        await Promise.allSettled(childPromises);
      }

      for (const r of results) {
        expect(r.timedOut).toBe(false);
        if (r.exitCode !== 0) {
          throw new Error(
            `worker ${r.workerId} exited ${r.exitCode}\n--stdout--\n${r.stdout}\n--stderr--\n${r.stderr}`,
          );
        }
      }

      const configPath = join(homeDir, 'config.json');
      expect(existsSync(configPath)).toBe(true);
      const final = JSON.parse(readFileSync(configPath, 'utf8')) as {
        appPathOverrides?: Record<string, string>;
      };
      for (let i = 0; i < workerCount; i++) {
        expect(final.appPathOverrides?.[`worker-${i}`]).toBe(`value-${rounds - 1}`);
      }

      expect(existsSync(_configLockInternals.lockPath())).toBe(false);
    } finally {
      rmSync(syncDir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('production lock primitives', () => {
  it('uses the same nonce-ownership release in the production lock', () => {
    const lockPath = _configLockInternals.lockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    const release = _configLockInternals.tryAcquire(lockPath);
    expect(release).not.toBeNull();
    release!();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('production tryAcquire holds the lock so a second in-process caller backs off', () => {
    const lockPath = _configLockInternals.lockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    const release = _configLockInternals.tryAcquire(lockPath);
    expect(release).not.toBeNull();
    expect(_configLockInternals.tryAcquire(lockPath)).toBeNull();
    release!();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('production primitives reject a fresh empty lock so a contender cannot evict an in-flight acquire', () => {
    const lockPath = _configLockInternals.lockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, '', { mode: 0o600 });
    expect(_configLockInternals.tryAcquire(lockPath)).toBeNull();
    expect(existsSync(lockPath)).toBe(true);
  });

  it('production primitives recover an old malformed lock after the grace window', () => {
    const lockPath = _configLockInternals.lockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, 'not json', { mode: 0o600 });
    _configLockInternals.setMtime(lockPath, Date.now() - (_configLockInternals.malformedGraceMs + 5_000));
    const release = _configLockInternals.tryAcquire(lockPath);
    expect(release).not.toBeNull();
    release!();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('production primitives recover a malformed lock whose mtime is far in the future', () => {
    const lockPath = _configLockInternals.lockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, 'not json', { mode: 0o600 });
    _configLockInternals.setMtime(lockPath, Date.now() + (_configLockInternals.futureSkewMs + 60_000));
    const release = _configLockInternals.tryAcquire(lockPath);
    expect(release).not.toBeNull();
    release!();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('production primitives treat a malformed lock with a near-now future mtime as fresh', () => {
    const lockPath = _configLockInternals.lockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, 'not json', { mode: 0o600 });
    _configLockInternals.setMtime(lockPath, Date.now() + 100);
    expect(_configLockInternals.tryAcquire(lockPath)).toBeNull();
    expect(existsSync(lockPath)).toBe(true);
  });
});
