import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _configLockInternals as lock } from '../src/config-lock.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it('does not let a competing stale reclaimer delete the replacement owner', () => {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-reclaim-'));
  homes.push(home);
  const path = join(home, 'config.lock');
  writeFileSync(path, JSON.stringify({ pid: 123456, startedAt: 0, nonce: 'stale' }));
  let competingRelease: (() => void) | null = null;
  const release = lock.tryAcquire(path, {
    isAlive: () => {
      competingRelease = lock.tryAcquire(path, { isAlive: () => false });
      return false;
    },
  });
  try {
    expect(competingRelease).toBeNull();
    expect(release).toBeTypeOf('function');
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid);
    expect(lock.tryAcquire(path)).toBeNull();
  } finally {
    release?.();
    (competingRelease as (() => void) | null)?.();
  }
});

it('releases the reclamation guard when owner inspection throws', () => {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-reclaim-error-'));
  homes.push(home);
  const path = join(home, 'config.lock');
  writeFileSync(path, JSON.stringify({ pid: 123456, startedAt: 0, nonce: 'stale' }));
  expect(() => lock.tryAcquire(path, { isAlive: () => { throw new Error('inspection failed'); } })).toThrow('inspection failed');
  expect(existsSync(`${path}.reclaim`)).toBe(false);
  const release = lock.tryAcquire(path, { isAlive: () => false });
  expect(release).toBeTypeOf('function');
  release?.();
});

it('recovers an empty guard left by a terminated reclaimer', () => {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-reclaim-abandoned-'));
  homes.push(home);
  const path = join(home, 'config.lock');
  const stale = JSON.stringify({ pid: 123456, startedAt: 0, nonce: 'stale' });
  writeFileSync(path, stale);
  mkdirSync(`${path}.reclaim`);
  const release = lock.tryAcquire(path, { isAlive: () => false });
  expect(release).toBeTypeOf('function');
  release?.();
});

it.each(['file', 'symlink'])('treats a %s reclaim path as occupied without changing it', kind => {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-reclaim-malformed-'));
  homes.push(home);
  const path = join(home, 'config.lock');
  const original = JSON.stringify({ pid: 2147483647, startedAt: 0, nonce: 'stale' });
  writeFileSync(path, original);
  const target = join(home, 'untouched');
  writeFileSync(target, 'preserved');
  if (kind === 'file') writeFileSync(`${path}.reclaim`, 'preserved');
  else symlinkSync(target, `${path}.reclaim`);
  expect(lock.tryAcquire(path, { isAlive: () => false })).toBeNull();
  expect(readFileSync(path, 'utf8')).toBe(original);
  expect(readFileSync(`${path}.reclaim`, 'utf8')).toBe('preserved');
});

it('recovers a dead reclaimer but preserves a live guard owner', () => {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-reclaim-owner-'));
  homes.push(home);
  const path = join(home, 'config.lock');
  writeFileSync(path, JSON.stringify({ pid: 2147483647, startedAt: 0, nonce: 'stale' }));
  mkdirSync(`${path}.reclaim`);
  const nonce = '00000000-0000-4000-8000-000000000001';
  const liveOwner = join(`${path}.reclaim`, `${process.pid}.${nonce}`);
  writeFileSync(liveOwner, '');
  expect(lock.tryAcquire(path, { isAlive: () => false })).toBeNull();
  expect(existsSync(liveOwner)).toBe(true);
  rmSync(liveOwner);
  writeFileSync(join(`${path}.reclaim`, `2147483647.${nonce}`), '');
  const release = lock.tryAcquire(path, { isAlive: () => false });
  expect(release).toBeTypeOf('function');
  release?.();
});
