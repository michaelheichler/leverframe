import * as p from '@clack/prompts';
import { loadPreferences, savePreferences } from './config.js';
import { addProviderAccount, formatProviderAccounts, importProviderAccount, pinProviderAccount } from './account-management.js';
import { removeProviderAccount } from './registry/credential-lifecycle.js';
import { loadRegistry } from './registry/io.js';
import { runProvidersAuth } from './providers-command-auth.js';
import { readLatestPoolActivity } from './account-pool-activity.js';

async function manageExistingAccount(providerId: string, choice: 'pin' | 'remove', accounts: import('./registry/types.js').RegistryAccount[]): Promise<void> {
  const eligible = choice === 'pin' ? accounts.filter(account => account.enabled) : accounts;
  if (eligible.length === 0) {
    p.log.warn('No eligible accounts found.');
    return;
  }
  const account = await p.select({ message: 'Select account', options: eligible.map(item => ({ value: item.id, label: item.id })) });
  if (p.isCancel(account)) return;
  if (choice === 'pin') {
    if (!pinProviderAccount(providerId, account)) p.log.warn(`Could not pin account ${account}.`);
    return;
  }
  const confirmed = await p.confirm({ message: `Remove account ${account}?`, initialValue: false });
  if (p.isCancel(confirmed) || !confirmed) return;
  const result = await removeProviderAccount(providerId, account);
  if (result.removed) p.log.success(`Removed account ${account}.`);
  else p.log.warn(`Could not remove account ${account}.`);
  if (result.credentialDeleted) p.log.info('Account credential removed from storage.');
  if (result.error) p.log.warn(result.error);
}

export async function runAccountManagement(providerId: string): Promise<void> {
  while (true) {
    const provider = loadRegistry().providers.find(item => item.id === providerId);
    if (!provider) return;
    for (const line of formatProviderAccounts(provider, readLatestPoolActivity(providerId))) p.log.info(line);
    const choice = await p.select({
      message: 'Manage accounts',
      options: [
        { value: 'add', label: providerId === 'openai-oauth' ? 'Sign in to another ChatGPT account' : 'Add API key' },
        { value: 'import', label: providerId === 'openai-oauth' ? 'Import from ~/.codex/auth.json' : 'Import ANTHROPIC_API_KEY' },
        { value: 'pin', label: 'Pin account' },
        { value: 'remove', label: 'Remove account' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (p.isCancel(choice) || choice === 'back') return;
    try {
      if (choice === 'add' && providerId === 'openai-oauth') {
        await runProvidersAuth(providerId);
      } else if (choice === 'add') {
        const key = await p.password({ message: 'Anthropic API key:' });
        if (!p.isCancel(key) && key) {
          const id = await p.text({ message: 'Account name (optional):' });
          if (!p.isCancel(id)) await addProviderAccount(providerId, key, id);
        }
      } else if (choice === 'import') {
        const confirmed = await p.confirm({ message: providerId === 'openai-oauth'
          ? 'Import credentials from ~/.codex/auth.json?' : 'Import ANTHROPIC_API_KEY?', initialValue: false });
        if (!p.isCancel(confirmed) && confirmed) {
          const id = await p.text({ message: 'Account name (optional):' });
          if (!p.isCancel(id)) await importProviderAccount(providerId, providerId === 'openai-oauth' ? 'codex' : 'anthropic-env', id);
        }
      } else if (choice === 'pin' || choice === 'remove') {
        await manageExistingAccount(providerId, choice, provider.accounts ?? []);
      }
    } catch (error) {
      p.log.error(error instanceof Error ? error.message : String(error));
    }
  }
}

export async function runAccountPoolSettings(): Promise<void> {
  while (true) {
    const prefs = loadPreferences();
    const choice = await p.select({
      message: 'Account pool settings',
      options: [
        { value: 'balancing', label: `Account balancing: ${prefs.accountPoolBalancing ? 'on' : 'off'}` },
        { value: 'failover', label: `Quota failover: ${prefs.accountPoolFailover ? 'on' : 'off'}` },
        { value: 'back', label: 'Back' },
      ],
    });
    if (p.isCancel(choice) || choice === 'back') return;
    if (choice === 'balancing') savePreferences({ accountPoolBalancing: !prefs.accountPoolBalancing });
    if (choice === 'failover') savePreferences({ accountPoolFailover: !prefs.accountPoolFailover });
  }
}
