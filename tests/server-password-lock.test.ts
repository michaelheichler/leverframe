import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetLegacyMigrationForTests, getConfigPath } from '../src/paths.js';

const keyringState = vi.hoisted(() => ({
  store: new Map<string, string>(),
  delayMs: 0,
  failing: false,
}));

vi.mock('../src/credential-store.js', async () => {
  const actual = await vi.importActual<typeof import('../src/credential-store.js')>('../src/credential-store.js');
  return {
    ...actual,
    runIsolatedKeyringOperation: vi.fn(async (input: { operation: string; service: string; account: string; value?: string }) => {
      if (keyringState.delayMs > 0) {
        await new Promise<void>(resolve => setTimeout(resolve, keyringState.delayMs));
      }
      if (keyringState.failing) return { ok: false, error: 'mock keyring failure' } as const;
      const key = `${input.service}:${input.account}`;
      if (input.operation === 'read') {
        return { ok: true, value: keyringState.store.get(key) ?? null } as const;
      }
      if (input.operation === 'write') {
        keyringState.store.set(key, input.value ?? '');
        return { ok: true, value: null } as const;
      }
      if (input.operation === 'delete') {
        keyringState.store.delete(key);
        return { ok: true, value: null } as const;
      }
      return { ok: false, error: 'unknown operation' } as const;
    }),
  };
});

const configModule = await import('../src/config.js');
const { setSavedServerPassword, getSavedServerPassword, clearSavedServerPassword } = configModule;

let tempHome: string;
let previousHome: string | undefined;
let previousLeverframeHome: string | undefined;
let previousDbus: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'leverframe-races-'));
  previousHome = process.env['HOME'];
  previousLeverframeHome = process.env['LEVERFRAME_HOME'];
  previousDbus = process.env['DBUS_SESSION_BUS_ADDRESS'];
  process.env['HOME'] = tempHome;
  process.env['LEVERFRAME_HOME'] = join(tempHome, 'app-home');
  resetLegacyMigrationForTests();
  keyringState.store.clear();
  keyringState.delayMs = 0;
  keyringState.failing = false;
  vi.mocked(configModule.runIsolatedKeyringOperation === undefined ? {} : {}).mockClear?.();
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

function seedConfig(data: unknown): void {
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const content = typeof data === 'string' ? data : `${JSON.stringify(data)}\n`;
  writeFileSync(path, content, { mode: 0o600 });
}

function readConfig(): Record<string, unknown> {
  const path = getConfigPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('server-password lock serializes keyring+config transitions', () => {
  it('prevents get-vs-clear from resurrecting an old password', async () => {
    await (await setSavedServerPassword('old-password'));
    expect(keyringState.store.get('leverframe-server-password:server-password')).toBe('old-password');

    vi.useFakeTimers();
    keyringState.delayMs = 50;

    const cleared = clearSavedServerPassword();
    const fetched = getSavedServerPassword();

    await vi.advanceTimersByTimeAsync(500);

    await expect(cleared).resolves.toBeUndefined();
    await expect(fetched).resolves.toEqual({ status: 'absent' });
    expect(keyringState.store.get('leverframe-server-password:server-password')).toBeUndefined();
  });

  it('prevents get-vs-set from overwriting a new password during a concurrent migration', async () => {
    seedConfig({ server: { savedPassword: 'legacy-password' } });
    expect(existsSync(getConfigPath())).toBe(true);

    vi.useFakeTimers();
    keyringState.delayMs = 50;

    const fetched = getSavedServerPassword();
    const setted = setSavedServerPassword('new-password');

    await vi.advanceTimersByTimeAsync(500);

    await expect(fetched).resolves.toEqual({ status: 'ok', password: 'legacy-password' });
    await expect(setted).resolves.toEqual({ ok: true });

    expect(keyringState.store.get('leverframe-server-password:server-password')).toBe('new-password');
    const cfg = readConfig();
    expect(cfg.server?.savedPassword ?? null).toBeNull();
  });

  it('setSavedServerPassword fails closed without writing plaintext when keyring is unavailable', async () => {
    keyringState.failing = true;
    const result = await setSavedServerPassword('would-be-fallback');
    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(keyringState.store.get('leverframe-server-password:server-password')).toBeUndefined();
    expect(readConfig().server?.savedPassword ?? null).toBeNull();
    keyringState.failing = false;
  });

  it('prevents set-vs-clear from leaving the keyring out of sync with config', async () => {
    await (await setSavedServerPassword('first-password'));
    expect(keyringState.store.get('leverframe-server-password:server-password')).toBe('first-password');

    vi.useFakeTimers();
    keyringState.delayMs = 50;

    const cleared = clearSavedServerPassword();
    const setted = setSavedServerPassword('replacement');

    await vi.advanceTimersByTimeAsync(500);

    await expect(cleared).resolves.toBeUndefined();
    await expect(setted).resolves.toEqual({ ok: true });

    vi.useRealTimers();
    const final = await getSavedServerPassword();
    expect(final).toEqual({ status: 'ok', password: 'replacement' });
    expect(keyringState.store.get('leverframe-server-password:server-password')).toBe('replacement');
    expect(readConfig().server?.savedPassword ?? null).toBeNull();
  });

  it('migrates a legacy config password to the keyring exactly once under contention', async () => {
    seedConfig({ server: { savedPassword: 'legacy' } });

    vi.useFakeTimers();
    keyringState.delayMs = 50;

    const fetches = [getSavedServerPassword(), getSavedServerPassword(), getSavedServerPassword()];

    await vi.advanceTimersByTimeAsync(800);

    for (const f of fetches) await expect(f).resolves.toEqual({ status: 'ok', password: 'legacy' });

    expect(keyringState.store.get('leverframe-server-password:server-password')).toBe('legacy');
    const cfg = readConfig();
    expect(cfg.server?.savedPassword ?? null).toBeNull();
  });

  it('getSavedServerPassword surfaces a migration-failed status when keyring refuses a legacy plaintext password', async () => {
    seedConfig({ server: { savedPassword: 'legacy' } });
    keyringState.failing = true;

    const result = await getSavedServerPassword();
    expect(result).toEqual({
      status: 'migration-failed',
      plaintextPresent: true,
      error: expect.any(String),
    });
    expect(readConfig().server?.savedPassword).toBe('legacy');
    expect(keyringState.store.get('leverframe-server-password:server-password')).toBeUndefined();
    keyringState.failing = false;
  });
});
