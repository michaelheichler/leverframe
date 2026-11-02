import { updateRegistry } from './io.js';
import type { CachedModel, RegistryAccount, RegistryProvider } from './types.js';
import type { RefreshProviderResult } from './refresh-models.js';
import { randomUUID } from 'node:crypto';
import { primaryRegistryAccountId } from './account-cache.js';

export async function refreshAccountCatalogs(
  provider: RegistryProvider,
  discover: (account: RegistryAccount) => Promise<{ models: CachedModel[]; oauthAccountId?: string }>,
): Promise<RefreshProviderResult> {
  const accountResults: NonNullable<RefreshProviderResult['accountResults']> = [];
  const liveModels = new Set<string>();
  for (const account of (provider.accounts ?? []).filter(item => item.enabled)) {
    const generation = randomUUID();
    try {
      const started = updateRegistry(registry => {
        const target = registry.providers.find(item => item.id === provider.id && item.enabled)?.accounts
          ?.find(item => item.id === account.id && item.enabled && item.authRef === account.authRef);
        if (!target) return false;
        target.modelDiscoveryGeneration = generation;
        return true;
      });
      if (!started) throw new Error('The account changed before discovery.');
      const result = await discover(account);
      if (!result.models.length) throw new Error('The account returned no available models.');
      const cache = { ...result, fetchedAt: new Date().toISOString() };
      const published = updateRegistry(registry => {
        const current = registry.providers.find(item => item.id === provider.id && item.enabled);
        const target = current?.accounts?.find(item => item.id === account.id && item.enabled
          && item.authRef === account.authRef && item.modelDiscoveryGeneration === generation);
        if (!target || !current) return false;
        target.modelsCache = cache;
        delete target.modelDiscoveryError;
        if (target.id === primaryRegistryAccountId(current)) {
          current.modelsCache = cache;
          current.refreshedAt = cache.fetchedAt;
          delete current.modelDiscoveryError;
        }
        return true;
      });
      if (!published) throw new Error('The account changed during discovery. Refresh again.');
      result.models.forEach(model => liveModels.add(model.id));
      accountResults.push({ accountId: account.id, ok: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Account model discovery failed.';
      updateRegistry(registry => {
        const target = registry.providers.find(item => item.id === provider.id && item.enabled)?.accounts
          ?.find(item => item.id === account.id && item.enabled && item.authRef === account.authRef && item.modelDiscoveryGeneration === generation);
        if (target) target.modelDiscoveryError = reason;
      });
      accountResults.push({ accountId: account.id, ok: false, reason });
    }
  }
  const ok = accountResults.some(result => result.ok);
  return { id: provider.id, name: provider.name, ok, modelSource: ok ? 'live' : 'cache',
    modelCount: liveModels.size, accountResults,
    ...(accountResults.some(result => !result.ok) ? { reason: 'Some account catalogs are unavailable. Refresh or sign in again for the affected accounts.' } : {}),
  };
}
