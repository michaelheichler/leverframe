import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { saveProviderCredential } from './env.js';
import { cancelCredentialDelete, journalCredentialWrite, reconcilePendingCredentialDeletes } from './registry/credential-lifecycle.js';
import { loadRegistry, updateRegistry } from './registry/io.js';
import { withCredentialMutationLock } from './registry/lock.js';
import { isValidProviderId } from './registry/validate.js';
import type { RegistryAccount, RegistryProvider } from './registry/types.js';

async function storeAccount(providerId: string, credential: string, id?: string): Promise<RegistryAccount> {
  const accountId = id?.trim() || randomUUID();
  if (!isValidProviderId(accountId)) throw new Error('Invalid account ID.');
  const provider = loadRegistry().providers.find(item => item.id === providerId);
  if (!provider) throw new Error(`Provider not found: ${providerId}`);
  const authRef = `keyring:provider:${providerId}:${randomUUID()}`;
  const account = { id: accountId, authRef, enabled: true };
  try {
    await withCredentialMutationLock(authRef, async () => {
      await journalCredentialWrite(authRef);
      if (!await saveProviderCredential(authRef, credential)) throw new Error('Could not save account credential.');
      updateRegistry(registry => {
        const current = registry.providers.find(item => item.id === providerId);
        if (!current) throw new Error(`Provider not found: ${providerId}`);
        if (current.accounts?.some(item => item.id === accountId)) throw new Error('Account ID already exists.');
        current.accounts = [...(current.accounts ?? []), account];
      });
      await cancelCredentialDelete(authRef);
    });
    return account;
  } finally {
    await reconcilePendingCredentialDeletes();
  }
}

export async function addProviderAccount(providerId: string, credential: string, id?: string): Promise<RegistryAccount> {
  if (providerId !== 'anthropic-api' || !credential.trim() || credential.trim().startsWith('sk-ant-oat')) {
    throw new Error('An Anthropic API key is required.');
  }
  return storeAccount(providerId, credential.trim(), id);
}

function codexCredential(): string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf8'));
  } catch {
    throw new Error('Could not read valid Codex credentials from ~/.codex/auth.json.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Codex credentials.');
  const data = raw as Record<string, unknown>;
  if (!data.tokens || typeof data.tokens !== 'object' || Array.isArray(data.tokens)) throw new Error('Invalid Codex credentials.');
  const tokens = data.tokens as Record<string, unknown>;
  if (typeof tokens.access_token !== 'string' || !tokens.access_token || typeof tokens.refresh_token !== 'string'
    || !tokens.refresh_token || typeof tokens.account_id !== 'string' || !tokens.account_id) throw new Error('Invalid Codex credentials.');
  let expires = Date.parse(typeof data.last_refresh === 'string' ? data.last_refresh : '') + 3_600_000;
  try {
    const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1] ?? '', 'base64url').toString()) as { exp?: unknown };
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) expires = payload.exp * 1000;
  } catch {}
  if (!Number.isFinite(expires)) throw new Error('Codex credentials have no valid expiry.');
  return JSON.stringify({ type: 'oauth', access: tokens.access_token, refresh: tokens.refresh_token, expires, accountId: tokens.account_id });
}

export async function importProviderAccount(providerId: string, source: 'codex' | 'anthropic-env', id?: string): Promise<RegistryAccount> {
  if (source === 'anthropic-env' && providerId === 'anthropic-api') {
    return addProviderAccount(providerId, process.env['ANTHROPIC_API_KEY'] ?? '', id);
  }
  if (source === 'codex' && providerId === 'openai-oauth') return storeAccount(providerId, codexCredential(), id);
  throw new Error('Credential source is not supported for this provider.');
}

export async function addOAuthProviderAccount(providerId: string, credential: string, id?: string): Promise<RegistryAccount> {
  if (providerId !== 'openai-oauth') throw new Error('OAuth account pooling is only supported for ChatGPT.');
  return storeAccount(providerId, credential, id);
}

export function pinProviderAccount(providerId: string, accountId: string): boolean {
  return updateRegistry(registry => {
    const provider = registry.providers.find(item => item.id === providerId);
    if (!provider?.accounts?.some(account => account.id === accountId && account.enabled)) return false;
    provider.pinnedAccountId = accountId;
    return true;
  });
}

export function formatProviderAccounts(provider: RegistryProvider, state?: { activeAccountId?: string; switchReason?: string }): string[] {
  const lines = (provider.accounts ?? []).map(account => {
    const flags = [account.enabled ? 'enabled' : 'disabled'];
    if (provider.pinnedAccountId === account.id) flags.push('pinned');
    if (state?.activeAccountId === account.id) flags.push('active');
    return `${account.id} (${flags.join(', ')})`;
  });
  if (state?.switchReason) lines.push(`Latest switch: ${state.switchReason}`);
  return lines;
}
