import type { UserPreferences } from './types.js';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { ensureLegacyAppHomeMigrated, getAppHome, getConfigPath } from './paths.js';
import { classifyKeyringError, runIsolatedKeyringOperation } from './credential-store.js';

const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;

const CONFIG_LOCK_STALE_MS = 10_000;
const CONFIG_LOCK_WAIT_MS = 5_000;
const CONFIG_LOCK_RETRY_MS = 25;
const CONFIG_LOCK_MALFORMED_GRACE_MS = 500;
const CONFIG_LOCK_FUTURE_SKEW_MS = 5_000;
const CONFIG_LOCK_BUSY_ERROR = 'ConfigLockBusyError';

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

interface ConfigLockContent {
  pid: number;
  startedAt: number;
  nonce: string;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function getConfigLockPath(): string {
  return join(getAppHome(), 'config.lock');
}

function getServerPasswordLockPath(): string {
  return join(getAppHome(), 'server-password.lock');
}

export class ConfigLockBusyError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string, waitedMs: number) {
    super(
      `Could not acquire the config lock at ${lockPath} after ${waitedMs}ms. `
        + 'Another leverframe process is likely writing preferences or migrating a server password. '
        + 'If no leverframe process is running, remove the lock file and re-run.',
    );
    this.name = CONFIG_LOCK_BUSY_ERROR;
    this.lockPath = lockPath;
  }
}

/** @internal Exported for deterministic lock-behavior tests. */
export const _configLockInternals = {
  lockPath: getConfigLockPath,
  serverPasswordLockPath: getServerPasswordLockPath,
  tryAcquire: tryAcquireConfigLock,
  release: releaseConfigLock,
  staleMs: CONFIG_LOCK_STALE_MS,
  waitMs: CONFIG_LOCK_WAIT_MS,
  malformedGraceMs: CONFIG_LOCK_MALFORMED_GRACE_MS,
  futureSkewMs: CONFIG_LOCK_FUTURE_SKEW_MS,
  isRegularFile: isRegularLockPath,
  buildContent: (nonce: string, now: number): ConfigLockContent => ({ pid: process.pid, startedAt: now, nonce }),
  setMtime: (lockPath: string, mtimeMs: number): void => {
    const t = new Date(mtimeMs);
    utimesSync(lockPath, t, t);
  },
};

function isRegularLockPath(lockPath: string): boolean {
  try {
    return lstatSync(lockPath).isFile();
  } catch {
    return true;
  }
}

function assertLockPathIsRegular(lockPath: string): void {
  if (!isRegularLockPath(lockPath)) {
    throw new Error(`Config lock path is not a regular file: ${lockPath}`);
  }
}

function tryAcquireConfigLock(
  lockPath = getConfigLockPath(),
  opts: { now?: number; isAlive?: (pid: number) => boolean } = {},
): (() => void) | null {
  const now = opts.now ?? Date.now();
  const alive = opts.isAlive ?? pidIsAlive;
  const nonce = randomUUID();
  mkdirSync(dirname(lockPath), { recursive: true, mode: CONFIG_DIR_MODE });

  for (let attempt = 0; attempt < 3; attempt++) {
    assertLockPathIsRegular(lockPath);

    let fd: number | undefined;
    try {
      fd = openSync(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EEXIST') {
        if (maybeUnlinkStaleLock(lockPath, alive, { now })) continue;
        return null;
      }
      if (code === 'ELOOP') {
        throw new Error(`Config lock path is a symlink and cannot be used: ${lockPath}`);
      }
      throw err;
    }

    let dataWritten = false;
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now, nonce } satisfies ConfigLockContent));
      dataWritten = true;
      closeSync(fd);
      fd = undefined;
    } catch (publishErr) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best-effort: fd may already be closed */ }
        fd = undefined;
      }
      if (dataWritten) {
        unlinkLockIfOwned(lockPath, nonce);
      } else {
        try { unlinkSync(lockPath); } catch { /* best-effort: file may be partial or already gone */ }
      }
      throw publishErr;
    }

    return () => releaseConfigLock(lockPath, nonce);
  }
  return null;
}

