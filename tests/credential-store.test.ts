import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  _credentialStoreInternals,
  buildKeyringHelperEnv,
  classifyKeyringError,
  KEYRING_TIMEOUT_MS,
  deleteFallbackCredential,
  deleteStoredCredential,
  diagnoseCredentialStorage,
  getCredentialFallbackPath,
  readFallbackCredential,
  readStoredCredential,
  runIsolatedKeyringOperation,
  writeFallbackCredential,
  writeStoredCredential,
} from '../src/credential-store.js';
import { resolveProviderCredential, saveProviderCredential } from '../src/env.js';

const originalHome = process.env['LEVERFRAME_HOME'];
const originalDbus = process.env['DBUS_SESSION_BUS_ADDRESS'];
const originalXdgRuntime = process.env['XDG_RUNTIME_DIR'];

afterEach(() => {
  if (originalHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = originalHome;
  if (originalDbus === undefined) delete process.env['DBUS_SESSION_BUS_ADDRESS'];
  else process.env['DBUS_SESSION_BUS_ADDRESS'] = originalDbus;
  if (originalXdgRuntime === undefined) delete process.env['XDG_RUNTIME_DIR'];
  else process.env['XDG_RUNTIME_DIR'] = originalXdgRuntime;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function temporaryHome(): string {
  const directory = mkdtempSync(join(tmpdir(), 'leverframe-credentials-'));
  process.env['LEVERFRAME_HOME'] = join(directory, 'home');
  return process.env['LEVERFRAME_HOME'];
}

function isolateFromSystemDbus(): string {
  delete process.env['DBUS_SESSION_BUS_ADDRESS'];
  const runtimeDir = mkdtempSync(join(tmpdir(), 'leverframe-no-dbus-'));
  process.env['XDG_RUNTIME_DIR'] = runtimeDir;
  return runtimeDir;
}

describe('credential fallback', () => {
  it('persists and reads credentials with private permissions and atomic replacement', () => {
    const home = temporaryHome();
    const path = getCredentialFallbackPath();
    writeFallbackCredential('provider:openai', 'first-secret');
    writeFallbackCredential('provider:openai', 'second-secret');

    expect(readFallbackCredential('provider:openai')).toBe('second-secret');
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(readFileSync(path, 'utf8')).not.toContain('first-secret');
  });

  it('fails clearly on corrupt data without overwriting it', () => {
    temporaryHome();
    const path = getCredentialFallbackPath();
    writeFallbackCredential('provider:openai', 'secret');
    writeFileSync(path, '{broken', { mode: 0o600 });

    expect(() => writeFallbackCredential('provider:other', 'other-secret')).toThrow(/fallback file is corrupt/);
    expect(readFileSync(path, 'utf8')).toBe('{broken');
  });

  it('does not reinterpret or overwrite unrelated JSON as credential storage', () => {
    temporaryHome();
    const path = getCredentialFallbackPath();
    writeFallbackCredential('provider:openai', 'secret');
    const unrelated = '{"theme":"dark"}\n';
    writeFileSync(path, unrelated, { mode: 0o600 });

    expect(() => writeFallbackCredential('provider:other', 'other-secret')).toThrow(/invalid format/);
    expect(readFileSync(path, 'utf8')).toBe(unrelated);
  });

  it('rejects a symlink fallback path without following or replacing it', () => {
    const home = temporaryHome();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const target = join(home, '..', 'unrelated-target.json');
    const targetContent = '{"unrelated":"config"}\n';
    writeFileSync(target, targetContent, { mode: 0o600 });
    const path = getCredentialFallbackPath();
    symlinkSync(target, path);

    expect(() => readFallbackCredential('provider:openai')).toThrow(/not a regular file/);
    expect(() => writeFallbackCredential('provider:openai', 'secret')).toThrow(/not a regular file/);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(targetContent);
  });

  it('rejects a directory fallback path without replacing or mutating it', () => {
    const home = temporaryHome();
    const path = getCredentialFallbackPath();
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const marker = join(path, 'unrelated.txt');
    writeFileSync(marker, 'keep me', { mode: 0o600 });

    expect(() => readFallbackCredential('provider:openai')).toThrow(/not a regular file/);
    expect(() => writeFallbackCredential('provider:openai', 'secret')).toThrow(/not a regular file/);
    expect(lstatSync(path).isDirectory()).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('keep me');
    expect(lstatSync(home).isDirectory()).toBe(true);
  });

  it('removes only the requested fallback credential', () => {
    temporaryHome();
    writeFallbackCredential('provider:one', 'one');
    writeFallbackCredential('provider:two', 'two');
    expect(deleteFallbackCredential('provider:one')).toBe(true);
    expect(readFallbackCredential('provider:one')).toBeNull();
    expect(readFallbackCredential('provider:two')).toBe('two');
  });

  it.runIf(process.platform === 'linux')('saves and resolves through fallback when Linux D-Bus is unavailable', async () => {
    temporaryHome();
    isolateFromSystemDbus();
    const diagnostics: string[] = [];

    expect(await saveProviderCredential('keyring:provider:openai', 'fallback-secret', message => diagnostics.push(message))).toBe(true);
    expect(await resolveProviderCredential('openai', 'keyring:provider:openai', message => diagnostics.push(message))).toBe('fallback-secret');
    expect(diagnostics.join('\n')).toMatch(/plaintext credential fallback/i);
    expect(diagnostics.join('\n')).toMatch(/no at-rest encryption/i);
  });

  it('promotes fallback data when keyring service returns', async () => {
    temporaryHome();
    const account = 'provider:openai';
    const credential = JSON.stringify({ type: 'oauth', access: 'new-token', refresh: 'refresh-token' });
    writeFallbackCredential(account, credential);
    let keyringValue: string | null = null;
    vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
      if (input.operation === 'read') return { ok: true, value: keyringValue };
      if (input.operation === 'write') {
        expect(input.value).toBe(credential);
        keyringValue = input.value;
        return { ok: true, value: null };
      }
      throw new Error(`Unexpected keyring operation: ${input.operation}`);
    });

    await expect(readStoredCredential(account)).resolves.toBe(credential);
    expect(readFallbackCredential(account)).toBeNull();
  });

  it('promotes a newer fallback over an older readable keyring value', async () => {
    temporaryHome();
    const account = 'provider:openai';
    const oldCredential = JSON.stringify({ type: 'oauth', access: 'old-token' });
    const newCredential = JSON.stringify({ type: 'oauth', access: 'new-token' });
    writeFallbackCredential(account, newCredential);
    let keyringValue = oldCredential;
    vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
      if (input.operation === 'read') return { ok: true, value: keyringValue };
      if (input.operation === 'write') {
        expect(input.value).toBe(newCredential);
        keyringValue = input.value;
        return { ok: true, value: null };
      }
      throw new Error(`Unexpected keyring operation: ${input.operation}`);
    });

    await expect(readStoredCredential(account)).resolves.toBe(newCredential);
    expect(readFallbackCredential(account)).toBeNull();
  });

  it('promotes fallback data through a pending keyring deletion', async () => {
    temporaryHome();
    const account = 'provider:openai';
    const credential = JSON.stringify({ type: 'oauth', access: 'replacement-token' });
    writeFallbackCredential(account, credential);
    let pending = true;
    vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
      if (input.operation === 'read') {
        return pending ? { ok: true, value: null, deleted: true } : { ok: true, value: credential };
      }
      if (input.operation === 'write') {
        pending = false;
        return { ok: true, value: null };
      }
      throw new Error(`Unexpected keyring operation: ${input.operation}`);
    });

    await expect(readStoredCredential(account)).resolves.toBe(credential);
    expect(readFallbackCredential(account)).toBeNull();
  });

  it('updates existing fallback data before attempting a newer keyring write', async () => {
    temporaryHome();
    const account = 'provider:openai';
    writeFallbackCredential(account, 'old-token');
    vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
      expect(input.operation).toBe('write');
      expect(readFallbackCredential(account)).toBe('new-token');
      return { ok: false, error: 'Secret Service unavailable' };
    });

    await expect(writeStoredCredential(account, 'new-token')).resolves.toBe(true);
    expect(readFallbackCredential(account)).toBe('new-token');
  });

  it('reports success after keyring publication when stale fallback cleanup fails', async () => {
    temporaryHome();
    const account = 'provider:openai';
    writeFallbackCredential(account, 'old-token');
    const fallbackPath = getCredentialFallbackPath();
    vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async () => {
      writeFileSync(fallbackPath, '{broken', { mode: 0o600 });
      return { ok: true, value: null };
    });
    const diagnostics: string[] = [];

    await expect(writeStoredCredential(account, 'new-token', message => diagnostics.push(message))).resolves.toBe(true);
    expect(diagnostics).toContainEqual(expect.stringMatching(/stale fallback material remains/));
  });

  it('does not bypass corrupt keyring metadata with fallback data', async () => {
    temporaryHome();
    const account = 'provider:openai';
    writeFallbackCredential(account, 'fallback-token');
    const operation = vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockResolvedValue({
      ok: false,
      error: 'integrity: keyring credential journal is corrupt',
    });

    await expect(readStoredCredential(account)).resolves.toBeNull();
    expect(operation).toHaveBeenCalledTimes(2);
    expect(operation.mock.calls.map(call => call[0].operation)).toEqual(['read', 'repair']);
    expect(readFallbackCredential(account)).toBe('fallback-token');
  });

  it('auto-repairs transient keyring integrity errors when fallback is absent', async () => {
    temporaryHome();
    const account = 'provider:openai';
    const operation = vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
      if (input.operation === 'read') {
        return { ok: false, error: 'integrity: published keyring credential does not match its journal' };
      }
      if (input.operation === 'repair') return { ok: true, value: 'live-token' };
      throw new Error(`Unexpected keyring operation: ${input.operation}`);
    });

    await expect(readStoredCredential(account)).resolves.toBe('live-token');
    expect(operation.mock.calls.map(call => call[0].operation)).toEqual(['read', 'repair']);
  });

  it('promotes fallback after auto-repair when fallback is present', async () => {
    temporaryHome();
    const account = 'provider:openai';
    writeFallbackCredential(account, 'fallback-token');
    let reads = 0;
    const operation = vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
      if (input.operation === 'read') {
        reads += 1;
        if (reads === 1) {
          return { ok: false, error: 'integrity: published keyring credential does not match its journal' };
        }
        return { ok: true, value: 'fallback-token' };
      }
      if (input.operation === 'repair') return { ok: true, value: 'live-token' };
      if (input.operation === 'write') return { ok: true, value: null };
      throw new Error(`Unexpected keyring operation: ${input.operation}`);
    });

    await expect(readStoredCredential(account)).resolves.toBe('fallback-token');
    expect(operation.mock.calls.map(call => call[0].operation)).toEqual(['read', 'repair', 'write', 'read']);
    expect(readFallbackCredential(account)).toBeNull();
  });

  it('does not migrate leftover legacy secrets after auto-repair clears the account', async () => {
    temporaryHome();
    const account = 'provider:openai';
    let leverframeReads = 0;
    const operation = vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
      if (input.operation === 'read' && input.service === 'leverframe') {
        leverframeReads += 1;
        if (leverframeReads === 1) {
          return { ok: false, error: 'integrity: published keyring credential does not match its journal' };
        }
        return { ok: true, value: null };
      }
      if (input.operation === 'repair') return { ok: true, value: null };
      if (input.operation === 'read' && (input.service === 'clodex' || input.service === 'relay-ai')) {
        return { ok: true, value: 'legacy-secret' };
      }
      throw new Error(`Unexpected keyring operation: ${input.operation} ${input.service}`);
    });

    await expect(readStoredCredential(account)).resolves.toBeNull();
    expect(operation.mock.calls.map(call => [call[0].operation, call[0].service])).toEqual([
      ['read', 'leverframe'],
      ['repair', 'leverframe'],
      ['read', 'leverframe'],
    ]);
  });

  it('removes fallback data before starting explicit keyring deletion', async () => {
    temporaryHome();
    const account = 'provider:openai';
    writeFallbackCredential(account, 'fallback-token');
    const operation = vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
      expect(input.operation).toBe('delete');
      expect(readFallbackCredential(account)).toBeNull();
      return { ok: true, value: null };
    });

    await expect(deleteStoredCredential(account)).resolves.toBe(true);
    expect(operation).toHaveBeenCalledOnce();
  });

  it('does not start keyring deletion when fallback absence cannot be verified', async () => {
    temporaryHome();
    const account = 'provider:openai';
    writeFallbackCredential(account, 'fallback-token');
    writeFileSync(getCredentialFallbackPath(), '{broken', { mode: 0o600 });
    const operation = vi.spyOn(_credentialStoreInternals, 'keyringOperation');

    await expect(deleteStoredCredential(account)).resolves.toBe(false);
    expect(operation).not.toHaveBeenCalled();
  });
});

