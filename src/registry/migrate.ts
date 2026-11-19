import type { ProviderRegistry } from './types.js';
import { isRetiredOpenAiProvider } from './retired-openai.js';

export function migrateProviderAccounts(registry: ProviderRegistry): boolean {
  let changed = false;
  for (const provider of registry.providers) {
    if (provider.accounts !== undefined || isRetiredOpenAiProvider(provider)) continue;
    provider.accounts = [{ id: 'default', authRef: provider.authRef, enabled: true }];
    changed = true;
  }
  return changed;
}
