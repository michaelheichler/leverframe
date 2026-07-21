import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  clearSavedServerPassword,
  ConfigLockBusyError,
  CorruptConfigError,
  getAppPathOverride,
  getSavedServerPassword,
  getServerExposedProviders,
  getServerFavoritesOnly,
  getServerListenMode,
  getServerMaskGatewayIds,
  loadPreferences,
  recordLaunchFolder,
  resolveBridgeMode,
  savePreferences,
  setAppPathOverride,
  setSavedServerPassword,
  setServerListenMode,
  _configLockInternals,
} from '../src/config.js';
import {
  getAppHome,
  getConfigPath,
  getLegacyAppHome,
  getOlderLegacyAppHome,
  resetLegacyMigrationForTests,
} from '../src/paths.js';

let tempHome: string;
let previousHome: string | undefined;
let previousDbus: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'leverframe-test-'));
  previousHome = process.env['HOME'];
  process.env['HOME'] = tempHome;
  process.env['LEVERFRAME_HOME'] = join(tempHome, 'app-home');
  previousDbus = process.env['DBUS_SESSION_BUS_ADDRESS'];
  resetLegacyMigrationForTests();
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  delete process.env['LEVERFRAME_HOME'];
  if (previousDbus === undefined) delete process.env['DBUS_SESSION_BUS_ADDRESS'];
  else process.env['DBUS_SESSION_BUS_ADDRESS'] = previousDbus;
  resetLegacyMigrationForTests();
});

describe('app paths', () => {
  it('uses LEVERFRAME_HOME when set', () => {
    process.env['LEVERFRAME_HOME'] = join(tempHome, 'custom-home');

    expect(getAppHome()).toBe(join(tempHome, 'custom-home'));
  });

  it('defaults to a .leverframe folder under the user home', () => {
    expect(getAppHome({ HOME: tempHome })).toBe(join(tempHome, '.leverframe'));
  });

  it('stores config.json inside the app home', () => {
    process.env['LEVERFRAME_HOME'] = join(tempHome, 'app');

    expect(getConfigPath()).toBe(join(tempHome, 'app', 'config.json'));
  });
});

