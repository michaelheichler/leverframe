import type { RegistryAccount, RegistryProvider } from './types.js';

export function primaryRegistryAccountId(provider: RegistryProvider): string | undefined {
  return provider.accounts?.find(account => account.authRef === provider.authRef)?.id;
}

export function accountModelsCache(provider: RegistryProvider, account: RegistryAccount): RegistryProvider['modelsCache'] {
  return account.modelsCache ?? (account.id === primaryRegistryAccountId(provider) ? provider.modelsCache : undefined);
}
