

import { saveProviderCredential } from '../env.js';
import { fetchAnthropicModels } from './anthropic-models-fetch.js';
import { fetchTemplateModels } from './fetch-template-models.js';
import { loadRegistryStrict, updateRegistry } from './io.js';
import { cancelCredentialDelete, journalCredentialWrite, reconcilePendingCredentialDeletes } from './credential-lifecycle.js';
import { withCredentialMutationLock, withProviderMutationLock } from './lock.js';
import type { CachedModel, RegistryProvider } from './types.js';
import { customProviderId, isValidProviderId, slugifyProviderId } from './validate.js';
import { validateCustomEndpointUrl } from './url-security.js';

export type CustomEndpointKind = 'openai' | 'anthropic';

export interface AddCustomEndpointInput {
  displayName: string;
  baseUrl: string;
  apiKey: string;
  kind: CustomEndpointKind;
  allowInsecureLocal?: boolean;

  headers?: Record<string, string>;
}

export interface AddCustomEndpointResult {
  added: boolean;
  provider?: RegistryProvider;
  modelCount?: number;
  error?: string;
  hint?: string;
}

function npmForKind(kind: CustomEndpointKind): string {
  return kind === 'anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible';
}

function modelFormatForKind(kind: CustomEndpointKind): 'anthropic' | 'openai' {
  return kind === 'anthropic' ? 'anthropic' : 'openai';
}

function uniqueProviderId(displayName: string, registry: { providers: RegistryProvider[] }): string {
  let base = customProviderId(displayName);
  if (!base.startsWith('custom-')) base = `custom-${slugifyProviderId(displayName)}`;
  if (!isValidProviderId(base)) base = 'custom-provider';

  if (!registry.providers.some(p => p.id === base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (isValidProviderId(candidate) && !registry.providers.some(p => p.id === candidate)) {
      return candidate;
    }
  }
  return `${base}-${Date.now()}`;
}

async function addCustomEndpointProviderLocked(input: AddCustomEndpointInput): Promise<AddCustomEndpointResult> {
  const urlCheck = await validateCustomEndpointUrl(input.baseUrl, {
    allowInsecureLocal: input.allowInsecureLocal,
  });
  if (!urlCheck.ok || !urlCheck.normalizedUrl) {
    return { added: false, error: urlCheck.error, hint: urlCheck.hint };
  }

  const registry = loadRegistryStrict();
  const providerId = uniqueProviderId(input.displayName.trim(), registry);
  const npm = npmForKind(input.kind);
  const apiKey = input.apiKey.trim();
  const anonymous = apiKey.length === 0;

  const headers = input.headers && Object.keys(input.headers).length > 0 ? input.headers : undefined;

  let fetched: { models: CachedModel[]; baseUrl: string; error?: string; hint?: string };
  if (input.kind === 'anthropic') {
    fetched = await fetchAnthropicModels(urlCheck.normalizedUrl, apiKey, headers);
  } else {
    fetched = await fetchTemplateModels(
      {
        id: providerId,
        name: input.displayName,
        authType: anonymous ? 'none' : 'api',
        npm,
        defaultBaseUrl: urlCheck.normalizedUrl,
        modelSource: 'api-list',
        supported: true,
      },
      apiKey,
      urlCheck.normalizedUrl,
      headers,
      { allowInsecureLocal: input.allowInsecureLocal === true },
    );
  }

  if (fetched.error || fetched.models.length === 0) {
    return { added: false, error: fetched.error ?? 'No models returned.', hint: fetched.hint };
  }

  const authRef = anonymous ? 'none:anonymous' : `keyring:provider:${providerId}`;
  const now = new Date().toISOString();
  const entry: RegistryProvider = {
    id: providerId,
    templateId: input.kind === 'anthropic' ? 'custom-anthropic' : 'custom-openai',
    name: input.displayName.trim(),
    enabled: true,
    authRef,
    authType: anonymous ? 'none' : 'api',
    api: { npm, url: fetched.baseUrl, ...(headers ? { headers } : {}) },
    addedAt: now,
    refreshedAt: now,
    modelsCache: {
      fetchedAt: now,
      models: fetched.models.map(m => ({
        ...m,
        modelFormat: modelFormatForKind(input.kind),
        npm,
        apiUrl: fetched.baseUrl,
      })),
    },
  };

  const publish = (): void => updateRegistry(current => {
    if (current.providers.some(provider => provider.id === entry.id)) {
      throw new Error(`Provider id became active while adding endpoint: ${entry.id}`);
    }
    current.providers.push(entry);
  });

  if (!anonymous && apiKey !== 'local') {
    const saved = await withCredentialMutationLock(authRef, async () => {
      await journalCredentialWrite(authRef);
      if (!await saveProviderCredential(authRef, apiKey)) return false;
      publish();
      try {
        await cancelCredentialDelete(authRef);
      } catch {
        return true;
      }
      return true;
    });
    if (!saved) {
      return { added: false, error: 'Could not save API key to credential storage.', hint: 'Check Keychain access and leverframe home permissions, then try again.' };
    }
  } else {
    publish();
  }

  return { added: true, provider: entry, modelCount: fetched.models.length };
}

export async function addCustomEndpointProvider(input: AddCustomEndpointInput): Promise<AddCustomEndpointResult> {
  const providerSlot = customProviderId(input.displayName.trim());
  try {
    return await withProviderMutationLock(
      providerSlot,
      () => addCustomEndpointProviderLocked(input),
    );
  } finally {
    await reconcilePendingCredentialDeletes();
  }
}