describe('dotfolder config', () => {
  it('writes preferences to config.json in the app home', () => {
    savePreferences({ lastProvider: 'openai-oauth', lastModel: 'gpt-5.6-sol' });

    expect(loadPreferences()).toMatchObject({
      lastProvider: 'openai-oauth',
      lastModel: 'gpt-5.6-sol',
    });
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8'))).toMatchObject({
      lastProvider: 'openai-oauth',
      lastModel: 'gpt-5.6-sol',
    });
  });

  it('saves favorites and aliases', () => {
    savePreferences({
      favoriteModels: [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
      modelAliases: [{ name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
    });

    expect(loadPreferences()).toMatchObject({
      favoriteModels: [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
      modelAliases: [{ name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
    });
  });

  it('saves and clears app path overrides', () => {
    setAppPathOverride('claude', '/tmp/custom-claude');

    expect(getAppPathOverride('claude')).toBe('/tmp/custom-claude');
    expect(loadPreferences().appPathOverrides).toEqual({ claude: '/tmp/custom-claude' });

    setAppPathOverride('claude', null);

    expect(getAppPathOverride('claude')).toBeUndefined();
    expect(loadPreferences().appPathOverrides).toBeUndefined();
  });

  it('records recent launch folders with most recent first', () => {
    recordLaunchFolder('/Users/jbendavi/project-a');
    recordLaunchFolder('/Users/jbendavi/project-b');
    recordLaunchFolder('/Users/jbendavi/project-a');

    expect(loadPreferences().recentLaunchFolders).toEqual([
      '/Users/jbendavi/project-a',
      '/Users/jbendavi/project-b',
    ]);
  });

  it('returns absent status when no server password is saved', async () => {
    delete process.env['DBUS_SESSION_BUS_ADDRESS'];
    const result = await getSavedServerPassword();
    if (result.status === 'migration-failed') {
      expect(result.error).toMatch(/Secret Service|keyring|D-Bus|dbus/i);
    } else {
      expect(result.status).toBe('absent');
    }
  });

  it('saves and clears a server password, surfacing keyring failures rather than writing plaintext', async () => {
    delete process.env['DBUS_SESSION_BUS_ADDRESS'];

    const saved = await setSavedServerPassword('my-lan-password');
    if (saved.ok) {
      expect(await getSavedServerPassword()).toEqual({ status: 'ok', password: 'my-lan-password' });
      await clearSavedServerPassword();
      expect(await getSavedServerPassword()).toEqual({ status: 'absent' });
    } else {
      expect(saved.ok).toBe(false);
      expect(saved.error).toMatch(/Secret Service|keyring|D-Bus|dbus/i);
      const lookup = await getSavedServerPassword();
      expect(lookup.status).toBe('migration-failed');
      const cfgPath = getConfigPath();
      if (existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
        expect(cfg.server?.savedPassword ?? null).toBeNull();
      }
    }
  });

  it('saves server listen-mode preference', () => {
    expect(getServerListenMode()).toBe('local');

    setServerListenMode('network');
    expect(getServerListenMode()).toBe('network');

    setServerListenMode('local');
    expect(getServerListenMode()).toBe('local');
  });

  it('creates the app home lazily', () => {
    expect(existsSync(process.env['LEVERFRAME_HOME']!)).toBe(false);

    savePreferences({ lastProvider: 'openai' });

    expect(existsSync(process.env['LEVERFRAME_HOME']!)).toBe(true);
  });
});

describe('bridge-mode memory', () => {
  it('defaults both commands to proxy mode when nothing is saved', () => {
    expect(resolveBridgeMode('claude', undefined)).toBe('proxy');
    expect(resolveBridgeMode('server', undefined)).toBe('proxy');
  });

  it('never auto-persists an explicit mode flag', () => {
    expect(resolveBridgeMode('claude', 'endpoint')).toBe('endpoint');
    expect(resolveBridgeMode('claude', undefined)).toBe('proxy');

    expect(resolveBridgeMode('server', 'endpoint', { persist: false })).toBe('endpoint');
    expect(resolveBridgeMode('server', undefined)).toBe('proxy');
  });

  it('persists only with an explicit save gesture (--save-mode), per command', () => {
    expect(resolveBridgeMode('claude', 'endpoint', { persist: true })).toBe('endpoint');
    expect(resolveBridgeMode('claude', undefined)).toBe('endpoint');
    // server is remembered independently. Still the proxy default.
    expect(resolveBridgeMode('server', undefined)).toBe('proxy');

    expect(resolveBridgeMode('server', 'endpoint', { persist: true })).toBe('endpoint');
    expect(resolveBridgeMode('server', undefined)).toBe('endpoint');

    // saved default is overridable for one run without losing the saved value
    expect(resolveBridgeMode('claude', 'proxy')).toBe('proxy');
    expect(resolveBridgeMode('claude', undefined)).toBe('endpoint');

    // and replaceable with another --save-mode
    expect(resolveBridgeMode('claude', 'proxy', { persist: true })).toBe('proxy');
    expect(resolveBridgeMode('claude', undefined)).toBe('proxy');
    expect(resolveBridgeMode('server', undefined)).toBe('endpoint');
  });
});

describe('legacy ~/.clodex migration', () => {
  it('copies config and auth state on first read when the leverframe home is missing', () => {
    delete process.env['LEVERFRAME_HOME'];
    const legacyHome = getLegacyAppHome({ HOME: tempHome });
    expect(legacyHome).toBe(join(tempHome, '.clodex'));
    mkdirSync(join(legacyHome, 'http-proxy'), { recursive: true });
    writeFileSync(join(legacyHome, 'config.json'), JSON.stringify({ lastModel: 'gpt-5.6-sol' }), 'utf8');
    writeFileSync(join(legacyHome, 'providers.json'), JSON.stringify({ schemaVersion: 1, providers: [] }), 'utf8');
    writeFileSync(join(legacyHome, 'http-proxy', 'ca.pem'), 'PEM', 'utf8');
    mkdirSync(join(legacyHome, 'logs'), { recursive: true });
    writeFileSync(join(legacyHome, 'logs', 'session.log'), 'log', 'utf8');
    resetLegacyMigrationForTests();

    expect(loadPreferences().lastModel).toBe('gpt-5.6-sol');
    const appHome = getAppHome({ HOME: tempHome });
    expect(existsSync(join(appHome, 'config.json'))).toBe(true);
    expect(existsSync(join(appHome, 'providers.json'))).toBe(true);
    expect(existsSync(join(appHome, 'http-proxy', 'ca.pem'))).toBe(true);
    // logs are session state, not config. Never copied.
    expect(existsSync(join(appHome, 'logs'))).toBe(false);
    // the legacy home is never modified
    expect(readFileSync(join(legacyHome, 'config.json'), 'utf8')).toContain('gpt-5.6-sol');
    expect(readFileSync(join(legacyHome, 'logs', 'session.log'), 'utf8')).toBe('log');
  });

  it('does not migrate when the leverframe home already exists', () => {
    delete process.env['LEVERFRAME_HOME'];
    const appHome = getAppHome({ HOME: tempHome });
    mkdirSync(appHome, { recursive: true });
    writeFileSync(join(appHome, 'config.json'), JSON.stringify({ lastModel: 'existing' }), 'utf8');

    const legacyHome = getLegacyAppHome({ HOME: tempHome });
    mkdirSync(legacyHome, { recursive: true });
    writeFileSync(join(legacyHome, 'config.json'), JSON.stringify({ lastModel: 'legacy' }), 'utf8');
    resetLegacyMigrationForTests();

    expect(loadPreferences().lastModel).toBe('existing');
  });

  it('uses older ~/.relay-ai state only when ~/.clodex is absent', () => {
    delete process.env['LEVERFRAME_HOME'];
    const olderHome = getOlderLegacyAppHome({ HOME: tempHome });
    mkdirSync(olderHome, { recursive: true });
    writeFileSync(join(olderHome, 'config.json'), JSON.stringify({ lastModel: 'older' }), 'utf8');
    resetLegacyMigrationForTests();

    expect(loadPreferences().lastModel).toBe('older');
    expect(readFileSync(join(olderHome, 'config.json'), 'utf8')).toContain('older');
  });
});

describe('corrupt config handling', () => {
  it('loadPreferences returns defaults and warns when config.json is corrupt', () => {
    const configPath = getConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, '{ not valid json', { encoding: 'utf8', mode: 0o600 });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prefs = loadPreferences();

    expect(prefs).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('config.json');
    // The corrupt file is preserved untouched for inspection.
    expect(readFileSync(configPath, 'utf8')).toBe('{ not valid json');
    warn.mockRestore();
  });

  it('loadPreferences returns defaults when config.json holds a JSON non-object', () => {
    const configPath = getConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, '[1, 2, 3]', { encoding: 'utf8', mode: 0o600 });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadPreferences()).toEqual({});
    warn.mockRestore();
  });

  it('savePreferences throws CorruptConfigError and never overwrites the corrupt file', () => {
    const configPath = getConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    const corrupt = '{ broken';
    writeFileSync(configPath, corrupt, { encoding: 'utf8', mode: 0o600 });

    expect(() => savePreferences({ lastModel: 'gpt-5.6-sol' })).toThrow(CorruptConfigError);
    // Existing corrupt content survives the failed save attempt.
    expect(readFileSync(configPath, 'utf8')).toBe(corrupt);
  });

  it('setAppPathOverride throws CorruptConfigError instead of wiping a corrupt config', () => {
    const configPath = getConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, 'null', { encoding: 'utf8', mode: 0o600 });

    expect(() => setAppPathOverride('claude', '/tmp/x')).toThrow(CorruptConfigError);
    expect(readFileSync(configPath, 'utf8')).toBe('null');
  });

  it('setServerListenMode throws CorruptConfigError on a corrupt config', () => {
    const configPath = getConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, 'garbage', { encoding: 'utf8', mode: 0o600 });

    expect(() => setServerListenMode('network')).toThrow(CorruptConfigError);
  });

  it('recordLaunchFolder throws CorruptConfigError on a corrupt config', () => {
    const configPath = getConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, 'garbage', { encoding: 'utf8', mode: 0o600 });

    expect(() => recordLaunchFolder('/project')).toThrow(CorruptConfigError);
  });

  it('saving into a fresh (missing) config still works', () => {
    expect(existsSync(getConfigPath())).toBe(false);
    savePreferences({ lastModel: 'gpt-5.6-sol' });
    expect(loadPreferences().lastModel).toBe('gpt-5.6-sol');
  });
});

