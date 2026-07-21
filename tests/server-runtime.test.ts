import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getServerRuntimeLockPath,
  getServerRuntimePath,
  isDiscoveryDisabled,
  isPidAlive,
  orderWrapperServerCandidates,
  parseServerRuntimeStates,
  readLiveServerRuntimeState,
  readLiveServerRuntimeStates,
  registerServerRuntimeState,
  unregisterServerRuntimeState,
  type ServerRuntimeState,
} from '../src/server-runtime.js';

let tempHome: string;
let env: { LEVERFRAME_HOME: string };

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'leverframe-runtime-test-'));
  env = { LEVERFRAME_HOME: join(tempHome, 'app-home') };
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
});

function proxyState(overrides: Partial<ServerRuntimeState> = {}): ServerRuntimeState {
  return {
    mode: 'proxy',
    port: 17645,
    pid: process.pid,
    caPath: '/tmp/leverframe-ca.pem',
    startedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

function endpointState(overrides: Partial<ServerRuntimeState> = {}): ServerRuntimeState {
  return {
    mode: 'endpoint',
    port: 4242,
    pid: process.pid,
    startedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('server runtime state file', () => {
  it('lives at server-runtime.json inside the app home', () => {
    expect(getServerRuntimePath(env)).toBe(join(env.LEVERFRAME_HOME, 'server-runtime.json'));
    expect(getServerRuntimeLockPath(env)).toBe(join(env.LEVERFRAME_HOME, 'server-runtime.lock'));
  });

  it('round-trips proxy and endpoint records through register and read', () => {
    const alwaysAlive = { isAlive: () => true };
    const proxy = proxyState({ pid: 999998 });
    const endpoint = endpointState({ pid: 999999 });
    registerServerRuntimeState(proxy, env, alwaysAlive);
    registerServerRuntimeState(endpoint, env, alwaysAlive);

    expect(readLiveServerRuntimeStates(env, alwaysAlive)).toEqual([proxy, endpoint]);
    expect(readLiveServerRuntimeStates(env, alwaysAlive)[1]?.caPath).toBeUndefined();
  });

  it('persists and reads the per-start token field', () => {
    const alwaysAlive = { isAlive: () => true };
    registerServerRuntimeState(proxyState({ pid: 999998, token: 'proxy-token-abc' }), env, alwaysAlive);
    registerServerRuntimeState(endpointState({ pid: 999999, token: 'endpoint-token-xyz' }), env, alwaysAlive);

    const records = readLiveServerRuntimeStates(env, alwaysAlive);
    expect(records.find(r => r.mode === 'proxy')?.token).toBe('proxy-token-abc');
    expect(records.find(r => r.mode === 'endpoint')?.token).toBe('endpoint-token-xyz');
  });

  it('tolerates legacy records that lack a token field', () => {
    const legacy = endpointState({ pid: 999999 });
    expect(parseServerRuntimeStates(JSON.stringify(legacy))).toEqual([legacy]);
    expect(parseServerRuntimeStates(JSON.stringify(legacy))[0]?.token).toBeUndefined();
  });

  it('rejects records whose token is not a non-empty string', () => {
    const good = endpointState({ pid: 999999, token: 'real-token' });
    expect(parseServerRuntimeStates(JSON.stringify(good))[0]?.token).toBe('real-token');
    const whitespaceOnly = { ...endpointState({ pid: 999999 }), token: '   ' };
    expect(parseServerRuntimeStates(JSON.stringify(whitespaceOnly))[0]?.token).toBeUndefined();
    const numericToken = { ...endpointState({ pid: 999999 }), token: 12345 };
    expect(parseServerRuntimeStates(JSON.stringify(numericToken))[0]?.token).toBeUndefined();
  });

  it('two registering servers do not clobber each other', () => {
    const proxy = proxyState({ pid: process.pid });
    const endpoint = endpointState({ pid: 999999 });
    registerServerRuntimeState(proxy, env);
    registerServerRuntimeState(endpoint, env, { isAlive: () => true });

    const records = readLiveServerRuntimeStates(env, { isAlive: () => true });
    expect(records).toHaveLength(2);
    expect(records.map(record => record.mode).sort()).toEqual(['endpoint', 'proxy']);
  });

  it('re-registering the same pid updates its record instead of duplicating it', () => {
    registerServerRuntimeState(proxyState({ port: 17645 }), env);
    registerServerRuntimeState(proxyState({ port: 17700 }), env);

    const records = readLiveServerRuntimeStates(env);
    expect(records).toHaveLength(1);
    expect(records[0]?.port).toBe(17700);
  });

  it('registration prunes records whose pids are dead', () => {
    registerServerRuntimeState(proxyState({ pid: 999999 }), env, { isAlive: () => true });
    registerServerRuntimeState(endpointState({ pid: process.pid }), env, {
      isAlive: pid => pid === process.pid,
    });

    const records = readLiveServerRuntimeStates(env, { isAlive: () => true });
    expect(records).toHaveLength(1);
    expect(records[0]?.mode).toBe('endpoint');
  });

  it('unregister removes only its own record and keeps the other server registered', () => {
    const proxy = proxyState({ pid: 999998 });
    const endpoint = endpointState({ pid: 999999 });
    registerServerRuntimeState(proxy, env, { isAlive: () => true });
    registerServerRuntimeState(endpoint, env, { isAlive: () => true });

    unregisterServerRuntimeState(999998, env, { isAlive: () => true });

    expect(readLiveServerRuntimeStates(env, { isAlive: () => true })).toEqual([endpoint]);
  });

  it('unregistering the last record deletes the file and is a no-op when already gone', () => {
    registerServerRuntimeState(proxyState(), env);
    unregisterServerRuntimeState(process.pid, env);

    expect(existsSync(getServerRuntimePath(env))).toBe(false);
    expect(() => unregisterServerRuntimeState(process.pid, env)).not.toThrow();
    expect(readLiveServerRuntimeState(env)).toBeNull();
  });

  it('does not leave the lock file behind after a mutation', () => {
    registerServerRuntimeState(proxyState(), env);
    expect(existsSync(getServerRuntimeLockPath(env))).toBe(false);
  });

  it('a stale lock from a dead pid does not block registration', () => {
    // Ensure home exists, then plant a lock owned by a dead pid.
    registerServerRuntimeState(proxyState(), env);
    writeFileSync(getServerRuntimeLockPath(env), JSON.stringify({ pid: 999999, startedAt: 0 }));

    const endpoint = endpointState({ pid: 999998 });
    registerServerRuntimeState(endpoint, env, { isAlive: () => true });

    const records = readLiveServerRuntimeStates(env, { isAlive: () => true });
    expect(records.map(record => record.mode).sort()).toEqual(['endpoint', 'proxy']);
  });
});

describe('parseServerRuntimeStates', () => {
  it('rejects malformed payloads and records', () => {
    expect(parseServerRuntimeStates('not json')).toEqual([]);
    expect(parseServerRuntimeStates('42')).toEqual([]);
    expect(parseServerRuntimeStates(JSON.stringify({ ...proxyState(), mode: 'tunnel' }))).toEqual([]);
    expect(parseServerRuntimeStates(JSON.stringify({ ...proxyState(), port: 0 }))).toEqual([]);
    expect(parseServerRuntimeStates(JSON.stringify({ ...proxyState(), port: 70000 }))).toEqual([]);
    expect(parseServerRuntimeStates(JSON.stringify({ ...proxyState(), pid: -1 }))).toEqual([]);
  });

  it('rejects a proxy-mode record without a usable caPath', () => {
    expect(parseServerRuntimeStates(JSON.stringify(proxyState({ caPath: undefined })))).toEqual([]);
    expect(parseServerRuntimeStates(JSON.stringify(proxyState({ caPath: '  ' })))).toEqual([]);
  });

  it('tolerates the legacy single-object shape as a one-element list', () => {
    const legacy = proxyState();
    expect(parseServerRuntimeStates(JSON.stringify(legacy))).toEqual([legacy]);
  });

  it('parses the multi-record shape, skipping invalid records', () => {
    const good = endpointState();
    const raw = JSON.stringify([good, { mode: 'proxy', port: 1 }]);
    expect(parseServerRuntimeStates(raw)).toEqual([good]);
  });

  it('reader accepts a legacy single-object file written by an old leverframe', () => {
    const legacy = proxyState();
    const path = getServerRuntimePath(env);
    rmSync(path, { force: true });
    registerServerRuntimeState(legacy, env); // ensure dir exists
    writeFileSync(path, `${JSON.stringify(legacy, null, 2)}\n`);

    expect(readLiveServerRuntimeState(env)).toEqual(legacy);
    // A new registration upgrades the file to the array shape without losing the legacy record.
    const endpoint = endpointState({ pid: 999999 });
    registerServerRuntimeState(endpoint, env, { isAlive: () => true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toBeInstanceOf(Array);
    expect(readLiveServerRuntimeStates(env, { isAlive: () => true })).toEqual([legacy, endpoint]);
  });
});

describe('stale detection', () => {
  it('readLiveServerRuntimeState returns null when the recorded pid is dead', () => {
    registerServerRuntimeState(proxyState(), env);

    expect(readLiveServerRuntimeState(env, { isAlive: () => false })).toBeNull();
  });

  it('readLiveServerRuntimeState returns null for a corrupt file', () => {
    registerServerRuntimeState(proxyState(), env);
    writeFileSync(getServerRuntimePath(env), '{ truncated', 'utf8');

    expect(readLiveServerRuntimeState(env)).toBeNull();
  });

  it('isPidAlive maps ESRCH to dead and EPERM to alive', () => {
    const errWith = (code: string) => {
      const err = new Error(code) as NodeJS.ErrnoException;
      err.code = code;
      return err;
    };
    expect(isPidAlive(1234, () => { throw errWith('ESRCH'); })).toBe(false);
    expect(isPidAlive(1234, () => { throw errWith('EPERM'); })).toBe(true);
    expect(isPidAlive(1234, () => undefined)).toBe(true);
  });

  it('isPidAlive reports the current process as alive via the real probe', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
});

describe('wrapper selection policy', () => {
  it('prefers a proxy-mode server over endpoint-mode servers', () => {
    const proxy = proxyState({ pid: 11, startedAt: '2026-07-20T00:00:00.000Z' });
    const endpoint = endpointState({ pid: 12, startedAt: '2026-07-20T09:00:00.000Z' });

    expect(orderWrapperServerCandidates([endpoint, proxy])[0]).toEqual(proxy);
  });

  it('breaks ties within a mode by newest startedAt', () => {
    const older = endpointState({ pid: 11, port: 4242, startedAt: '2026-07-20T00:00:00.000Z' });
    const newer = endpointState({ pid: 12, port: 4243, startedAt: '2026-07-20T09:00:00.000Z' });

    expect(orderWrapperServerCandidates([older, newer])[0]).toEqual(newer);
  });

  it('readLiveServerRuntimeState applies the policy across registered servers', () => {
    const endpoint = endpointState({ pid: 999999, startedAt: '2026-07-20T09:00:00.000Z' });
    const proxy = proxyState({ pid: 999998, startedAt: '2026-07-20T00:00:00.000Z' });
    registerServerRuntimeState(endpoint, env, { isAlive: () => true });
    registerServerRuntimeState(proxy, env, { isAlive: () => true });

    expect(readLiveServerRuntimeState(env, { isAlive: () => true })).toEqual(proxy);
    // Kill the proxy → the endpoint server is selected (current single-server behavior).
    expect(readLiveServerRuntimeState(env, { isAlive: pid => pid !== 999998 })).toEqual(endpoint);
  });
});

describe('isDiscoveryDisabled', () => {
  it('honors the explicit flag over the environment', () => {
    expect(isDiscoveryDisabled(true, {})).toBe(true);
    expect(isDiscoveryDisabled(false, { LEVERFRAME_NO_DISCOVERY: '1' })).toBe(false);
  });

  it('falls back to LEVERFRAME_NO_DISCOVERY', () => {
    expect(isDiscoveryDisabled(undefined, { LEVERFRAME_NO_DISCOVERY: '1' })).toBe(true);
    expect(isDiscoveryDisabled(undefined, { LEVERFRAME_NO_DISCOVERY: 'true' })).toBe(true);
    expect(isDiscoveryDisabled(undefined, { LEVERFRAME_NO_DISCOVERY: '0' })).toBe(false);
    expect(isDiscoveryDisabled(undefined, {})).toBe(false);
  });
});