describe('legacy keychain migration', () => {
  it('falls back from leverframe to clodex and copies the credential forward', async () => {
    temporaryHome();
    const operations: Array<{ operation: string; service: string }> = [];
    vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
      operations.push({ operation: input.operation, service: input.service });
      if (input.operation === 'read' && input.service === 'leverframe') return { ok: true, value: null };
      if (input.operation === 'read' && input.service === 'clodex') return { ok: true, value: 'legacy-secret' };
      if (input.operation === 'write' && input.service === 'leverframe') return { ok: true, value: null };
      throw new Error(`Unexpected keyring operation: ${input.operation} ${input.service}`);
    });

    await expect(readStoredCredential('provider:openai')).resolves.toBe('legacy-secret');
    expect(operations).toEqual([
      { operation: 'read', service: 'leverframe' },
      { operation: 'read', service: 'clodex' },
      { operation: 'write', service: 'leverframe' },
    ]);
  });

  it('checks relay-ai after an empty clodex lookup and copies that credential forward', async () => {
    temporaryHome();
    const operations: Array<{ operation: string; service: string }> = [];
    vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
      operations.push({ operation: input.operation, service: input.service });
      if (input.operation === 'read' && input.service === 'relay-ai') return { ok: true, value: 'older-secret' };
      if (input.operation === 'write' && input.service === 'leverframe') return { ok: true, value: null };
      if (input.operation === 'read') return { ok: true, value: null };
      throw new Error(`Unexpected keyring operation: ${input.operation} ${input.service}`);
    });

    await expect(readStoredCredential('provider:openai')).resolves.toBe('older-secret');
    expect(operations).toEqual([
      { operation: 'read', service: 'leverframe' },
      { operation: 'read', service: 'clodex' },
      { operation: 'read', service: 'relay-ai' },
      { operation: 'write', service: 'leverframe' },
    ]);
  });

  it('continues to the clodex service when the leverframe lookup fails', async () => {
    temporaryHome();
    vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
      if (input.operation === 'read' && input.service === 'leverframe') return { ok: false, error: 'primary unavailable' };
      if (input.operation === 'read' && input.service === 'clodex') return { ok: true, value: 'legacy-secret' };
      if (input.operation === 'write' && input.service === 'leverframe') return { ok: true, value: null };
      throw new Error(`Unexpected keyring operation: ${input.operation} ${input.service}`);
    });
    const diagnostics: string[] = [];

    await expect(readStoredCredential('provider:openai', message => diagnostics.push(message))).resolves.toBe('legacy-secret');
    expect(diagnostics).toContain('keyring error: primary unavailable');
  });
});

