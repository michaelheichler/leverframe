import * as p from '@clack/prompts';
import { accountTag, normalizeAccountTag, validateAccountName } from './account-identity.js';
import { addNamedProviderConfiguration, addProviderAccount, renameProviderAccount, type AccountIdentity } from './account-management.js';
import { authenticateProvider } from './registry/provider-auth.js';
import { refreshProviderModels } from './registry/refresh-models.js';
import type { RegistryAccount, RegistryProvider } from './registry/types.js';

export async function promptAccountIdentity(provider: RegistryProvider, account?: RegistryAccount): Promise<AccountIdentity | undefined> {
  const name = await p.text({ message: 'Account name:', initialValue: account?.name ?? account?.id,
    placeholder: `Account ${(provider.accounts?.length ?? 0) + 1}`,
    validate: value => { try { if (value.trim()) validateAccountName(value); } catch (error) { return (error as Error).message; } },
  });
  if (p.isCancel(name)) return undefined;
  const tag = await p.text({ message: 'Account tag (3 to 4 letters or digits, Enter for automatic):',
    initialValue: account ? accountTag(account, provider.accounts ?? [account]) : undefined,
    validate: value => {
      if (!value.trim()) return;
      try {
        const chosen = normalizeAccountTag(value);
        if (provider.accounts?.some(item => item.id !== account?.id && accountTag(item, provider.accounts!) === chosen)) return 'That tag already belongs to another account.';
      } catch (error) { return (error as Error).message; }
    },
  });
  if (p.isCancel(tag)) return undefined;
  return { name: String(name ?? '').trim() || account?.name || `Account ${(provider.accounts?.length ?? 0) + 1}`,
    tag: String(tag ?? '').trim() || undefined };
}

export async function setupProviderAccount(provider: RegistryProvider): Promise<void> {
  const identity = await promptAccountIdentity(provider);
  if (!identity) return;
  if (provider.authType === 'oauth') {
    await authenticateProvider(provider.id, { accountIdentity: identity });
  } else if (provider.authType === 'none') {
    addNamedProviderConfiguration(provider.id, identity);
  } else {
    const key = await p.password({ message: `${provider.name} API key:`, validate: value => value.trim() ? undefined : 'Key cannot be empty.' });
    if (p.isCancel(key)) return;
    await addProviderAccount(provider.id, key, undefined, identity);
  }
  const result = await refreshProviderModels(provider.id, null);
  if (result.ok) p.log.success(`Added account for ${provider.name}.`);
  else p.log.warn(result.reason ?? 'Account saved. Model discovery needs another refresh.');
}

export async function renameAccount(provider: RegistryProvider, account: RegistryAccount): Promise<void> {
  const identity = await promptAccountIdentity(provider, account);
  if (identity && !renameProviderAccount(provider.id, account.id, identity)) p.log.warn('The account or tag changed. Select the account again.');
}
