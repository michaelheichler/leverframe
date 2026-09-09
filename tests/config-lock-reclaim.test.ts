import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

it('does not reclaim through an abandoned guard without operator cleanup', () => {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-reclaim-abandoned-'));
  homes.push(home);
  const path = join(home, 'config.lock');
  const stale = JSON.stringify({ pid: 123456, startedAt: 0, nonce: 'stale' });
  writeFileSync(path, stale);
  mkdirSync(`${path}.reclaim`);
  expect(lock.tryAcquire(path, { isAlive: () => false })).toBeNull();
  expect(readFileSync(path, 'utf8')).toBe(stale);
});
