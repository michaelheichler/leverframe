import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetLegacyMigrationForTests } from '../src/paths.js';

const mockState = vi.hoisted(() => ({
  writeFileSyncMock: vi.fn(),
  closeSyncMock: vi.fn() as unknown as typeof import('node:fs').closeSync,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeFileSync: mockState.writeFileSyncMock,
    closeSync: mockState.closeSyncMock,
  };
});

const fsActual = await vi.importActual<typeof import('node:fs')>('node:fs');

let tempHome: string;
let previousHome: string | undefined;
let previousLeverframeHome: string | undefined;
let previousDbus: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'leverframe-lockfail-'));
  previousHome = process.env['HOME'];
  previousLeverframeHome = process.env['LEVERFRAME_HOME'];
  previousDbus = process.env['DBUS_SESSION_BUS_ADDRESS'];
  process.env['HOME'] = tempHome;
  process.env['LEVERFRAME_HOME'] = join(tempHome, 'app-home');
  resetLegacyMigrationForTests();
  mockState.writeFileSyncMock.mockReset();
  mockState.writeFileSyncMock.mockImplementation((...args: unknown[]) => {
    return fsActual.writeFileSync(...(args as [unknown, unknown]));
  });
  mockState.closeSyncMock.mockReset();
  mockState.closeSyncMock.mockImplementation((...args: unknown[]) => {
    return fsActual.closeSync(...(args as [number]));
  });
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  if (previousLeverframeHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousLeverframeHome;
  if (previousDbus === undefined) delete process.env['DBUS_SESSION_BUS_ADDRESS'];
  else process.env['DBUS_SESSION_BUS_ADDRESS'] = previousDbus;
  resetLegacyMigrationForTests();
  vi.useRealTimers();
});

describe('config lock failed-init cleanup', () => {
  it('unlinks the partial lock file when writeFileSync throws after openSync succeeds', async () => {
    const { _configLockInternals } = await import('../src/config.js');
    const lockPath = _configLockInternals.lockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

    let firstCall = true;
    mockState.writeFileSyncMock.mockImplementation((...args: unknown[]) => {
      if (firstCall) {
        firstCall = false;
        throw new Error('disk full');
      }
      return fsActual.writeFileSync(...(args as [unknown, unknown]));
    });

    expect(() => _configLockInternals.tryAcquire(lockPath)).toThrow('disk full');
    expect(existsSync(lockPath)).toBe(false);

    const release = _configLockInternals.tryAcquire(lockPath);
    expect(release).not.toBeNull();
    release!();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('treats closeSync failure after a successful write as initialization failure and unlinks only the owned lock', async () => {
    const { _configLockInternals } = await import('../src/config.js');
    const lockPath = _configLockInternals.lockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

    let firstCall = true;
    mockState.closeSyncMock.mockImplementation((...args: unknown[]) => {
      if (firstCall) {
        firstCall = false;
        throw new Error('close EBADF');
      }
      return fsActual.closeSync(...(args as [number]));
    });

    expect(() => _configLockInternals.tryAcquire(lockPath)).toThrow('close EBADF');
    expect(existsSync(lockPath)).toBe(false);

    const release = _configLockInternals.tryAcquire(lockPath);
    expect(release).not.toBeNull();
    release!();
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('server-password lock never falls through lockless', () => {
  it('throws ConfigLockBusyError when a live owner holds the lock past the bounded wait', async () => {
    vi.useFakeTimers();
    const { _configLockInternals, getSavedServerPassword, ConfigLockBusyError } = await import('../src/config.js');
    const lockPath = _configLockInternals.serverPasswordLockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), nonce: 'live-owner' }),
      'utf8',
    );

    const promise = getSavedServerPassword();
    const assertion = expect(promise).rejects.toBeInstanceOf(ConfigLockBusyError);

    await vi.advanceTimersByTimeAsync(_configLockInternals.waitMs + 1);
    await assertion;

    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe('live-owner');
  });
});