function readLockMetadata(lockPath: string): ConfigLockContent | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Partial<ConfigLockContent>;
  if (typeof obj.pid !== 'number' || !Number.isFinite(obj.pid)) return null;
  if (typeof obj.startedAt !== 'number' || !Number.isFinite(obj.startedAt)) return null;
  if (typeof obj.nonce !== 'string' || obj.nonce.length === 0) return null;
  return { pid: obj.pid, startedAt: obj.startedAt, nonce: obj.nonce };
}

function readLockMtimeMs(lockPath: string): number | null {
  try {
    return lstatSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

function maybeUnlinkStaleLock(
  lockPath: string,
  alive: (pid: number) => boolean,
  opts: { now?: number } = {},
): boolean {
  const now = opts.now ?? Date.now();
  const meta = readLockMetadata(lockPath);
  if (meta === null) {
    const mtime = readLockMtimeMs(lockPath);
    if (mtime === null) return false;
    const age = now - mtime;
    if (age >= 0) {
      if (age < CONFIG_LOCK_MALFORMED_GRACE_MS) return false;
    } else if (-age < CONFIG_LOCK_FUTURE_SKEW_MS) {
      return false;
    }
    try { unlinkSync(lockPath); return true; } catch { return false; }
  }
  if (!alive(meta.pid)) {
    try { unlinkSync(lockPath); return true; } catch { return false; }
  }
  return false;
}

function unlinkLockIfOwned(lockPath: string, nonce: string): void {
  const current = readLockMetadata(lockPath);
  if (current === null || current.nonce !== nonce) return;
  try { unlinkSync(lockPath); } catch { /* already gone or not owned */ }
}

function releaseConfigLock(lockPath: string, nonce: string): void {
  try {
    const current = JSON.parse(readFileSync(lockPath, 'utf8')) as ConfigLockContent;
    if (current.nonce !== nonce) return;
  } catch {
    return;
  }
  try { unlinkSync(lockPath); } catch { /* already gone */ }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withConfigWriteLock<T>(mutate: () => T): T {
  const lockPath = getConfigLockPath();
  const release = acquireConfigLockSync(lockPath);
  try {
    return mutate();
  } finally {
    release();
  }
}

function acquireConfigLockSync(lockPath = getConfigLockPath()): () => void {
  const deadline = Date.now() + CONFIG_LOCK_WAIT_MS;
  for (;;) {
    const release = tryAcquireConfigLock(lockPath);
    if (release) return release;
    if (Date.now() >= deadline) {
      throw new ConfigLockBusyError(lockPath, CONFIG_LOCK_WAIT_MS);
    }
    sleepSync(CONFIG_LOCK_RETRY_MS);
  }
}

async function acquireServerPasswordLock(): Promise<() => void> {
  const lockPath = getServerPasswordLockPath();
  const deadline = Date.now() + CONFIG_LOCK_WAIT_MS;
  for (;;) {
    const release = tryAcquireConfigLock(lockPath);
    if (release) return release;
    if (Date.now() >= deadline) {
      throw new ConfigLockBusyError(lockPath, CONFIG_LOCK_WAIT_MS);
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, CONFIG_LOCK_RETRY_MS);
      timer.unref?.();
    });
  }
}

/**
 * Raised when config.json exists but cannot be read or parsed. Treated as a
 * hard failure on the WRITE path so a corrupt read never silently becomes {}
 * and wipes saved preferences on the next save. Read-only callers
 * (loadPreferences) downgrade this to a warning plus defaults.
 */
export class CorruptConfigError extends Error {
  readonly configPath: string;
  constructor(configPath: string, options?: { cause?: unknown }) {
    super(
      `Config file at ${configPath} exists but is unreadable or not valid JSON. `
        + 'Inspect or restore it (a `.bak` sibling may exist), then re-run. '
        + 'Removing the file resets preferences to defaults.',
      options,
    );
    this.name = 'CorruptConfigError';
    this.configPath = configPath;
  }
}

/**
 * Read and parse config.json. Returns {} when the file is missing (fresh
 * install). Throws CorruptConfigError when the file exists but cannot be read
 * or parsed. Callers on the write path MUST let this propagate so a corrupt
 * read never silently wipes saved preferences.
 */
function readConfig(): UserPreferences {
  ensureLegacyAppHomeMigrated();
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new CorruptConfigError(configPath, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CorruptConfigError(configPath, { cause: err });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CorruptConfigError(configPath);
  }
  return parsed as UserPreferences;
}

/**
 * Atomic config write: temp file in the same directory (so rename is atomic on
 * the same filesystem), then rename over the target. Mode 0600 is enforced on
 * both the temp and the final path so a crash mid-write never leaves a
 * world-readable or torn config.json.
 */
function writeConfig(config: UserPreferences): void {
  const configPath = getConfigPath();
  mkdirSync(dirname(configPath), { recursive: true, mode: CONFIG_DIR_MODE });
  const tmpPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: CONFIG_FILE_MODE,
    });
    try { chmodSync(tmpPath, CONFIG_FILE_MODE); } catch { /* best-effort on restrictive filesystems */ }
    renameSync(tmpPath, configPath);
    try { chmodSync(configPath, CONFIG_FILE_MODE); } catch { /* best-effort on restrictive filesystems */ }
  } finally {
    try { rmSync(tmpPath, { force: true }); } catch { /* ensure temp never lingers */ }
  }
}