describe('atomic config write', () => {
  it('writes config.json atomically with 0600 permissions and no leftover temp files', () => {
    savePreferences({ lastProvider: 'openai', lastModel: 'gpt-5.6-sol' });

    const configPath = getConfigPath();
    const dir = dirname(configPath);
    const entries = readdirSync(dir);
    // The atomic write renames the temp away, leaving only config.json.
    expect(entries).toContain('config.json');
    expect(entries.some(name => name.endsWith('.tmp'))).toBe(false);

    const stat = statSync(configPath);
    // 0o600 on POSIX. On platforms that strip the mode we still accept the file.
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(written).toMatchObject({ lastProvider: 'openai', lastModel: 'gpt-5.6-sol' });
  });

  it('preserves existing preferences when saving a partial update', () => {
    savePreferences({ lastProvider: 'openai', lastModel: 'gpt-5.6-sol' });
    savePreferences({ claudeBridgeMode: 'endpoint' });

    const onDisk = JSON.parse(readFileSync(getConfigPath(), 'utf8'));
    expect(onDisk).toMatchObject({
      lastProvider: 'openai',
      lastModel: 'gpt-5.6-sol',
      claudeBridgeMode: 'endpoint',
    });
  });
});

describe('concurrent mutation serialization', () => {
  it('preserves both independent updates from concurrent writers', async () => {
    const writers: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      writers.push(Promise.resolve(setAppPathOverride(`app-${i}`, `/path/${i}`)));
    }
    for (let i = 0; i < 20; i++) {
      writers.push(Promise.resolve(savePreferences({ lastModel: `model-${i}` })));
    }
    await Promise.all(writers);

    const overrides = loadPreferences().appPathOverrides ?? {};
    for (let i = 0; i < 20; i++) {
      expect(overrides[`app-${i}`]).toBe(`/path/${i}`);
    }
    const lastModel = loadPreferences().lastModel;
    expect(lastModel).toMatch(/^model-\d+$/);
  });

  it('preserves both updates when two different fields are written concurrently', async () => {
    await Promise.all([
      Promise.resolve(setServerListenMode('network')),
      Promise.resolve(setAppPathOverride('claude', '/tmp/cli')),
    ]);

    const prefs = loadPreferences();
    expect(prefs.server?.listenMode).toBe('network');
    expect(prefs.appPathOverrides?.claude).toBe('/tmp/cli');
  });
});

