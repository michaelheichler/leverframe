// src/registry/add-template.ts: add a provider from a builtin template

import { saveProviderCredential } from '../env.js';
import { isSdkMigratedNpm } from '../provider-factory.js';
import type { ProviderTemplate } from '../provider-templates.js';
import { classifyFreeStatus, isFreeStatus } from '../free-models.js';
import { fetchTemplateModels } from './fetch-template-models.js';
import { loadRegistry, saveRegistry } from './io.js';
import {
  buildPricingIndex,
  enrichModelsWithPricing,
  enrichPricingAsync,
  loadPricingCache,
  pricingPlatformForProvider,
} from './pricing.js';
import type { RegistryProvider } from './types.js';

export interface AddTemplateResult {
  added: boolean;
  provider?: RegistryProvider;
  modelCount?: number;
  error?: string;
  hint?: string;
  /**
   * True only when leverframe actually exchanged the API key with the upstream
   * provider and got back a successful response. False when the seed models
   * were persisted without any network call (static-seed templates that opt
   * out of verification) or when an api-list template fell back to its
   * declared staticModels after a listing outage. Callers surface this so
   * the user knows the key was stored, not validated.
   */
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
  fetched: { baseUrl: string; models: import('./types.js').CachedModel[] },
  pricedModels: import('./types.js').CachedModel[],
  authRef: string,
  existing: RegistryProvider | undefined,
): RegistryProvider {
  const now = new Date().toISOString();
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
    },
    addedAt: existing?.addedAt ?? now,
    refreshedAt: now,
    modelsCache: {
      fetchedAt: now,
      models: pricedModels,
    },
  };
}

function persistEntry(registry: ReturnType<typeof loadRegistry>, entry: RegistryProvider, existing: RegistryProvider | undefined): void {
  if (existing) {
    const idx = registry.providers.findIndex(p => p.id === entry.id);
    registry.providers[idx] = entry;
  } else {
    registry.providers.push(entry);
  }
  saveRegistry(registry);
}

/** Persist credential + registry entry. Returns whether the upstream API key was actually validated. */
export async function addProviderFromTemplate(
  template: ProviderTemplate,
  apiKey: string,
  opts?: { replaceExisting?: boolean; baseUrl?: string },
): Promise<AddTemplateResult> {
  const packageError = await probeTemplatePackage(template);
  if (packageError) {
    return { added: false, error: packageError };
  }

  const trimmedKey = apiKey.trim();
  if (!trimmedKey && !template.apiKeyOptional) {
    return { added: false, error: 'API key cannot be empty.' };
  }

  const registry = loadRegistry();
  const existing = registry.providers.find(p => p.id === template.id);
  if (existing && !opts?.replaceExisting) {
    return {
      added: false,
      error: `${template.name} is already configured.`,
      hint: `Remove it first with: leverframe providers remove ${template.id}`,
    };
  }

  const fetched = await fetchTemplateModels(template, trimmedKey, opts?.baseUrl);
  if (fetched.error || fetched.models.length === 0) {
    return {
      added: false,
      error: fetched.error ?? 'No models returned.',
      hint: fetched.hint,
    };
  }
  const usableModels = !trimmedKey && template.anonymousFreeModels
    ? filterAnonymousFreeModels(fetched.models, template)
    : fetched.models;
  if (usableModels.length === 0) {
    return {
      added: false,
      error: 'No free models were returned for anonymous access.',
      hint: template.signupUrl ? `Add a ${template.name} API key from ${template.signupUrl} to use paid models.` : undefined,
    };
  }

  const authRef = `keyring:provider:${template.id}`;
  const saved = trimmedKey ? await saveProviderCredential(authRef, trimmedKey) : true;
  if (!saved) {
    return {
      added: false,
      error: 'Could not save API key to credential storage.',
      hint: 'Check Keychain access and leverframe home permissions, then try again.',
    };
  }

  const pricingCache = loadPricingCache();
  const platform = pricingPlatformForProvider(template.id, template.id);
  const pricedModels = enrichModelsWithPricing(
    usableModels.map(m => ({ ...m, apiUrl: fetched.baseUrl })),
    buildPricingIndex(pricingCache),
    platform,
  );
  const entry = buildRegistryEntry(template, fetched, pricedModels, authRef, existing);
  persistEntry(registry, entry, existing);
  enrichPricingAsync();

  const keyVerified = !template.skipKeyVerification && !fetched.usedStaticFallback;
  return {
    added: true,
    provider: entry,
    modelCount: pricedModels.length,
    keyVerified,
    hint: keyVerified
      ? undefined
      : fetched.usedStaticFallback
        ? `Live model listing for ${template.name} was unavailable. leverframe stored the API key and the documented static model list, but did not verify the key. The first request will validate it.`
        : 'API key stored in leverframe credential storage. leverframe did not verify it against an upstream endpoint, so a bad key will only surface on the first request.',
  };
}
