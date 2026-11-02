import { loadRegistry } from './registry/io.js';
import { resolveProviderAccountAuth } from './env.js';
import type { ProxyRoute } from './proxy-request.js';

export async function resolveAccountRoute(route: ProxyRoute): Promise<ProxyRoute> {
  if (!route.accountId) return route;
  const provider = loadRegistry().providers.find(item => item.id === route.providerId && item.enabled);
  const account = provider?.accounts?.find(item => item.id === route.accountId && item.enabled);
  if (!provider || !account) throw new Error('The selected account is unavailable.');
  const auth = provider.authType === 'none' && account.authRef === 'none:anonymous'
    ? { apiKey: 'anonymous' } : await resolveProviderAccountAuth(provider.id, account);
  if (!auth.apiKey) throw new Error('The selected account has no usable credential.');
  return { ...route, apiKey: auth.apiKey, oauthAccountId: auth.accountId,
    providerData: { ...auth.providerData, leverframeAccountId: account.id } };
}
