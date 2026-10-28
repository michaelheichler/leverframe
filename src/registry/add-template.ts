

import { saveProviderCredential } from '../env.js';
import { isSdkMigratedNpm } from '../provider-factory.js';
import type { ProviderTemplate } from '../provider-templates.js';
import { classifyFreeStatus, isFreeStatus } from '../free-models.js';
import { fetchTemplateModels, type FetchTemplateModelsResult } from './fetch-template-models.js';
import { loadRegistryStrict, updateRegistry } from './io.js';
import { cancelCredentialDelete, journalCredentialWrite, reconcilePendingCredentialDeletes } from './credential-lifecycle.js';
import { withCredentialMutationLock, withProviderMutationLock } from './lock.js';
import {
  buildPricingIndex,
  enrichModelsWithPricing,
  enrichPricingAsync,
  loadPricingCache,
  pricingPlatformForProvider,
} from './pricing.js';
import type { CachedModel, RegistryProvider } from './types.js';

export interface AddTemplateResult {
  added: boolean;
  provider?: RegistryProvider;
  modelCount?: number;
  error?: string;
  hint?: string;

  keyVerified?: boolean;
}

async function probeTemplatePackage(template: ProviderTemplate): Promise<string | null> {
  if (!template.supported) return template.unsupportedReason ?? 'Provider is not supported yet.';
  if (!template.npm) return 'Template is missing an SDK package.';
  if (!isSdkMigratedNpm(template.npm) && template.npm !== '@ai-sdk/anthropic') {
    return `SDK package ${template.npm} is not available in leverframe.`;
  }
  try {
    await import(template.npm);
    return null;
  } catch {
    return `Could not load ${template.npm}. Run npm install in your leverframe checkout.`;
  }
}

function filterAnonymousFreeModels<T extends { cost?: { input: number; output: number }; isFree?: boolean; freeStatus?: ReturnType<typeof classifyFreeStatus> }>(
  models: T[],
  template: ProviderTemplate,
): T[] {
  if (!template.anonymousFreeModels) return models;
  return models.filter(model => isFreeStatus(classifyFreeStatus({
    model,
    providerId: template.id,
    templateId: template.id,
  })));
}

function buildRegistryEntry(
  template: ProviderTemplate,
  fetched: { baseUrl: string; models: import('./types.js').CachedModel[]; headers?: Record<string, string> },
  pricedModels: import('./types.js').CachedModel[],
  authRef: string,
  existing: RegistryProvider | undefined,
): RegistryProvider {
  const now = new Date().toISOString();
  const headers = fetched.headers && Object.keys(fetched.headers).length > 0 ? { headers: fetched.headers } : {};
  return {
    id: template.id,
    templateId: template.id,
    name: template.name,
    enabled: true,
    authRef,
    authType: template.authType,
    api: {
      npm: template.npm,
      url: fetched.baseUrl,
      ...headers,
    },
    addedAt: existing?.addedAt ?? now,
    refreshedAt: now,
    modelsCache: {
      fetchedAt: now,
      models: pricedModels,
    },
  };
}

export interface AddTemplateOptions {
  replaceExisting?: boolean;
  baseUrl?: string;
  headers?: Record<string, string>;
}

type TemplateListing =
  | { failure: AddTemplateResult }
  | { fetched: FetchTemplateModelsResult & { headers?: Record<string, string> }; usableModels: CachedModel[] };

async function listUsableTemplateModels(
  template: ProviderTemplate,
  trimmedKey: string,
  opts?: AddTemplateOptions,
): Promise<TemplateListing> {
  const listed = await fetchTemplateModels(template, trimmedKey, opts?.baseUrl, opts?.headers);
  if (listed.error || listed.models.length === 0) {
    return { failure: { added: false, error: listed.error ?? 'No models returned.', hint: listed.hint } };
  }
  const usableModels = !trimmedKey && template.anonymousFreeModels
    ? filterAnonymousFreeModels(listed.models, template)
    : listed.models;
  if (usableModels.length === 0) {
    return {
      failure: {
        added: false,
        error: 'No free models were returned for anonymous access.',
        hint: template.signupUrl ? `Add a ${template.name} API key from ${template.signupUrl} to use paid models.` : undefined,
      },
    };
  }
  return { fetched: { ...listed, headers: opts?.headers }, usableModels };
}

