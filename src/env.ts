// src/env.ts
import { CONFLICTING_ENV_VARS } from './constants.js';
import { claudeCodeClientModelId, stripOneMContextSuffix } from './context-model-id.js';
import { resolveContextWindow } from './context-window.js';
import {
  oauthCredentialToKeychainJson,
  parseStoredOAuthCredential,
} from './oauth/types.js';
import { refreshStoredOAuthCredential, oauthCredentialShouldRefresh } from './oauth/refresh.js';
import type { ConflictInfo } from './types.js';
import {
  deleteStoredCredential,
  readStoredCredential,
  writeStoredCredential,
} from './credential-store.js';

export { classifyKeyringError } from './credential-store.js';

const HTTP_PROXY_AUTH_USER = 'leverframe';

export function detectConflicts(): ConflictInfo[] {
  return CONFLICTING_ENV_VARS
    .filter(name => process.env[name] !== undefined)
    .map(name => ({ name, value: process.env[name]! }));
}

/** Restore first-party-like Claude Code behavior when routing through a proxy or gateway. */
export function applyClaudeCodeThirdPartyCompat(env: NodeJS.ProcessEnv): void {
  // Custom ANTHROPIC_BASE_URL disables MCP tool search by default, loading every
  // MCP tool (100+) on every turn. Requires defer_loading on tools — do not set
  // CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS when using the local translation proxy.
  env['ENABLE_TOOL_SEARCH'] = 'true';
  // Third-party routes may enable a shorter system prompt that drops conversational
  // guardrails while hooks/plugins still inject agentic instructions.
  env['CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT'] = '0';
}

export function buildChildEnv(
  baseUrl: string,
  model: string,
  apiKey: string,
  proxyPort?: number,
  contextWindow?: number,
  enableGatewayDiscovery?: boolean,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of CONFLICTING_ENV_VARS) {
    delete env[name];
  }
  env['ANTHROPIC_BASE_URL'] = proxyPort
    ? `http://127.0.0.1:${proxyPort}`
    : baseUrl;
  env['ANTHROPIC_API_KEY'] = apiKey;
  const bareModel = stripOneMContextSuffix(model);
  env['ANTHROPIC_MODEL'] = claudeCodeClientModelId(model, contextWindow);
  // Claude Code defaults to 200K for non-api.anthropic.com base URLs; override with
  // the launch model's real window. NOTE: in switch-menu mode this is fixed at launch
  // and does NOT update on live /model switch — Claude Code's gateway model discovery
  // only carries id + display_name (no context_window), so this env var is the only
  // lever and it reflects the model you started with.
  // Third-party routes also require a `[1m]` model-id suffix for 1M+ windows in the UI.
  env['CLAUDE_CODE_MAX_CONTEXT_TOKENS'] = String(resolveContextWindow(bareModel, contextWindow));
  if (enableGatewayDiscovery) {
    env['CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'] = '1';
  }
  applyClaudeCodeThirdPartyCompat(env);
  return env;
}

/**
 * Normalize env vars for Anthropic MITM/proxy mode: drop conflicting Vertex,
 * Bedrock, Foundry, and stale Anthropic base URLs (preserving the child's own
 * ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL) and strip
 * NO_PROXY entries that would bypass api.anthropic.com. Shared by
 * buildHttpProxyChildEnv and computeWrapperEnv so the two paths share one policy.
 */
