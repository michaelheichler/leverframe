import type { LocalProvider } from './types.js';

export function favoriteProviderDisplayName(
  provider: Pick<LocalProvider, 'id' | 'name' | 'authType'>,
): string {
  if (provider.authType === 'oauth' && !/\boauth\b/i.test(provider.name)) {
    return `${provider.name} OAuth`;
  }
  return provider.name;
}
