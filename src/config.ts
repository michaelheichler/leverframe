import type { UserPreferences } from './types.js';
import { existsSync, readFileSync } from 'node:fs';
import { ensureLegacyAppHomeMigrated, getConfigPath } from './paths.js';
import { classifyKeyringError, runIsolatedKeyringOperation } from './credential-store.js';
import { durableAtomicWrite } from './durable-io.js';
import { CONFIG_DIR_MODE, acquireServerPasswordLock, withConfigWriteLock } from './config-lock.js';
import { normalizeModelAliases } from './model-aliases.js';

export { ConfigLockBusyError, _configLockInternals } from './config-lock.js';

const CONFIG_FILE_MODE = 0o600;

/**
 * Defensively parse the `launch` config section: unknown/non-boolean values
 * are ignored rather than propagated, so a hand-edited config.json can never
 * crash preference loading.
 */
function validateLaunchConfig(raw: unknown): UserPreferences['launch'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const candidate = raw as { bypassPermissions?: unknown };
  if (typeof candidate.bypassPermissions !== 'boolean') return undefined;
  return { bypassPermissions: candidate.bypassPermissions };
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
  durableAtomicWrite(
    getConfigPath(),
    `${JSON.stringify(config, null, 2)}\n`,
    { mode: CONFIG_FILE_MODE, directoryMode: CONFIG_DIR_MODE },
  );
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
  const modelAliases = config.modelAliases === undefined
    ? undefined
    : normalizeModelAliases(config.modelAliases);
  return {
    lastModel: config.lastModel,
    lastProvider: config.lastProvider,
    recentModelsByProvider: config.recentModelsByProvider,
    favoriteModels: config.favoriteModels,
    modelAliases,
    claudeBridgeMode: config.claudeBridgeMode,
    serverBridgeMode: config.serverBridgeMode,
    appPathOverrides: config.appPathOverrides,
    recentLaunchFolders: config.recentLaunchFolders,
    launch: validateLaunchConfig(config.launch),
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
    const modelAliases = prefs.modelAliases ?? config.modelAliases;
    if (modelAliases !== undefined) config.modelAliases = normalizeModelAliases(modelAliases);
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
    const next = { ...config.appPathOverrides };
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
      ...config.server,
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
      ...config.server,
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
      ...config.server,
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
      ...config.server,
      listenMode,
    };
    writeConfig(config);
  });
}
