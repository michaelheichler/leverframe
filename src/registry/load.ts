import { UnstableCredentialSnapshotError } from '../credential-store.js';
import {
  resolveProviderAuth,
  resolveProviderAccountAuth,
  resolveStoredAccountCredential,
  resolveStoredProviderCredential,
  type ResolvedProviderAuth,
} from '../env.js';
import type { CompatibilityAgent } from '../model-compatibility.js';
import type { LocalProvider } from '../types.js';
import { materializeRegistry } from './materialize.js';
import { loadRegistry } from './io.js';
import { expandAccountModels } from '../account-models.js';
import { hasAccountCatalog, loadAccountProvider } from './account-loading.js';
import { resolveTemplateCapabilities } from '../provider-template-capabilities.js';
import type { RegistryProvider } from './types.js';

function credentialDiagnostic(provider: RegistryProvider, diag?: (message: string) => void) {
  let reported = false;
  return (auth: ResolvedProviderAuth): ResolvedProviderAuth => {
    const template = resolveTemplateCapabilities({ templateId: provider.templateId, providerId: provider.id });
    const notice = template?.credentialNotice?.(provider.api.url, auth.apiKey);
    if (notice && !reported) {
      reported = true;
      (diag ?? console.warn)(notice);
    }
    return auth;
  };
}

export async function loadRegistryProviders(
  diag?: (msg: string) => void,
  opts?: { agent?: CompatibilityAgent },
): Promise<LocalProvider[]> {
  const registry = loadRegistry();
  const keys = new Map<string, string>();
  const oauthAccountIds = new Map<string, string>();
  const oauthProviderData = new Map<string, Record<string, unknown>>();
  const accountProviders: LocalProvider[] = [];
  for (const provider of registry.providers) {
    if (!provider.enabled) continue;
    const reportAuth = credentialDiagnostic(provider, diag);
    if (hasAccountCatalog(provider)) {
      const loaded = await loadAccountProvider(provider, account => resolveProviderAccountAuth(provider.id, account, diag)
        .then(reportAuth).catch(() => ({ apiKey: null })), opts);
      if (loaded) accountProviders.push(loaded);
      continue;
    }
    try {
      const auth = reportAuth(await resolveProviderAuth(provider.id, provider.authRef, diag));
      if (provider.id === 'antigravity' && (provider.accounts?.length ?? 0) < 2
        && (!auth.accountId || provider.modelsCache?.oauthAccountId !== auth.accountId)) continue;
      if (auth.apiKey) keys.set(provider.id, auth.apiKey);
      if (provider.authType === 'oauth') {
        if (auth.accountId) oauthAccountIds.set(provider.id, auth.accountId);
        if (auth.providerData) oauthProviderData.set(provider.id, auth.providerData);
      }
    } catch (err) {
      diag?.(`${provider.id}: credential unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return [...materializeRegistry({ ...registry, providers: registry.providers.filter(provider => !hasAccountCatalog(provider)) }, provider => keys.get(provider.id) ?? null, opts)
    .map(provider => ({
      ...provider,
      models: expandAccountModels(registry.providers.find(item => item.id === provider.id)!, provider.models, opts?.agent),
      oauthAccountId: oauthAccountIds.get(provider.id),
      providerData: oauthProviderData.get(provider.id),
    })), ...accountProviders];
}

export interface StoredRegistryCatalog {
  providers: LocalProvider[];
  refreshDue: string[];
  unstable: string[];
}

/** Because patch diagnostics must stay read-only and network-free. */
export async function loadStoredRegistryProviders(
  opts?: { agent?: CompatibilityAgent },
): Promise<StoredRegistryCatalog> {
  const registry = loadRegistry();
  const keys = new Map<string, string>();
  const refreshDue: string[] = [];
  const unstable: string[] = [];
  const accountProviders: LocalProvider[] = [];
  for (const provider of registry.providers) {
    if (!provider.enabled) continue;
    if (hasAccountCatalog(provider)) {
      const loaded = await loadAccountProvider(provider, async account => {
        try {
          const stored = await resolveStoredAccountCredential(provider.id, account);
          if (stored.refreshDue && !refreshDue.includes(provider.id)) refreshDue.push(provider.id);
          return { apiKey: stored.value, accountId: stored.accountId, providerData: stored.providerData };
        } catch (error) {
          if (error instanceof UnstableCredentialSnapshotError && !unstable.includes(provider.id)) unstable.push(provider.id);
          return { apiKey: null };
        }
      }, opts);
      if (loaded) accountProviders.push(loaded);
      continue;
    }
    const stored = await resolveStoredProviderCredential(provider.id, provider.authRef)
      .catch((error: unknown) => {
        if (error instanceof UnstableCredentialSnapshotError) unstable.push(provider.id);
        return { value: null, refreshDue: false, accountId: undefined };
      });
    if (provider.id === 'antigravity' && (!stored.accountId || provider.modelsCache?.oauthAccountId !== stored.accountId)) continue;
    if (stored.value) keys.set(provider.id, stored.value);
    if (stored.refreshDue) refreshDue.push(provider.id);
  }
  const providers = [...materializeRegistry({ ...registry, providers: registry.providers.filter(provider => !hasAccountCatalog(provider)) }, provider => keys.get(provider.id) ?? null, opts)
    .map(provider => ({ ...provider, models: expandAccountModels(registry.providers.find(item => item.id === provider.id)!, provider.models, opts?.agent) })), ...accountProviders];
  return { providers, refreshDue, unstable };
}

export function loadRegistryProvidersSync(
  resolveKey: (providerId: string, authRef: string) => string | null,
  opts?: { agent?: CompatibilityAgent },
): LocalProvider[] {
  const registry = loadRegistry();
  return materializeRegistry(registry, provider => resolveKey(provider.id, provider.authRef), opts);
}