describe('corrupt config read-only getters are non-destructive', () => {
  function corruptConfig(content: string): void {
    const configPath = getConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, content, { encoding: 'utf8', mode: 0o600 });
  }

  it('getServerListenMode returns the default and leaves the corrupt file intact', () => {
    const corrupt = '{ broken';
    corruptConfig(corrupt);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getServerListenMode()).toBe('local');
    expect(readFileSync(getConfigPath(), 'utf8')).toBe(corrupt);
    warn.mockRestore();
  });

  it('getServerMaskGatewayIds returns the default on corrupt config', () => {
    corruptConfig('null');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getServerMaskGatewayIds()).toBe(true);
    warn.mockRestore();
  });

  it('getServerFavoritesOnly returns the default on corrupt config', () => {
    corruptConfig('garbage');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getServerFavoritesOnly()).toBe(false);
    warn.mockRestore();
  });

  it('getServerExposedProviders returns null on corrupt config', () => {
    corruptConfig('[]');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getServerExposedProviders()).toBeNull();
    warn.mockRestore();
  });
});

describe('config lock internals', () => {
  it('acquires a fresh lock and releases it on cleanup', () => {
    const lockPath = _configLockInternals.lockPath();
    const release = _configLockInternals.tryAcquire(lockPath);
    expect(release).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    expect(_configLockInternals.tryAcquire(lockPath)).toBeNull();
    release!();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('treats a lock held by a dead pid as stale', () => {
    const lockPath = _configLockInternals.lockPath();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: Date.now(), nonce: 'dead-owner' }), 'utf8');
    const release = _configLockInternals.tryAcquire(lockPath);
    expect(release).not.toBeNull();
    release!();
  });

  it('does NOT evict a live pid merely for age', () => {
    const lockPath = _configLockInternals.lockPath();
    mkdirSync(dirname(lockPath), { recursive: true });
    const oldStartedAt = Date.now() - (_configLockInternals.staleMs + 60_000);
    const otherLivePid = process.pid;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: otherLivePid, startedAt: oldStartedAt, nonce: 'some-other-owner' }),
      'utf8',
    );
    expect(_configLockInternals.tryAcquire(lockPath)).toBeNull();
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).toBe('some-other-owner');
  });

  it('treats an unreadable lock file older than the grace window as stale', () => {
    const lockPath = _configLockInternals.lockPath();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, 'not json at all', 'utf8');
    _configLockInternals.setMtime(lockPath, Date.now() - (_configLockInternals.malformedGraceMs + 5_000));
    const release = _configLockInternals.tryAcquire(lockPath);
    expect(release).not.toBeNull();
    release!();
  });

  it('treats a fresh malformed lock file as BUSY (no unlink, no acquire)', () => {
    const lockPath = _configLockInternals.lockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, 'not json at all', 'utf8');
    expect(_configLockInternals.tryAcquire(lockPath)).toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe('not json at all');
  });

  it('treats a fresh empty lock file as BUSY (no unlink, no acquire)', () => {
    const lockPath = _configLockInternals.lockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, '', 'utf8');
    expect(_configLockInternals.tryAcquire(lockPath)).toBeNull();
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe('');
  });

  it('recovers a malformed lock file once the grace window elapses', () => {
    const lockPath = _configLockInternals.lockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, '', 'utf8');
    _configLockInternals.setMtime(lockPath, Date.now() - (_configLockInternals.malformedGraceMs + 1_000));
    const release = _configLockInternals.tryAcquire(lockPath);
    expect(release).not.toBeNull();
    release!();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('treats a fresh lock with malformed metadata (missing nonce) as BUSY', () => {
    const lockPath = _configLockInternals.lockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: Date.now() }), 'utf8');
    expect(_configLockInternals.tryAcquire(lockPath)).toBeNull();
    expect(existsSync(lockPath)).toBe(true);
  });

  it('verifies ownership via nonce on release so a recovered owner never deletes a successor', () => {
    const lockPath = _configLockInternals.lockPath();
    mkdirSync(dirname(lockPath), { recursive: true });

    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, startedAt: Date.now(), nonce: 'original-owner' }),
      'utf8',
    );

    const staleRelease = _configLockInternals.tryAcquire(lockPath);
    expect(staleRelease).not.toBeNull();

    expect(JSON.parse(readFileSync(lockPath, 'utf8')).nonce).not.toBe('original-owner');

    _configLockInternals.release(lockPath, 'original-owner');
    expect(existsSync(lockPath)).toBe(true);

    staleRelease!();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('cleans up the partial lock file when writeFileSync fails after open', () => {
    const lockPath = _configLockInternals.lockPath();
    const release = _configLockInternals.tryAcquire(lockPath);
    expect(release).not.toBeNull();
    release!();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('rejects a symlink lock path without following or replacing it', () => {
    const lockPath = _configLockInternals.lockPath();
    const dir = dirname(lockPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, '..', 'lock-symlink-target.json');
    writeFileSync(target, '{"unrelated":"content"}\n', { mode: 0o600 });
    symlinkSync(target, lockPath);

    expect(() => _configLockInternals.tryAcquire(lockPath)).toThrow(/symlink|not a regular file/);
    expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('{"unrelated":"content"}\n');
  });

  it('rejects a directory lock path', () => {
    const lockPath = _configLockInternals.lockPath();
    mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    expect(() => _configLockInternals.tryAcquire(lockPath)).toThrow(/not a regular file/);
  });
});