async function addProviderFromTemplateLocked(
  template: ProviderTemplate,
  apiKey: string,
  opts?: AddTemplateOptions,
): Promise<AddTemplateResult> {
  const packageError = await probeTemplatePackage(template);
  if (packageError) {
    return { added: false, error: packageError };
  }

  const trimmedKey = apiKey.trim();
  if (!trimmedKey && !template.apiKeyOptional) {
    return { added: false, error: 'API key cannot be empty.' };
  }

  const registry = loadRegistryStrict();
  const existing = registry.providers.find(p => p.id === template.id);
  if (existing && !opts?.replaceExisting) {
    return {
      added: false,
      error: `${template.name} is already configured.`,
      hint: `Remove it first with: leverframe providers remove ${template.id}`,
    };
  }

  const listing = await listUsableTemplateModels(template, trimmedKey, opts);
  if ('failure' in listing) return listing.failure;
  const { fetched, usableModels } = listing;

  const authRef = trimmedKey ? `keyring:provider:${template.id}` : 'none:anonymous';
  const pricingCache = loadPricingCache();
  const platform = pricingPlatformForProvider(template.id, template.id);
  const pricedModels = enrichModelsWithPricing(
    usableModels.map(m => ({ ...m, apiUrl: fetched.baseUrl })),
    buildPricingIndex(pricingCache),
    platform,
  );
  const publish = (): RegistryProvider => updateRegistry(current => {
    const active = current.providers.find(provider => provider.id === template.id);
    if (active && !opts?.replaceExisting) {
      throw new Error(`${template.name} became active while adding the provider.`);
    }
    const entry = buildRegistryEntry(template, fetched, pricedModels, authRef, active);
    const index = current.providers.findIndex(provider => provider.id === entry.id);
    if (index >= 0) current.providers[index] = entry;
    else current.providers.push(entry);
    return entry;
  });
  const entry = trimmedKey ? await publishWithCredential(authRef, trimmedKey, publish) : publish();
  if (!entry) {
    return {
      added: false,
      error: 'Could not save API key to credential storage.',
      hint: 'Check Keychain access and leverframe home permissions, then try again.',
    };
  }
  enrichPricingAsync();
  return addedResult(template, entry, pricedModels.length);
}

async function publishWithCredential(
  authRef: string,
  key: string,
  publish: () => RegistryProvider,
): Promise<RegistryProvider | null> {
  return withCredentialMutationLock(authRef, async () => {
    await journalCredentialWrite(authRef);
    if (!await saveProviderCredential(authRef, key)) return null;
    const committed = publish();
    try {
      await cancelCredentialDelete(authRef);
    } catch {
      return committed;
    }
    return committed;
  });
}

function addedResult(
  template: ProviderTemplate,
  entry: RegistryProvider,
  modelCount: number,
): AddTemplateResult {
  const keyVerified = !template.skipKeyVerification;
  return {
    added: true,
    provider: entry,
    modelCount,
    keyVerified,
    hint: keyVerified
      ? undefined
      : 'API key stored in leverframe credential storage. leverframe did not verify it against an upstream endpoint, so a bad key will only surface on the first request.',
  };
}

export function addProviderFromTemplate(
  template: ProviderTemplate,
  apiKey: string,
  opts?: AddTemplateOptions,
): Promise<AddTemplateResult> {
  return withProviderMutationLock(template.id, async () => {
    try {
      return await addProviderFromTemplateLocked(template, apiKey, opts);
    } finally {
      await reconcilePendingCredentialDeletes();
    }
  });
}
