import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { getProvidersPath } from '../src/paths.js';
import { buildRoutingCatalog } from '../src/model-routing-catalog.js';
import { loadRegistry, loadRegistryStrict, saveRegistry } from '../src/registry/io.js';
import { materializeNativeClaudeProvider } from '../src/registry/import-build.js';
import { cachedModel, input, nativeProviderWithRoutingMetadata, observation, provider } from './model-routing-fixtures.js';

it('keeps legacy providers economically unknown when billing metadata is absent', () => {
  const legacy = provider({ id: 'legacy-provider', templateId: 'custom', modelsCache: {
    fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel('legacy-model')],
  } });

  const snapshot = buildRoutingCatalog(input([legacy], { credentials: [observation(legacy.id)] }));

  expect(snapshot.models.find(model => model.ref.modelId === 'legacy-model')?.billing.kind).toBe('unknown');
});

it('preserves supplier subscription evidence for an API-key credential', () => {
  const providerWithSubscription = provider({
    id: 'api-key-subscription',
    templateId: 'custom',
    billing: { kind: 'subscription', source: 'supplier', observedAt: '2026-10-01T00:00:00.000Z' },
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel('subscription-model')] },
  });

  const snapshot = buildRoutingCatalog(input([providerWithSubscription], {
    credentials: [observation(providerWithSubscription.id, 'api_key')],
  }));

  expect(snapshot.models.find(model => model.ref.modelId === 'subscription-model')?.billing.kind).toBe('subscription');
});

it.each([
  { credentialKind: 'oauth' as const },
  { credentialKind: 'api_key' as const },
])('keeps native credential kind $credentialKind distinct from provider billing', ({ credentialKind }) => {
  const native = materializeNativeClaudeProvider({
    models: [cachedModel('native-fixture-model')],
    source: 'harness',
    credentialKind,
    now: '2026-10-01T00:00:00.000Z',
  });

  const snapshot = buildRoutingCatalog(input([native], { credentials: [observation(native.id, credentialKind)] }));
  const model = snapshot.models.find(candidate => candidate.ref.providerId === native.id);

  expect(model?.credential.kind).toBe(credentialKind);
  expect(model?.billing.kind).toBe('unknown');
});

it('preserves billing, native credential references, cache provenance, and model prices through registry storage', () => {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-routing-catalog-'));
  const previousHome = process.env['LEVERFRAME_HOME'];
  const { native, providerBilling, accountBilling, pricingMetadata } = nativeProviderWithRoutingMetadata();
  process.env['LEVERFRAME_HOME'] = home;

  try {
    expect(getProvidersPath()).toBe(join(home, 'providers.json'));
    saveRegistry({ schemaVersion: 1, providers: [native] });
    const loaded = loadRegistry().providers[0];

    expect(loaded).toMatchObject({
      credentialSource: native.credentialSource,
      authRef: native.authRef,
      billing: providerBilling,
      modelsCache: {
        source: native.modelsCache?.source,
        models: [{ pricing: pricingMetadata }],
      },
      accounts: [{
        authRef: native.accounts?.[0]?.authRef,
        billing: accountBilling,
        modelsCache: { source: 'account', models: [{ pricing: pricingMetadata }] },
      }],
    });
  } finally {
    if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
    else process.env['LEVERFRAME_HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

it('preserves unknown billing provenance from registry JSON at provider and account scope', () => {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-unknown-billing-'));
  vi.stubEnv('LEVERFRAME_HOME', home);
  const billing = { kind: 'unknown', source: 'fixture-evidence', observedAt: '2026-10-01T00:00:00.000Z' };
  const registryPath = join(home, 'providers.json');
  const rawRegistry = {
    schemaVersion: 1,
    providers: [{
      id: 'billing-evidence-provider', templateId: 'custom', name: 'Billing Evidence',
      enabled: true, authRef: 'fixture:provider', authType: 'oauth', api: {},
      billing,
      accounts: [{ id: 'billing-account', authRef: 'fixture:account', enabled: true, billing }],
      addedAt: '2026-10-01T00:00:00.000Z',
    }],
  };

  try {
    expect(getProvidersPath()).toBe(registryPath);
    writeFileSync(registryPath, JSON.stringify(rawRegistry));
    const loaded = loadRegistryStrict().providers[0];

    expect(loaded).toMatchObject({ billing, accounts: [{ billing }] });
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});
