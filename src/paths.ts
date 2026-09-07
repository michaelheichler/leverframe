import { homedir } from 'node:os';
import { join } from 'node:path';
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';

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
  if (legacyMigrationDone) return;
  legacyMigrationDone = true;
  if (resolveAppHomeOverride(env)) return;
  try {
    const appHome = getAppHome(env);
    if (existsSync(appHome)) return;
    const legacyHome = [getLegacyAppHome(env), getOlderLegacyAppHome(env)].find(path => existsSync(path));
    if (!legacyHome) return;

    mkdirSync(appHome, { recursive: true, mode: 0o700 });
    const entries = readdirSync(legacyHome);

    for (const entry of entries) {
      if (entry === 'logs') continue; // session logs are not config/auth state
      cpSync(join(legacyHome, entry), join(appHome, entry), { recursive: true });
    }
  } catch {

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
