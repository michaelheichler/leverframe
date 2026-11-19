import * as p from '@clack/prompts';
import { loadPreferences, setPreserveCachePrefix } from './config.js';
import type { ProviderDisplayEntry } from './provider-catalog.js';

export async function runProviderCacheSettings(entries: readonly Pick<ProviderDisplayEntry, 'id' | 'name' | 'enabled'>[]): Promise<void> {
  const providers = entries.filter(entry => entry.enabled);
  if (providers.length === 0) return;
  const saved = loadPreferences().preserveCachePrefixProviders ?? [];
  const providerId = await p.select({
    message: 'Choose a provider',
    options: providers.map(provider => ({
      value: provider.id,
      label: provider.name,
      hint: saved.includes(provider.id) ? 'Preserve prefix' : 'Current behavior',
    })),
  });
  if (p.isCancel(providerId)) return;
  const policy = await p.select({
    message: 'Local context policy',
    initialValue: saved.includes(providerId) ? 'preserve' : 'current',
    options: [
      { value: 'current', label: 'Current behavior', hint: 'Use the existing local context policy' },
      { value: 'preserve', label: 'Preserve prefix (experimental)', hint: 'Keep tool results and history intact' },
    ],
  });
  if (p.isCancel(policy)) return;
  setPreserveCachePrefix(providerId, policy === 'preserve');
  p.log.success('Saved provider cache settings.');
}
