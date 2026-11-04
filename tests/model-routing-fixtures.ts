import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderRegistry, RegistryProvider } from '../src/registry/types.js';
import type { CatalogSnapshotInput, CredentialObservation } from '../src/model-routing-catalog.js';
import { materializeNativeClaudeProvider } from '../src/registry/import-build.js';
import type { PricingCacheFile } from '../src/registry/pricing.js';

export const pricing = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'model-routing-pricing.json'), 'utf8')) as PricingCacheFile;
export const multiTierPricing = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'model-routing-pricing-tiers.json'), 'utf8')) as PricingCacheFile;
export const unverifiablePlatformPricing = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'model-routing-pricing-unverifiable-platform.json'), 'utf8')) as PricingCacheFile;
export const modelsDevTierFixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'model-routing-models-dev-tiers.json'), 'utf8')) as Record<string, unknown>;

export function cachedModel(id: string) {
  return { id, name: id, upstreamModelId: id, modelFormat: 'anthropic' as const };
}

export function provider(overrides: Partial<RegistryProvider> & Pick<RegistryProvider, 'id' | 'templateId'>): RegistryProvider {
  const { id, templateId, ...metadata } = overrides;
  return {
    id,
    templateId,
    name: id,
    enabled: true,
    authRef: `keyring:provider:${id}`,
    authType: 'api',
    api: { npm: '@ai-sdk/anthropic', url: 'https://routing-fixture.invalid/v1' },
    addedAt: '2026-01-01T00:00:00.000Z',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [] },
    ...metadata,
  };
}

export function input(providers: RegistryProvider[], overrides: Partial<CatalogSnapshotInput> = {}): CatalogSnapshotInput {
  return {
    registry: { schemaVersion: 1, providers } as ProviderRegistry,
    pricing,
    now: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

export function observation(providerId: string, kind: CredentialObservation['kind'] = 'api_key'): CredentialObservation {
  return { providerId, kind, available: true };
}

export function nativeProviderWithRoutingMetadata() {
  const providerBilling = { kind: 'subscription' as const, source: 'supplier-fixture', observedAt: '2026-10-01T00:00:00.000Z' };
  const accountBilling = { kind: 'metered' as const, source: 'account-fixture', observedAt: '2026-10-01T00:00:00.000Z' };
  const pricingMetadata = {
    input: 1.25, output: 4.5, cacheRead: 0.3, cacheWrite: 1.8,
    source: 'pricing-fixture', observedAt: '2026-10-01T00:00:00.000Z',
  };
  const native = materializeNativeClaudeProvider({
    models: [{ ...cachedModel('roundtrip-native-model'), pricing: pricingMetadata }],
    source: 'harness',
    credentialKind: 'oauth',
    billing: providerBilling,
    now: '2026-10-01T00:00:00.000Z',
  });
  native.accounts = [{
    id: 'account-fixture', authRef: 'keyring:account-fixture', enabled: true,
    billing: accountBilling,
    modelsCache: {
      fetchedAt: '2026-10-01T00:00:00.000Z', source: 'account',
      models: [{ ...cachedModel('roundtrip-account-model'), pricing: pricingMetadata }],
    },
  }];
  return { native, providerBilling, accountBilling, pricingMetadata };
}
