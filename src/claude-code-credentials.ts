

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { runIsolatedKeyringOperation } from './keyring-operations.js';

export type ClaudeCodeAuthKind = 'oauth' | 'api_key';

export interface ClaudeCodeAuthMaterial {
  kind: ClaudeCodeAuthKind;
  token: string;
}

export type ClaudeCodeCredentialReader = () => Promise<ClaudeCodeAuthMaterial | null>;

const CREDENTIALS_SERVICE_SUFFIX = '-credentials';

function claudeConfigHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['CLAUDE_CONFIG_DIR']?.trim();
  if (override) return override;
  return join(homedir(), '.claude');
}

export function claudeCodeCredentialsServiceName(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = claudeConfigHomeDir(env);
  const isDefaultDir = !env['CLAUDE_CONFIG_DIR']?.trim();
  const dirHash = isDefaultDir
    ? ''
    : `-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`;
  return `Claude Code${CREDENTIALS_SERVICE_SUFFIX}${dirHash}`;
}

export function claudeCodeApiKeyServiceName(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = claudeConfigHomeDir(env);
  const isDefaultDir = !env['CLAUDE_CONFIG_DIR']?.trim();
  const dirHash = isDefaultDir
    ? ''
    : `-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`;
  return `Claude Code${dirHash}`;
}

function keychainAccount(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['USER']?.trim();
  if (fromEnv) return fromEnv;
  try {
    return userInfo().username;
  } catch {
    return 'claude-code-user';
  }
}

export function parseClaudeSecureStorageJson(raw: string): ClaudeCodeAuthMaterial | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const oauth = (data as { claudeAiOauth?: unknown }).claudeAiOauth;
  if (oauth && typeof oauth === 'object') {
    const accessToken = (oauth as { accessToken?: unknown }).accessToken;
    if (typeof accessToken === 'string' && accessToken.trim()) {
      return { kind: 'oauth', token: accessToken.trim() };
    }
  }
  return null;
}

export function readMacSecurityPassword(
  service: string,
  account: string,
  spawnImpl: typeof spawn = spawn,
): Promise<string | null> {
  return new Promise(resolve => {
    let child;
    try {
      child = spawnImpl('security', [
        'find-generic-password',
        '-a', account,
        '-w',
        '-s', service,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => { chunks.push(chunk); });

    child.stderr?.resume();
    child.on('error', () => resolve(null));
    child.on('close', code => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
      resolve(value || null);
    });
  });
}

async function readKeychainRaw(
  service: string,
  account: string,
): Promise<string | null> {
  if (process.platform === 'darwin') {
    const viaSecurity = await readMacSecurityPassword(service, account);
    if (viaSecurity) return viaSecurity;
  }
  const result = await runIsolatedKeyringOperation({
    operation: 'read',
    service,
    account,
  });
  if (!result.ok) return null;
  const value = result.value?.trim();
  return value || null;
}

function readPlaintextCredentialsFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = join(claudeConfigHomeDir(env), '.credentials.json');
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export async function readClaudeCodeAuthMaterial(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeCodeAuthMaterial | null> {
  const envOauth = env['CLAUDE_CODE_OAUTH_TOKEN']?.trim();
  if (envOauth) return { kind: 'oauth', token: envOauth };

  const account = keychainAccount(env);
  const oauthRaw = await readKeychainRaw(claudeCodeCredentialsServiceName(env), account);
  if (oauthRaw) {
    const parsed = parseClaudeSecureStorageJson(oauthRaw);
    if (parsed) return parsed;
  }

  const fileRaw = readPlaintextCredentialsFile(env);
  if (fileRaw) {
    const parsed = parseClaudeSecureStorageJson(fileRaw);
    if (parsed) return parsed;
  }

  const apiKeyRaw = await readKeychainRaw(claudeCodeApiKeyServiceName(env), account);
  if (apiKeyRaw && !apiKeyRaw.trimStart().startsWith('{')) {
    return { kind: 'api_key', token: apiKeyRaw.trim() };
  }

  return null;
}
