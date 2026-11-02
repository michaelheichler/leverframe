import { resolveProviderAccountAuth } from '../env.js';
import { fetchAntigravityModels } from '../antigravity/models.js';
import { refreshAccountCatalogs } from './account-catalogs.js';
import type { CachedModel, RegistryProvider } from './types.js';

export function refreshConfiguredAccounts(
  provider: RegistryProvider,
  discover: (source: RegistryProvider, key: string | null) => Promise<{ models?: CachedModel[]; modelSource?: string; reason?: string }>,
) {
  return refreshAccountCatalogs(provider, async account => {
    const auth = await resolveProviderAccountAuth(provider.id, account);
    if (!auth.apiKey && provider.authType !== 'none') throw new Error('Account credentials are unavailable. Sign in again.');
    if (provider.id === 'antigravity') {
      const projectId = auth.providerData?.projectId;
      if (!auth.accountId || typeof projectId !== 'string') throw new Error('The subscription account has no managed project.');
      const models = await fetchAntigravityModels({ accessToken: auth.apiKey!, accountId: auth.accountId, projectId });
      const latest = await resolveProviderAccountAuth(provider.id, account);
      if (latest.accountId !== auth.accountId || latest.providerData?.projectId !== projectId) throw new Error('The account changed during discovery.');
      return { models, oauthAccountId: auth.accountId };
    }
    const result = await discover({ ...provider, authRef: account.authRef, modelsCache: account.modelsCache }, auth.apiKey);
    if (!result.models || result.modelSource !== 'live') throw new Error(result.reason ?? 'Fresh account discovery did not return a live catalog.');
    return { models: result.models, ...(auth.accountId ? { oauthAccountId: auth.accountId } : {}) };
  });
}
