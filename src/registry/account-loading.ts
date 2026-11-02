import { accountTag } from '../account-identity.js';
import { expandAccountModels } from '../account-models.js';
import type { ResolvedProviderAuth } from '../env.js';
import { materializeRegistry, type MaterializeOptions } from './materialize.js';
import type { RegistryAccount, RegistryProvider } from './types.js';
import { accountModelsCache } from './account-cache.js';

export function hasAccountCatalog(provider: RegistryProvider): boolean {
  return (provider.accounts?.length ?? 0) > 1 || !!provider.accounts?.some(account => account.name || account.tag);
}

export async function loadAccountProvider(
  provider: RegistryProvider,
  read: (account: RegistryAccount) => Promise<ResolvedProviderAuth>,
  options?: MaterializeOptions,
) {
  const usable: Array<{ account: RegistryAccount; auth: ResolvedProviderAuth }> = [];
  for (const account of (provider.accounts ?? []).filter(item => item.enabled)) {
    const auth = provider.authType === 'none' && account.authRef === 'none:anonymous' ? { apiKey: 'anonymous' } : await read(account);
    if (!auth.apiKey?.trim()) continue;
    const cache = accountModelsCache(provider, account);
    if (provider.authType === 'oauth' && auth.accountId && cache?.oauthAccountId !== auth.accountId) continue;
    usable.push({ account: { ...account, modelsCache: cache, tag: accountTag(account, provider.accounts ?? []), name: account.name ?? account.id }, auth });
  }
  const primary = usable.find(item => item.account.authRef === provider.authRef) ?? usable[0];
  if (!primary) return null;
  const source = { ...provider, accounts: usable.map(item => item.account), modelsCache: primary.account.modelsCache };
  const [local] = materializeRegistry({ schemaVersion: 1, providers: [source] }, () => primary.auth.apiKey, options);
  return local ? { ...local, models: expandAccountModels(source, local.models, options?.agent),
    oauthAccountId: primary.auth.accountId, providerData: primary.auth.providerData } : null;
}