export function loadPreferences(): UserPreferences {
  let config: UserPreferences;
  try {
    config = readConfig();
  } catch (err) {
    if (err instanceof CorruptConfigError) {
      console.warn(`leverframe: ${err.message}`);
      return {};
    }
    throw err;
  }
  return {
    lastModel: config.lastModel,
    lastProvider: config.lastProvider,
    recentModelsByProvider: config.recentModelsByProvider,
    favoriteModels: config.favoriteModels,
    modelAliases: config.modelAliases,
    claudeBridgeMode: config.claudeBridgeMode,
    serverBridgeMode: config.serverBridgeMode,
    appPathOverrides: config.appPathOverrides,
    recentLaunchFolders: config.recentLaunchFolders,
    server: config.server,
  };
}

export function savePreferences(prefs: Partial<Pick<UserPreferences, 'lastModel' | 'lastProvider' | 'recentModelsByProvider' | 'favoriteModels' | 'modelAliases' | 'claudeBridgeMode' | 'serverBridgeMode' | 'appPathOverrides' | 'recentLaunchFolders'>>): void {
  withConfigWriteLock(() => {
    const config = readConfig();
    if (prefs.lastModel !== undefined) config.lastModel = prefs.lastModel;
    if (prefs.lastProvider !== undefined) config.lastProvider = prefs.lastProvider;
    if (prefs.recentModelsByProvider !== undefined) config.recentModelsByProvider = prefs.recentModelsByProvider;
    if (prefs.favoriteModels !== undefined) config.favoriteModels = prefs.favoriteModels;
    if (prefs.modelAliases !== undefined) config.modelAliases = prefs.modelAliases;
    if (prefs.claudeBridgeMode !== undefined) config.claudeBridgeMode = prefs.claudeBridgeMode;
    if (prefs.serverBridgeMode !== undefined) config.serverBridgeMode = prefs.serverBridgeMode;
    if (prefs.appPathOverrides !== undefined) config.appPathOverrides = prefs.appPathOverrides;
    if (prefs.recentLaunchFolders !== undefined) config.recentLaunchFolders = prefs.recentLaunchFolders;
    writeConfig(config);
  });
}

