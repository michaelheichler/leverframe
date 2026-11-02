import { accountModelId, accountTag } from './account-identity.js';
import { cachedModelToLocal } from './registry/materialize.js';
import type { RegistryProvider } from './registry/types.js';
import type { LocalProviderModel } from './types.js';
import { shouldHideModel, type CompatibilityAgent } from './model-compatibility.js';
import { accountModelsCache } from './registry/account-cache.js';

function automaticModels(models: LocalProviderModel[]): LocalProviderModel[] {
  const groups = new Map<string, LocalProviderModel[]>();
  for (const model of models) groups.set(model.id, [...(groups.get(model.id) ?? []), model]);
  return [...groups.values()].map(entries => {
    const first = entries[0]!;
    const confirmed = entries.every(model => Number.isSafeInteger(model.contextWindow) && model.contextWindow! > 0 && !model.contextWindowUnconfirmed);
    const contextWindow = confirmed ? Math.min(...entries.map(model => model.contextWindow!)) : undefined;
    return { ...first, name: `${first.name} [AUTO]`, accountTag: 'AUTO', accountName: 'Auto pool',
      contextWindow, maxContextWindow: undefined, contextWindowUnconfirmed: contextWindow === undefined ? true : undefined };
  });
}

export function expandAccountModels(provider: RegistryProvider, models: LocalProviderModel[], agent: CompatibilityAgent = 'claude'): LocalProviderModel[] {
  const accounts = provider.accounts ?? [];
  if (accounts.length < 2 && !accounts.some(account => account.name || account.tag)) return models;
  const available: LocalProviderModel[] = [];
  const bound: LocalProviderModel[] = [];
  for (const account of accounts.filter(item => item.enabled)) {
    const cache = accountModelsCache(provider, account);
    const tag = accountTag(account, accounts);
    for (const cached of cache?.models ?? []) {
      const model = cachedModelToLocal(cached, provider);
      if (!model || (provider.subscriptionFilter === 'free' && !model.isFree)
        || shouldHideModel({ providerId: provider.id, modelId: model.id, agent })) continue;
      if (!account.modelDiscoveryError) available.push(model);
      bound.push({ ...model, id: accountModelId(model.id, account.id), name: `${model.name} [${tag}]`,
        accountId: account.id, accountTag: tag, accountName: account.name ?? account.id });
    }
  }
  return [...automaticModels(available), ...bound];
}
