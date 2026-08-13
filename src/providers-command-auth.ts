// src/providers-command-auth.ts, sign-in and model-refresh command implementations for the providers command
import * as p from '@clack/prompts';
import { resolveProviderCredential } from './env.js';
import { loadRegistry } from './registry/io.js';
import { refreshAllProviderModels, refreshProviderModels } from './registry/refresh-models.js';
import { resolveRefreshCredential } from './registry/refresh-credentials.js';
import { authenticateProvider, type ProviderAuthMethod } from './registry/provider-auth.js';
import type { RegistryProvider } from './registry/types.js';

export async function runProvidersAuth(providerId: string, method?: ProviderAuthMethod): Promise<number> {
  try {
    const result = await authenticateProvider(providerId, { method });
    p.log.success(`Signed in to ${result.registryProvider.name} — credential saved.`);
    return 0;
  } catch (err) {
    if (err instanceof Error && err.message === 'Cancelled') {
      p.cancel('Cancelled.');
      return 0;
    }
    p.log.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export async function runProvidersRefreshModels(providerId?: string): Promise<number> {
  const resolveKey = async (provider: RegistryProvider) =>
    resolveProviderCredential(provider.id, provider.authRef);

  if (providerId) {
    const registry = loadRegistry();
    const provider = registry.providers.find(p => p.id === providerId);
    if (!provider) {
      p.log.error(`Provider not found: ${providerId}`);
      return 1;
    }
    const spinner = p.spinner();
    spinner.start(`Refreshing ${provider.name}...`);
    const key = await resolveRefreshCredential(provider, async p =>
      resolveProviderCredential(p.id, p.authRef),
    );
    const result = await refreshProviderModels(providerId, key);
    spinner.stop('');
    if (result.skipped) {
      const countNote = result.modelCount ? ` (${result.modelCount} cached models kept)` : '';
      p.log.warn(`${result.name}: ${result.reason}${countNote}`);
      return 0;
    }
    if (!result.ok) {
      p.log.error(`${result.name}: ${result.reason ?? 'Refresh failed.'}`);
      return 1;
    }
    const diff = result.previousModelCount === undefined
      ? 0
      : (result.modelCount ?? 0) - result.previousModelCount;
    const diffStr = result.previousModelCount === undefined
      ? ''
      : diff > 0 ? ` (+${diff})` : diff < 0 ? ` (${diff})` : '';
    p.log.success(`${result.name}: ${result.modelCount} model${result.modelCount === 1 ? '' : 's'} updated${diffStr}.`);
    if (result.reason) {
      p.log.warn(result.reason);
    }
    return 0;
  }

  const spinner = p.spinner();
  spinner.start('Refreshing model lists...');
  const { refreshed } = await refreshAllProviderModels(resolveKey);
  spinner.stop('');

  const ok = refreshed.filter(r => r.ok && !r.skipped);
  const skipped = refreshed.filter(r => r.skipped);
  const failed = refreshed.filter(r => !r.ok);

  if (ok.length > 0) {
    p.log.success(`Updated ${ok.length} provider${ok.length === 1 ? '' : 's'}.`);
    for (const r of ok) {
      const diff = r.previousModelCount === undefined
        ? 0
        : (r.modelCount ?? 0) - r.previousModelCount;
      const diffStr = r.previousModelCount === undefined
        ? ''
        : diff > 0 ? ` (+${diff})` : diff < 0 ? ` (${diff})` : '';
      p.log.info(`  ${r.name}: ${r.modelCount} model${r.modelCount === 1 ? '' : 's'}${diffStr}`);
      if (r.reason) {
        p.log.warn(`  ${r.reason}`);
      }
    }
  }
  for (const r of skipped) {
    const countNote = r.modelCount ? ` (${r.modelCount} cached models kept)` : '';
    p.log.warn(`Skipped ${r.name}: ${r.reason}${countNote}`);
  }
  for (const r of failed) {
    p.log.error(`${r.name}: ${r.reason ?? 'Refresh failed.'}`);
  }
  return failed.length > 0 ? 1 : 0;
}