export function getAppPathOverride(appId: string): string | undefined {
  const value = loadPreferences().appPathOverrides?.[appId];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function setAppPathOverride(appId: string, path: string | null): Record<string, string> {
  return withConfigWriteLock(() => {
    const config = readConfig();
    const next = { ...(config.appPathOverrides ?? {}) };
    const trimmed = path?.trim() ?? '';
    if (trimmed) next[appId] = trimmed;
    else delete next[appId];
    config.appPathOverrides = next;
    if (Object.keys(next).length === 0) delete config.appPathOverrides;
    writeConfig(config);
    return next;
  });
}

/**
 * Resolve the bridge mode for a command. An explicit flag applies to that run
 * only; it is persisted as the command's default ONLY when the caller opts in
 * (--save-mode). With no flag, the saved per-command default applies; with no
 * saved default, proxy.
 */
export function resolveBridgeMode(
  command: 'claude' | 'server',
  explicit: import('./types.js').BridgeMode | undefined,
  opts: { persist?: boolean } = {},
): import('./types.js').BridgeMode {
  const key = command === 'claude' ? 'claudeBridgeMode' : 'serverBridgeMode';
  if (explicit) {
    if (opts.persist === true) savePreferences({ [key]: explicit });
    return explicit;
  }
  return loadPreferences()[key] ?? 'proxy';
}

const MAX_RECENT_MODELS = 3;
const MAX_RECENT_LAUNCH_FOLDERS = 6;

export function recordLaunchFolder(folder: string): string[] {
  const trimmed = folder.trim();
  if (!trimmed) return loadPreferences().recentLaunchFolders ?? [];
  return withConfigWriteLock(() => {
    const config = readConfig();
    const prev = config.recentLaunchFolders ?? [];
    const next = [trimmed, ...prev.filter(path => path !== trimmed)].slice(0, MAX_RECENT_LAUNCH_FOLDERS);
    config.recentLaunchFolders = next;
    writeConfig(config);
    return next;
  });
}

export function recordLaunchSelection(
  _agent: 'claude',
  providerId: string,
  modelId: string,
  prefs: UserPreferences,
): void {
  const prevRecent = prefs.recentModelsByProvider?.[providerId] ?? [];
  const updatedRecent = [modelId, ...prevRecent.filter(id => id !== modelId)].slice(0, MAX_RECENT_MODELS);
  savePreferences({
    lastProvider: providerId,
    lastModel: modelId,
    recentModelsByProvider: { ...prefs.recentModelsByProvider, [providerId]: updatedRecent },
  });
}

const SERVER_PASSWORD_SERVICE = 'leverframe-server-password';
const SERVER_PASSWORD_ACCOUNT = 'server-password';

/**
 * Read, migrate, set, and clear all serialize under a dedicated cross-process
 * lock so the full keyring+config transition runs atomically per call. This
 * prevents the three races the T7 audit flagged:
 *
 *  - get-vs-clear: a clear that races a get no longer resurrects an old
 *    password, because the get re-reads config under the lock before
 *    returning and the clear holds the lock through the keyring delete.
 *  - get-vs-set: a migration that races a set can no longer overwrite the
 *    new password, because the migration revalidates the config value
 *    before deleting it.
 *  - set-vs-clear: the keyring write and the config fallback are observed
 *    in the same order by every observer.
 *
 * The lock is the SAME robust primitive as the sync config lock (nonce
 * ownership, O_NOFOLLOW, live pid never evicted for age, ConfigLockBusyError
 * on bounded timeout) but acquired through async polling so the event loop
 * is not blocked while a sibling keyring call finishes. The bounded wait
 * comfortably exceeds the 3s isolated keyring deadline so a server startup
 * that races a concurrent migration does not trip a busy failure.
 *
 * The inner config write still takes the config lock briefly. The lock
 * order is always password-lock-then-config-lock, never the reverse, so no
 * nested-lock deadlock is possible.
 */
export type ServerPasswordLookup =
  | { status: 'ok'; password: string }
  | { status: 'absent' }
  | { status: 'migration-failed'; plaintextPresent: boolean; error: string };

export async function getSavedServerPassword(): Promise<ServerPasswordLookup> {
  const release = await acquireServerPasswordLock();
  try {
    const peeked = loadPreferences();
    const pwd = peeked.server?.savedPassword;
    if (pwd) {
      const migrated = await runIsolatedKeyringOperation({
        operation: 'write',
        service: SERVER_PASSWORD_SERVICE,
        account: SERVER_PASSWORD_ACCOUNT,
        value: pwd,
      });
      if (migrated.ok) {
        try {
          withConfigWriteLock(() => {
            const config = readConfig();
            if (config.server?.savedPassword !== pwd) return;
            delete config.server.savedPassword;
            if (Object.keys(config.server).length === 0) delete config.server;
            writeConfig(config);
          });
        } catch {
          // corrupt config: leave the in-memory password usable, skip migration cleanup
        }
        return { status: 'ok', password: pwd };
      }
      return {
        status: 'migration-failed',
        plaintextPresent: true,
        error: classifyKeyringError(migrated.error),
      };
    }

    const result = await runIsolatedKeyringOperation({
      operation: 'read',
      service: SERVER_PASSWORD_SERVICE,
      account: SERVER_PASSWORD_ACCOUNT,
    });
    if (result.ok) {
      return result.value === null
        ? { status: 'absent' }
        : { status: 'ok', password: result.value };
    }
    return {
      status: 'migration-failed',
      plaintextPresent: false,
      error: classifyKeyringError(result.error),
    };
  } finally {
    release();
  }
}

export async function setSavedServerPassword(password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const release = await acquireServerPasswordLock();
  try {
    const result = await runIsolatedKeyringOperation({
      operation: 'write',
      service: SERVER_PASSWORD_SERVICE,
      account: SERVER_PASSWORD_ACCOUNT,
      value: password,
    });
    if (result.ok) {
      withConfigWriteLock(() => {
        const config = readConfig();
        if (!config.server?.savedPassword) return;
        delete config.server.savedPassword;
        if (Object.keys(config.server).length === 0) delete config.server;
        writeConfig(config);
      });
      return { ok: true };
    }
    return { ok: false, error: classifyKeyringError(result.error) };
  } finally {
    release();
  }
}

export async function clearSavedServerPassword(): Promise<void> {
  const release = await acquireServerPasswordLock();
  try {
    await runIsolatedKeyringOperation({
      operation: 'delete',
      service: SERVER_PASSWORD_SERVICE,
      account: SERVER_PASSWORD_ACCOUNT,
    });
    withConfigWriteLock(() => {
      const config = readConfig();
      if (!config.server) return;
      delete config.server.savedPassword;
      if (Object.keys(config.server).length === 0) delete config.server;
      writeConfig(config);
    });
  } finally {
    release();
  }
}

export function getServerExposedProviders(): string[] | null {
  const list = loadPreferences().server?.exposedProviders;
  return list && list.length > 0 ? list : null;
}

export function setServerExposedProviders(providerIds: string[]): void {
  withConfigWriteLock(() => {
    const config = readConfig();
    config.server = {
      ...(config.server ?? {}),
      exposedProviders: providerIds,
    };
    writeConfig(config);
  });
}

export function getServerMaskGatewayIds(): boolean {
  return loadPreferences().server?.maskGatewayIds ?? true;
}

export function setServerMaskGatewayIds(mask: boolean): void {
  withConfigWriteLock(() => {
    const config = readConfig();
    config.server = {
      ...(config.server ?? {}),
      maskGatewayIds: mask,
    };
    writeConfig(config);
  });
}

export function getServerFavoritesOnly(): boolean {
  return loadPreferences().server?.favoritesOnly ?? false;
}

export function setServerFavoritesOnly(favoritesOnly: boolean): void {
  withConfigWriteLock(() => {
    const config = readConfig();
    config.server = {
      ...(config.server ?? {}),
      favoritesOnly,
    };
    writeConfig(config);
  });
}

export function getServerListenMode(): 'local' | 'network' {
  return loadPreferences().server?.listenMode === 'network' ? 'network' : 'local';
}

export function setServerListenMode(listenMode: 'local' | 'network'): void {
  withConfigWriteLock(() => {
    const config = readConfig();
    config.server = {
      ...(config.server ?? {}),
      listenMode,
    };
    writeConfig(config);
  });
}