describe('isolated keyring operations', () => {
  it('kills a blocked child using KEYRING_TIMEOUT_MS by default', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const result = runIsolatedKeyringOperation(
      { operation: 'read', service: 'leverframe', account: 'probe' },
      { moduleUrl: 'file:///missing.mjs', spawnImpl: asSpawn(() => child), skipAvailabilityCheck: true },
    );

    vi.advanceTimersByTime(KEYRING_TIMEOUT_MS);
    await expect(result).resolves.toEqual({
      ok: false,
      error: `keyring operation timed out after ${KEYRING_TIMEOUT_MS}ms`,
    });
    expect(child.kill).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      kill: ReturnType<typeof vi.fn>;
      unref: ReturnType<typeof vi.fn>;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = vi.fn(() => true);
    child.unref = vi.fn(() => child);
    return child;
  }

  const asSpawn = (factory: () => ReturnType<typeof fakeChild>) =>
    factory as unknown as typeof import('node:child_process').spawn;

  it('passes only required platform variables to the helper', () => {
    expect(buildKeyringHelperEnv({
      HOME: '/home/test',
      PATH: '/bin',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/bus',
      XDG_RUNTIME_DIR: '/run/user/1000',
      NODE_OPTIONS: '--require /tmp/steal-secrets.js',
      LEVERFRAME_KEY_OPENAI: 'api-secret',
      OPENAI_API_KEY: 'api-secret',
      OAUTH_TOKEN: 'oauth-secret',
    })).toEqual({
      HOME: '/home/test',
      PATH: '/bin',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/bus',
      XDG_RUNTIME_DIR: '/run/user/1000',
    });
  });

  it('preserves an explicit D-Bus address instead of deriving one', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    expect(buildKeyringHelperEnv({
      DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/tmp/explicit-bus',
      XDG_RUNTIME_DIR: '/missing/runtime',
    }).DBUS_SESSION_BUS_ADDRESS).toBe('unix:abstract=/tmp/explicit-bus');
  });

  it('derives the D-Bus address from an owned runtime socket', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const runtime = mkdtempSync(join(tmpdir(), 'leverframe-dbus-runtime-'));
    const socketPath = join(runtime, 'bus');
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });

    try {
      expect(buildKeyringHelperEnv({ HOME: '/home/test', XDG_RUNTIME_DIR: runtime })).toMatchObject({
        HOME: '/home/test',
        XDG_RUNTIME_DIR: runtime,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${socketPath}`,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('does not derive a D-Bus address from a regular file', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const runtime = mkdtempSync(join(tmpdir(), 'leverframe-dbus-runtime-'));
    writeFileSync(join(runtime, 'bus'), 'not a socket');

    expect(buildKeyringHelperEnv({ XDG_RUNTIME_DIR: runtime }).DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
  });

  it('distinguishes a missing D-Bus session from a missing Secret Service daemon', () => {
    expect(classifyKeyringError('D-Bus session is unavailable; Secret Service keyring access cannot be used'))
      .toMatch(/^D-Bus session is unavailable/);
    expect(classifyKeyringError('org.freedesktop.secrets has no owner'))
      .toMatch(/^Secret Service daemon is not running/);
  });

  it('classifies incomplete keyring transaction cleanup as an integrity error', () => {
    expect(classifyKeyringError('integrity: keyring credential cleanup is incomplete'))
      .toBe('keyring integrity error: keyring credential cleanup is incomplete');
  });

  it('kills a child process whose synchronous native-shaped call blocks', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'leverframe-keyring-module-'));
    const modulePath = join(directory, 'blocked.mjs');
    writeFileSync(modulePath, `export class Entry { getPassword() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000); } }`);
    const started = Date.now();

    const result = await runIsolatedKeyringOperation(
      { operation: 'read', service: 'leverframe', account: 'probe' },
      { timeoutMs: 50, moduleUrl: pathToFileURL(modulePath).href, skipAvailabilityCheck: true },
    );

    expect(result).toEqual({ ok: false, error: 'keyring operation timed out after 50ms' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('returns a synchronous spawn failure without leaving a timer', async () => {
    vi.useFakeTimers();
    const spawnImpl = (() => { throw new Error('spawn failed'); }) as typeof import('node:child_process').spawn;

    await expect(runIsolatedKeyringOperation(
      { operation: 'read', service: 'leverframe', account: 'probe' },
      { moduleUrl: 'file:///missing.mjs', spawnImpl, skipAvailabilityCheck: true },
    )).resolves.toEqual({ ok: false, error: 'spawn failed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles once and removes listeners when stdin fails before close', async () => {
    const child = fakeChild();
    const result = runIsolatedKeyringOperation(
      { operation: 'read', service: 'leverframe', account: 'probe' },
      { moduleUrl: 'file:///missing.mjs', spawnImpl: asSpawn(() => child), skipAvailabilityCheck: true },
    );

    child.stdin.emit('error', new Error('stdin failed'));
    child.emit('close', 1, null);

    await expect(result).resolves.toEqual({ ok: false, error: 'stdin failed' });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.stdin.listenerCount('error')).toBe(0);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('settles once and removes listeners when the spawned child emits an error', async () => {
    const child = fakeChild();
    const result = runIsolatedKeyringOperation(
      { operation: 'read', service: 'leverframe', account: 'probe' },
      { moduleUrl: 'file:///missing.mjs', spawnImpl: asSpawn(() => child), skipAvailabilityCheck: true },
    );

    child.emit('error', new Error('child failed'));
    child.emit('close', 1, null);

    await expect(result).resolves.toEqual({ ok: false, error: 'child failed' });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.stdin.listenerCount('error')).toBe(0);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('settles once and removes listeners when timeout races with close', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const result = runIsolatedKeyringOperation(
      { operation: 'read', service: 'leverframe', account: 'probe' },
      { timeoutMs: 50, moduleUrl: 'file:///missing.mjs', spawnImpl: asSpawn(() => child), skipAvailabilityCheck: true },
    );

    await vi.advanceTimersByTimeAsync(50);
    child.emit('close', 0, null);

    await expect(result).resolves.toEqual({ ok: false, error: 'keyring operation timed out after 50ms' });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.stdin.listenerCount('error')).toBe(0);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.runIf(process.platform === 'linux')('fast-fails without spawning when D-Bus session bus is unavailable', async () => {
    const spawned = vi.fn(() => { throw new Error('spawn must not be called when D-Bus is unavailable'); });
    const started = Date.now();
    const runtime = mkdtempSync(join(tmpdir(), 'leverframe-missing-dbus-'));

    const result = await runIsolatedKeyringOperation(
      { operation: 'read', service: 'leverframe', account: 'probe' },
      {
        env: { XDG_RUNTIME_DIR: runtime },
        spawnImpl: spawned as unknown as typeof import('node:child_process').spawn,
      },
    );

    expect(result).toEqual({ ok: false, error: 'D-Bus session is unavailable; Secret Service keyring access cannot be used' });
    expect(spawned).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it.runIf(process.platform === 'linux')('proceeds to spawn when D-Bus session bus is available', async () => {
    process.env['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=/run/user/1000/bus';
    const child = fakeChild();
    const result = runIsolatedKeyringOperation(
      { operation: 'read', service: 'leverframe', account: 'probe' },
      { moduleUrl: 'file:///missing.mjs', spawnImpl: asSpawn(() => child) },
    );

    child.stdout.end(JSON.stringify({ ok: true, value: null }));
    child.emit('close', 0, null);

    await expect(result).resolves.toEqual({ ok: true, value: null });
  });

  it('passes a derived D-Bus address to the spawned helper', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const runtime = mkdtempSync(join(tmpdir(), 'leverframe-dbus-runtime-'));
    const socketPath = join(runtime, 'bus');
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const child = fakeChild();
    const spawned = vi.fn(asSpawn(() => child)) as unknown as typeof import('node:child_process').spawn;

    try {
      const result = runIsolatedKeyringOperation(
        { operation: 'read', service: 'leverframe', account: 'probe' },
        { env: { XDG_RUNTIME_DIR: runtime }, moduleUrl: 'file:///missing.mjs', spawnImpl: spawned },
      );
      child.stdout.end(JSON.stringify({ ok: true, value: null }));
      child.emit('close', 0, null);

      await expect(result).resolves.toEqual({ ok: true, value: null });
      expect(vi.mocked(spawned).mock.calls[0]?.[2]?.env).toMatchObject({
        XDG_RUNTIME_DIR: runtime,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${socketPath}`,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.runIf(process.platform === 'linux')('honors an explicit env over process.env for the availability check', async () => {
    process.env['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=/run/user/1000/bus';
    const spawned = vi.fn(() => { throw new Error('spawn must not be called when the provided env lacks D-Bus'); });

    const result = await runIsolatedKeyringOperation(
      { operation: 'read', service: 'leverframe', account: 'probe' },
      {
        env: { HOME: '/tmp', XDG_RUNTIME_DIR: mkdtempSync(join(tmpdir(), 'leverframe-missing-dbus-')) },
        spawnImpl: spawned as unknown as typeof import('node:child_process').spawn,
      },
    );

    expect(result).toEqual({ ok: false, error: 'D-Bus session is unavailable; Secret Service keyring access cannot be used' });
    expect(spawned).not.toHaveBeenCalled();
  });
});

describe('headless diagnostics', () => {
  it.runIf(process.platform === 'linux')('explains D-Bus remediation, GUI independence, and fallback storage before OAuth', async () => {
    const home = temporaryHome();
    const isolatedRuntime = mkdtempSync(join(tmpdir(), 'leverframe-no-dbus-'));
    const diagnostics = await diagnoseCredentialStorage({
      LEVERFRAME_HOME: home,
      SSH_CONNECTION: 'client server',
      XDG_RUNTIME_DIR: isolatedRuntime,
    });
    const text = diagnostics.map(item => item.message).join('\n');

    expect(text).toMatch(/does not require a GUI/i);
    expect(text).toMatch(/D-Bus session/i);
    expect(text).toMatch(/plaintext credential fallback/i);
    expect(text).toContain(getCredentialFallbackPath({ LEVERFRAME_HOME: home }));
  });
});
