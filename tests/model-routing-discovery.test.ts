import { expect, it } from 'vitest';
import { buildRoutingCatalog } from '../src/model-routing-catalog.js';
import { materializeNativeClaudeProvider } from '../src/registry/import-build.js';
import { cachedModel, input, provider } from './model-routing-fixtures.js';

it('resolves discovered native models separately from Anthropic API models', () => {
  const native = materializeNativeClaudeProvider({
    models: [cachedModel('same-upstream-id')],
    source: 'account',
    credentialKind: 'oauth',
    now: '2026-10-01T00:00:00.000Z',
  });
  const api = provider({
    id: 'anthropic-api',
    templateId: 'anthropic-api',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel('same-upstream-id')] },
  });

  const snapshot = buildRoutingCatalog(input([native, api]));

  expect(snapshot.models.map(model => model.ref)).toEqual([
    { providerId: native.id, modelId: 'same-upstream-id' },
    { providerId: api.id, modelId: 'same-upstream-id' },
  ]);
});

it('does not treat an unconfirmed native cache as an available model declaration', () => {
  const unconfirmedNative = provider({
    id: 'anthropic',
    templateId: 'anthropic',
    credentialSource: 'claude-code',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel('unconfirmed-native-model')] },
  });

  const snapshot = buildRoutingCatalog(input([unconfirmedNative]));

  expect(snapshot.models.some(model => model.ref.modelId === 'unconfirmed-native-model')).toBe(false);
});

it('marks a live API discovery result current and identifies its source', () => {
  const discovered = provider({
    id: 'discovery-provider',
    templateId: 'custom',
    modelsCache: { fetchedAt: '2026-10-02T00:00:00.000Z', models: [cachedModel('discovered-model')] },
  });
  const discovery = [{ providerId: discovered.id, status: 'live' as const, cacheFetchedAt: '2026-10-02T00:00:00.000Z' }];

  const snapshot = buildRoutingCatalog(input([discovered], { discovery }));

  expect(snapshot.models[0]).toMatchObject({ discovery: { state: 'current', source: 'api', confirmed: true } });
});

it('keeps a mismatched live discovery timestamp stale and unconfirmed', () => {
  const cached = provider({
    id: 'discovery-provider',
    templateId: 'custom',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel('timestamp-mismatch-model')] },
  });
  const discovery = [{ providerId: cached.id, status: 'live' as const, cacheFetchedAt: '2026-10-02T00:00:00.000Z' }];

  const snapshot = buildRoutingCatalog(input([cached], { discovery }));

  expect(snapshot.models[0]).toMatchObject({ discovery: { state: 'stale', confirmed: false } });
});

it.each([
  { status: 'cache' as const, expectedState: 'stale' },
  { status: 'failed' as const, expectedState: 'failed' },
  { status: 'seed' as const, expectedState: 'unknown' },
  { status: 'fallback' as const, expectedState: 'unknown' },
])('maps a $status discovery result without confirming it', ({ status, expectedState }) => {
  const cached = provider({
    id: 'discovery-provider',
    templateId: 'custom',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel('cached-model')] },
  });
  const discovery = [{ providerId: cached.id, status, cacheFetchedAt: '2026-10-01T00:00:00.000Z' }];

  const snapshot = buildRoutingCatalog(input([cached], { discovery }));

  expect(snapshot.models[0]).toMatchObject({ discovery: { state: expectedState, confirmed: false } });
});

it('keeps a registry cache unknown when no API discovery observation exists', () => {
  const cached = provider({
    id: 'discovery-provider',
    templateId: 'custom',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', models: [cachedModel('unobserved-model')] },
  });

  const snapshot = buildRoutingCatalog(input([cached]));

  expect(snapshot.models[0]).toMatchObject({ discovery: { state: 'unknown', confirmed: false } });
});

it('keeps a healthy account discovery confirmed when a sibling account fails', () => {
  const multiAccount = provider({
    id: 'multi-account-provider',
    templateId: 'custom',
    authRef: 'keyring:account:healthy',
    modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', source: 'account', models: [cachedModel('healthy-model')] },
    accounts: [
      { id: 'healthy', authRef: 'keyring:account:healthy', enabled: true },
      {
        id: 'failed', authRef: 'keyring:account:failed', enabled: true,
        modelsCache: { fetchedAt: '2026-10-01T00:00:00.000Z', source: 'account', models: [cachedModel('failed-model')] },
        modelDiscoveryError: 'synthetic refresh failure',
      },
    ],
  });
  const discovery = [
    { providerId: multiAccount.id, accountId: 'healthy', status: 'live' as const, cacheFetchedAt: '2026-10-01T00:00:00.000Z' },
    { providerId: multiAccount.id, accountId: 'failed', status: 'live' as const, cacheFetchedAt: '2026-10-01T00:00:00.000Z' },
  ];

  const snapshot = buildRoutingCatalog(input([multiAccount], { discovery }));

  expect(snapshot.models.find(model => model.accountId === 'healthy')).toMatchObject({
    discovery: { state: 'current', confirmed: true },
  });
  expect(snapshot.models.find(model => model.accountId === 'failed')).toMatchObject({
    discovery: { state: 'failed', confirmed: false },
  });
});

it('does not confirm an account cache after its owning account reports discovery failure', () => {
  const failedAccount = provider({
    id: 'account-cache-owner',
    templateId: 'custom',
    modelsCache: {
      fetchedAt: '2026-10-01T00:00:00.000Z', source: 'account', models: [cachedModel('last-known-model')],
    },
    accounts: [{
      id: 'primary', authRef: 'keyring:provider:account-cache-owner', enabled: true,
      modelDiscoveryError: 'fixture refresh failed',
    }],
  });

  const snapshot = buildRoutingCatalog(input([failedAccount]));

  expect(snapshot.models[0]?.discovery.confirmed).toBe(false);
});
