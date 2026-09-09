import { homedir } from 'node:os';
import { join } from 'node:path';
import { cpSync, existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export const APP_DIR_NAME = 'leverframe';

export const LEGACY_APP_DIR_NAME = 'clodex';

export const OLDER_LEGACY_APP_DIR_NAME = 'relay-ai';

interface HomeEnv {
  HOME?: string;
  LEVERFRAME_HOME?: string;
  USERPROFILE?: string;
}

function userHome(env: HomeEnv = process.env): string {
  return env.HOME ?? env.USERPROFILE ?? homedir();
}

export function resolveAppHomeOverride(env: HomeEnv = process.env): string | undefined {
  const override = env.LEVERFRAME_HOME;
  return override?.trim() || undefined;
}

export function getAppHome(env: HomeEnv = process.env): string {
  const override = resolveAppHomeOverride(env);
  if (override) return override;
  return join(userHome(env), `.${APP_DIR_NAME}`);
}

export function getDefaultAppHome(env: HomeEnv = process.env): string {
  return join(userHome(env), `.${APP_DIR_NAME}`);
}

export function getLegacyAppHome(env: HomeEnv = process.env): string {
  return join(userHome(env), `.${LEGACY_APP_DIR_NAME}`);
}

export function getOlderLegacyAppHome(env: HomeEnv = process.env): string {
  return join(userHome(env), `.${OLDER_LEGACY_APP_DIR_NAME}`);
}

let legacyMigrationDone = false;

export function ensureLegacyAppHomeMigrated(env: HomeEnv = process.env): void {
  if (legacyMigrationDone || resolveAppHomeOverride(env)) return;
  const appHome = getAppHome(env);
  const pendingMerge = join(appHome, '.legacy-migration-pending');
  if (existsSync(appHome) && !existsSync(pendingMerge)) {
    legacyMigrationDone = true;
    return;
  }
  const legacyHome = [getLegacyAppHome(env), getOlderLegacyAppHome(env)].find(path => existsSync(path));
  if (!legacyHome) return;

  const stagingHome = mkdtempSync(`${appHome}.migration-`);
  try {
    for (const entry of readdirSync(legacyHome)) {
      if (entry === 'logs') continue;
      cpSync(join(legacyHome, entry), join(stagingHome, entry), { recursive: true });
    }
    try {
      renameSync(stagingHome, appHome);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EEXIST' && code !== 'ENOTEMPTY') || !existsSync(appHome)) throw error;
      writeFileSync(pendingMerge, '', { mode: 0o600 });
      for (const entry of readdirSync(stagingHome)) {
        cpSync(join(stagingHome, entry), join(appHome, entry), { recursive: true, force: false });
      }
      rmSync(pendingMerge, { force: true });
    }
    legacyMigrationDone = true;
  } finally {
    rmSync(stagingHome, { recursive: true, force: true });
  }
}

export function resetLegacyMigrationForTests(): void {
  legacyMigrationDone = false;
}

export function getConfigPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'config.json');
}

export function getProvidersPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'providers.json');
}

export function getCredentialCleanupPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'credential-cleanup.json');
}

export function getLogsPath(env: HomeEnv = process.env): string {
  return join(getAppHome(env), 'logs');
}