export function applyAnthropicProxyEnvNormalization(env: NodeJS.ProcessEnv): void {
  for (const name of CONFLICTING_ENV_VARS) {
    if (name === 'ANTHROPIC_API_KEY' || name === 'ANTHROPIC_AUTH_TOKEN' || name === 'ANTHROPIC_MODEL') continue;
    delete env[name];
  }
  const noProxy = env['NO_PROXY'] ?? env['no_proxy'];
  if (noProxy !== undefined) {
    const filtered = noProxy
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
      .filter(value => {
        const entry = value.toLowerCase().replace(/^https?:\/\//, '');
        const host = entry.replace(/:\d+$/, '');
        if (host === '*') return false;
        const suffix = host.startsWith('*.') ? host.slice(1) : host;
        const bypassesAnthropic = suffix.startsWith('.')
          ? 'api.anthropic.com'.endsWith(suffix)
          : 'api.anthropic.com' === suffix || 'api.anthropic.com'.endsWith(`.${suffix}`);
        return !bypassesAnthropic;
      })
      .join(',');
    if (filtered) {
      env['NO_PROXY'] = filtered;
      env['no_proxy'] = filtered;
    } else {
      delete env['NO_PROXY'];
      delete env['no_proxy'];
    }
  }
}

export function buildHttpProxyChildEnv(
  proxyPort: number,
  caCertPath: string,
  proxyToken?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  applyAnthropicProxyEnvNormalization(env);
  const proxyUrl = proxyToken
    ? `http://${HTTP_PROXY_AUTH_USER}:${encodeURIComponent(proxyToken)}@127.0.0.1:${proxyPort}`
    : `http://127.0.0.1:${proxyPort}`;
  env['HTTPS_PROXY'] = proxyUrl;
  env['HTTP_PROXY'] = proxyUrl;
  env['https_proxy'] = proxyUrl;
  env['http_proxy'] = proxyUrl;
  env['NODE_EXTRA_CA_CERTS'] = caCertPath;
  return env;
}

export function providerKeyringAccount(providerId: string): string {
  return `provider:${providerId}`;
}

export function oauthProviderKeyringAccount(providerId: string): string {
  return `oauth:provider:${providerId}`;
}

function oauthProviderIdFromAccount(account: string): string | null {
  const prefix = 'oauth:provider:';
  return account.startsWith(prefix) ? account.slice(prefix.length) : null;
}

const oauthRefreshInflight = new Map<string, Promise<string | null>>();

export type ParsedAuthRef =
  | { kind: 'keyring'; account: string }
  | { kind: 'env'; varName: string };

/** Parse registry authRef strings like `keyring:provider:openai` or `env:OPENAI_API_KEY`. */
export function parseAuthRef(authRef: string): ParsedAuthRef | null {
  if (authRef.startsWith('keyring:')) {
    const account = authRef.slice('keyring:'.length);
    return account ? { kind: 'keyring', account } : null;
  }
  if (authRef.startsWith('env:')) {
    const varName = authRef.slice('env:'.length);
    return varName ? { kind: 'env', varName } : null;
  }
  return null;
}

/** Env var name for leverframe namespaced per-provider keys. */
export function leverframeKeyEnvVar(providerId: string): string {
  return `LEVERFRAME_KEY_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function readEnvCredential(varName: string): string | null {
  const raw = process.env[varName];
  if (!raw?.trim()) return null;
  return raw.trim().split(/\r?\n/)[0]?.trim() || null;
}

async function readKeyringAccount(account: string, diag?: (msg: string) => void): Promise<string | null> {
  return readStoredCredential(account, diag);
}

async function writeKeyringAccount(
  account: string,
  key: string,
  diag?: (msg: string) => void,
): Promise<boolean> {
  return writeStoredCredential(account, key, diag);
}

async function deleteKeyringAccount(account: string, diag?: (msg: string) => void): Promise<boolean> {
  return deleteStoredCredential(account, diag);
}

/** Resolve a provider secret from authRef (env → keyring). */
export async function resolveProviderCredential(
  providerId: string,
  authRef: string,
  diag?: (msg: string) => void,
): Promise<string | null> {
  const namespaced = readEnvCredential(leverframeKeyEnvVar(providerId));
  if (namespaced) return namespaced;

  const parsed = parseAuthRef(authRef);
  if (!parsed) return null;

  if (parsed.kind === 'env') {
    return readEnvCredential(parsed.varName);
  }

  return readProviderSecret(parsed.account, diag);
}

/** Read OAuth metadata retained alongside the access token. */
export async function resolveProviderOAuthAccountId(
  authRef: string,
  diag?: (msg: string) => void,
): Promise<string | undefined> {
  const parsed = parseAuthRef(authRef);
  if (!parsed || parsed.kind !== 'keyring' || !oauthProviderIdFromAccount(parsed.account)) return undefined;
  const raw = await readKeyringAccount(parsed.account, diag);
  return parseStoredOAuthCredential(raw)?.accountId;
}

export async function resolveProviderOAuthProviderData(
  authRef: string,
  diag?: (msg: string) => void,
): Promise<Record<string, unknown> | undefined> {
  const parsed = parseAuthRef(authRef);
  if (!parsed || parsed.kind !== 'keyring' || !oauthProviderIdFromAccount(parsed.account)) return undefined;
  const raw = await readKeyringAccount(parsed.account, diag);
  return parseStoredOAuthCredential(raw)?.providerData;
}

function decodeProviderSecret(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  const oauth = parseStoredOAuthCredential(trimmed);
  if (oauth) return oauth.access;
  try {
    const parsed = JSON.parse(trimmed) as { type?: string; access?: string; token?: string };
    if (parsed.type === 'oauth' && typeof parsed.access === 'string') return parsed.access;
    if (parsed.type === 'wellknown' && typeof parsed.token === 'string') return parsed.token;
  } catch {
    // fall through
  }
  return trimmed;
}

async function refreshOAuthKeyringAccount(
  account: string,
  providerId: string,
  raw: string,
  diag?: (msg: string) => void,
): Promise<string | null> {
  const existing = oauthRefreshInflight.get(account);
  if (existing) return existing;

  const work = (async (): Promise<string | null> => {
    const cred = parseStoredOAuthCredential(raw);
    if (!cred || !oauthCredentialShouldRefresh(cred, providerId)) {
      return decodeProviderSecret(raw);
    }
    try {
      const refreshed = await refreshStoredOAuthCredential(providerId, cred);
      const json = oauthCredentialToKeychainJson(refreshed);
      await writeKeyringAccount(account, json, diag);
      return refreshed.access;
    } catch (err) {
      diag?.(err instanceof Error ? err.message : String(err));
      if (cred.access && cred.expires > Date.now()) return cred.access;
      throw err;
    }
  })();

  oauthRefreshInflight.set(account, work);
  try {
    return await work;
  } finally {
    oauthRefreshInflight.delete(account);
  }
}

async function readProviderSecret(account: string, diag?: (msg: string) => void): Promise<string | null> {
  const raw = await readKeyringAccount(account, diag);
  if (!raw) return null;

  const oauthProviderId = oauthProviderIdFromAccount(account);
  if (oauthProviderId && raw.trim().startsWith('{')) {
    return refreshOAuthKeyringAccount(account, oauthProviderId, raw, diag);
  }
  return decodeProviderSecret(raw);
}

export async function saveProviderCredential(
  authRef: string,
  key: string,
  diag?: (msg: string) => void,
): Promise<boolean> {
  const parsed = parseAuthRef(authRef);
  if (!parsed || parsed.kind !== 'keyring') return false;
  return writeKeyringAccount(parsed.account, key, diag);
}

/** Delete a provider secret from keyring (no-op for env: refs). */
export async function deleteProviderCredential(
  authRef: string,
  diag?: (msg: string) => void,
): Promise<boolean> {
  const parsed = parseAuthRef(authRef);
  if (!parsed || parsed.kind !== 'keyring') return false;
  return deleteKeyringAccount(parsed.account, diag);
}
