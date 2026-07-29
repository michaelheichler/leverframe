import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  _credentialStoreInternals,
  buildKeyringHelperEnv,
  deleteFallbackCredential,
  diagnoseCredentialStorage,
  getCredentialFallbackPath,
  readFallbackCredential,
  readStoredCredential,
  runIsolatedKeyringOperation,
  writeFallbackCredential,
} from '../src/credential-store.js';
import { resolveProviderCredential, saveProviderCredential } from '../src/env.js';

const originalHome = process.env['LEVERFRAME_HOME'];
const originalDbus = process.env['DBUS_SESSION_BUS_ADDRESS'];

afterEach(() => {
  if (originalHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = originalHome;
  if (originalDbus === undefined) delete process.env['DBUS_SESSION_BUS_ADDRESS'];
  else process.env['DBUS_SESSION_BUS_ADDRESS'] = originalDbus;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function temporaryHome(): string {
  const directory = mkdtempSync(join(tmpdir(), 'leverframe-credentials-'));
  process.env['LEVERFRAME_HOME'] = join(directory, 'home');
  return process.env['LEVERFRAME_HOME'];
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
    delete process.env['DBUS_SESSION_BUS_ADDRESS'];
    const diagnostics: string[] = [];

    expect(await saveProviderCredential('keyring:provider:openai', 'fallback-secret', message => diagnostics.push(message))).toBe(true);
    expect(await resolveProviderCredential('openai', 'keyring:provider:openai', message => diagnostics.push(message))).toBe('fallback-secret');
    expect(diagnostics.join('\n')).toMatch(/plaintext credential fallback/i);
    expect(diagnostics.join('\n')).toMatch(/no at-rest encryption/i);
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
    delete process.env['DBUS_SESSION_BUS_ADDRESS'];
    const spawned = vi.fn(() => { throw new Error('spawn must not be called when D-Bus is unavailable'); });
    const started = Date.now();

    const result = await runIsolatedKeyringOperation(
      { operation: 'read', service: 'leverframe', account: 'probe' },
      { spawnImpl: spawned as unknown as typeof import('node:child_process').spawn },
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

  it.runIf(process.platform === 'linux')('honors an explicit env over process.env for the availability check', async () => {
    process.env['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=/run/user/1000/bus';
    const spawned = vi.fn(() => { throw new Error('spawn must not be called when the provided env lacks D-Bus'); });

    const result = await runIsolatedKeyringOperation(
      { operation: 'read', service: 'leverframe', account: 'probe' },
      {
        env: { HOME: '/tmp' },
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
    delete process.env['DBUS_SESSION_BUS_ADDRESS'];
    const diagnostics = await diagnoseCredentialStorage({ LEVERFRAME_HOME: home, SSH_CONNECTION: 'client server' });
    const text = diagnostics.map(item => item.message).join('\n');

    expect(text).toMatch(/does not require a GUI/i);
    expect(text).toMatch(/D-Bus session/i);
    expect(text).toMatch(/plaintext credential fallback/i);
    expect(text).toContain(getCredentialFallbackPath({ LEVERFRAME_HOME: home }));
  });
});
