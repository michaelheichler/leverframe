import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { durableAtomicWrite, readFileStrict } from '../src/durable-io.js';
import {
  RegistryLockLostError,
  tryAcquireRegistryLock,
  withRegistryWriteLock,
} from '../src/registry/lock.js';
import { loadRegistryStrict, updateRegistry } from '../src/registry/io.js';

const originalHome = process.env.LEVERFRAME_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = originalHome;
});

function home(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'leverframe-registry-durable-')), 'home');
  process.env.LEVERFRAME_HOME = path;
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

describe('durable file publication', () => {
  it('uses a unique 0600 temp, complete rename, and rejects symlink targets', () => {
    const directory = home();
    const path = join(directory, 'state.json');
    durableAtomicWrite(path, 'first');
    durableAtomicWrite(path, 'second');
    expect(readFileSync(path, 'utf8')).toBe('second');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);

    const target = join(directory, 'target');
    writeFileSync(target, 'do not change', { mode: 0o600 });
    unlinkSync(path);
    symlinkSync(target, path);
    expect(() => durableAtomicWrite(path, 'secret')).toThrow(/not a regular file/);
    expect(readFileSync(target, 'utf8')).toBe('do not change');
  });

  it('strictly rejects broad permissions for destructive state reads', () => {
    const directory = home();
    const path = join(directory, 'journal.json');
    writeFileSync(path, '{}', { mode: 0o644 });
    chmodSync(path, 0o644);
    expect(() => readFileStrict(path, { requirePrivateMode: true })).toThrow(/permissions are too broad/);
  });
});

describe('registry locking and fencing', () => {
  it('serializes independent asynchronous contenders', async () => {
    const lockPath = join(home(), 'providers.json.lock');
    let releaseFirst: (() => void) | undefined;
    let announceFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>(resolve => { announceFirst = resolve; });
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const order: string[] = [];

    const first = withRegistryWriteLock(async () => {
      order.push('first-start');
      announceFirst?.();
      await firstGate;
      order.push('first-end');
    }, { lockPath, retryMs: 1 });
    await firstStarted;
    const second = withRegistryWriteLock(() => { order.push('second'); }, { lockPath, retryMs: 1 });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(order).toEqual(['first-start']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('reclaims dead owners and fences a replaced lease', () => {
    const lockPath = join(home(), 'providers.json.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, startedAt: 1, token: 'dead' }), { mode: 0o600 });
    const lease = tryAcquireRegistryLock(lockPath, { isAlive: () => false });
    expect(lease).not.toBeNull();
    if (!lease) throw new Error('expected a registry lock lease');
    unlinkSync(lockPath);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: 'replacement' }), { mode: 0o600 });
    expect(() => lease.assertOwned()).toThrow(RegistryLockLostError);
    lease.release();
    expect(readFileSync(lockPath, 'utf8')).toContain('replacement');
  });

  it('commits strict registry updates under the lock without losing fields', () => {
    home();
    updateRegistry(registry => {
      registry.importedAt = 'first';
    });
    updateRegistry(registry => {
      registry.pricingCacheAt = 'second';
    });
    expect(loadRegistryStrict()).toMatchObject({ importedAt: 'first', pricingCacheAt: 'second' });
  });
});
