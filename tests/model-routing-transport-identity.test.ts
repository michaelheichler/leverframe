import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';
import { expect, it } from 'vitest';
import { buildRoutingCatalog } from '../src/model-routing.js';
import { getAppHome } from '../src/paths.js';
import { ANTIGRAVITY_ORIGIN } from '../src/antigravity/types.js';
import { COPILOT_API_BASE_URL } from '../src/copilot/backend.js';
import { CODEX_API_BASE_URL } from '../src/constants.js';
import { routingTransportFingerprint } from '../src/routing-transport-identity.js';
import { createRoutingBinding, resolveRoutingBinding, routingBindingErrors, routingBindingStatePath } from '../src/routing-bindings.js';
import { routingIdentityErrors } from '../src/routing-policy-identity.js';
import type { RoutingCatalogSnapshot } from '../src/model-routing-catalog.js';
import { input, nativeProviderWithRoutingMetadata, observation, provider } from './model-routing-fixtures.js';
import { assertIsolatedRoutingSession } from './fixtures/model-routing-proxy.js';

const target = { providerId: 'fixture-transport-provider', modelId: 'fixture-transport-model' };
const upstreamModelId = 'fixture-transport-upstream-model';
const timestamp = '2026-10-01T00:00:00.000Z';
const transportAuthRef = 'keyring:provider:fixture-transport-provider';
const publicEndpoint = 'http://127.0.0.1:43129/v1';

interface TransportOptions {
  providerNpm?: string;
  modelNpm?: string;
  modelFormat?: 'openai' | 'anthropic';
  authRef?: string;
  headers?: Record<string, string>;
  accountId?: string;
}

function transportContext(endpoint: string, options: TransportOptions = {}) {
  const registered = provider({
    id: target.providerId,
    templateId: 'fixture',
    authRef: options.authRef ?? transportAuthRef,
    api: {
      npm: options.providerNpm ?? '@ai-sdk/openai-compatible',
      url: endpoint,
      ...(options.headers ? { headers: options.headers } : {}),
    },
    modelsCache: {
      source: 'account',
      fetchedAt: timestamp,
      models: [{
        id: target.modelId,
        name: target.modelId,
        upstreamModelId,
        modelFormat: options.modelFormat ?? 'openai',
        ...(options.modelNpm ? { npm: options.modelNpm } : {}),
        supportedReasoningEfforts: ['low'],
        pricing: { input: 2, output: 8, source: 'fixture-price', observedAt: timestamp },
      }],
    },
    ...(options.accountId ? { accounts: [{ id: options.accountId, authRef: options.authRef ?? transportAuthRef,
      enabled: true, modelsCache: {
        source: 'account', fetchedAt: timestamp, models: [{
          id: target.modelId,
          name: target.modelId,
          upstreamModelId,
          modelFormat: options.modelFormat ?? 'openai',
          ...(options.modelNpm ? { npm: options.modelNpm } : {}),
          supportedReasoningEfforts: ['low'],
          pricing: { input: 2, output: 8, source: 'fixture-price', observedAt: timestamp },
        }],
      } }] } : {}),
  });
  const catalog = buildRoutingCatalog(input([registered], {
    credentials: [options.accountId ? { providerId: registered.id, accountId: options.accountId, kind: 'api_key', available: true }
      : observation(registered.id)],
    discovery: [{ providerId: registered.id, ...(options.accountId ? { accountId: options.accountId } : {}),
      status: 'live', cacheFetchedAt: timestamp }],
  }));
  return {
    config: { enabled: true, cheapFallback: target, pool: [target],
      categories: { implementation: { target, effort: 'low' } } },
    catalog,
    workload: { input: 300, output: 90, cacheRead: 0, cacheWrite: 0 },
  };
}

function fingerprint(catalog: RoutingCatalogSnapshot): string | undefined {
  return (catalog.models[0] as RoutingCatalogSnapshot['models'][number] & { transportFingerprint?: string })?.transportFingerprint;
}

function assertBindingStateIsIsolated(sessionId: string): void {
  assertIsolatedRoutingSession(sessionId);
  const testHome = process.env['LEVERFRAME_TEST_HOME'];
  const statePath = routingBindingStatePath(sessionId);
  expect(testHome).toBeTruthy();
  const inside = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
  };
  expect(inside(testHome!, getAppHome())).toBe(true);
  expect(inside(testHome!, dirname(statePath))).toBe(true);
}

function bindingLaunch(sessionId: string, launchId: string, context: ReturnType<typeof transportContext>) {
  return { sessionId, launchId, role: 'specialist' as const, category: 'implementation',
    task: 'Route the fixture request', ...context };
}

it('canonicalizes equivalent URL spellings and restores the same bound transport after restart', async () => {
  const sessionId = 'd1111111-1111-4111-8111-111111111111';
  assertBindingStateIsIsolated(sessionId);
  const original = transportContext(`HTTP://fixture-user:fixture-password@127.0.0.1:43129/v1/root/../chat?route=fixture#first`);
  const equivalent = transportContext(`http://another-user:another-password@127.0.0.1:43129/v1/chat?route=fixture#second`);
  const launch = bindingLaunch(sessionId, 'launch-transport-restart', original);

  const accepted = await createRoutingBinding(launch);
  const resumed = await createRoutingBinding({ ...bindingLaunch(sessionId, 'launch-transport-restart', equivalent), resume: true });
  const resolved = await resolveRoutingBinding({ sessionId, modelId: accepted.id });

  expect(fingerprint(original.catalog)).toMatch(/^[a-f0-9]{64}$/);
  expect(fingerprint(equivalent.catalog)).toBe(fingerprint(original.catalog));
  expect(resumed.id).toBe(accepted.id);
  expect((resolved.identity as typeof resolved.identity & { transportFingerprint?: string }).transportFingerprint)
    .toBe(fingerprint(original.catalog));
});

it('changes transport identity when the effective URL query changes', () => {
  const first = transportContext(`${publicEndpoint}?route=first`);
  const changed = transportContext(`${publicEndpoint}?route=second`);

  expect(fingerprint(first.catalog)).toMatch(/^[a-f0-9]{64}$/);
  expect(fingerprint(changed.catalog)).toMatch(/^[a-f0-9]{64}$/);
  expect(fingerprint(changed.catalog)).not.toBe(fingerprint(first.catalog));
});

it('retains query ordering as part of transport identity', () => {
  const first = transportContext(`${publicEndpoint}?route=first&mode=one`);
  const reordered = transportContext(`${publicEndpoint}?mode=one&route=first`);

  expect(fingerprint(first.catalog)).toMatch(/^[a-f0-9]{64}$/);
  expect(fingerprint(reordered.catalog)).toMatch(/^[a-f0-9]{64}$/);
  expect(fingerprint(reordered.catalog)).not.toBe(fingerprint(first.catalog));
});

it('keeps transport identity stable when registry credentials and headers rotate', () => {
  const first = transportContext(publicEndpoint, { authRef: 'keyring:fixture-credential-one',
    headers: { Authorization: 'Bearer fixture-token-one' } });
  const rotated = transportContext(publicEndpoint, { authRef: 'keyring:fixture-credential-two',
    headers: { Authorization: 'Bearer fixture-token-two' } });

  expect(fingerprint(first.catalog)).toMatch(/^[a-f0-9]{64}$/);
  expect(fingerprint(rotated.catalog)).toBe(fingerprint(first.catalog));
});

it('keeps transport identity stable when the selected account changes', () => {
  const first = transportContext(publicEndpoint, { accountId: 'account-one' });
  const second = transportContext(publicEndpoint, { accountId: 'account-two' });

  expect(fingerprint(first.catalog)).toMatch(/^[a-f0-9]{64}$/);
  expect(fingerprint(second.catalog)).toBe(fingerprint(first.catalog));
});

it('keeps transport identity stable across routing sessions', async () => {
  const context = transportContext(publicEndpoint);
  const firstSessionId = 'd5555555-5555-4555-8555-555555555555';
  const secondSessionId = 'd6666666-6666-4666-8666-666666666666';
  assertBindingStateIsIsolated(firstSessionId);
  assertBindingStateIsIsolated(secondSessionId);

  const first = await createRoutingBinding(bindingLaunch(firstSessionId, 'launch-session-one', context));
  const second = await createRoutingBinding(bindingLaunch(secondSessionId, 'launch-session-two', context));

  expect((first.identity as typeof first.identity & { transportFingerprint?: string }).transportFingerprint)
    .toMatch(/^[a-f0-9]{64}$/);
  expect((second.identity as typeof second.identity & { transportFingerprint?: string }).transportFingerprint)
    .toBe((first.identity as typeof first.identity & { transportFingerprint?: string }).transportFingerprint);
});

it('resumes the saved transport identity after registry credentials and headers rotate', async () => {
  const sessionId = 'd4444444-4444-4444-8444-444444444444';
  assertBindingStateIsIsolated(sessionId);
  const original = transportContext(publicEndpoint, { authRef: 'keyring:fixture-credential-before',
    headers: { Authorization: 'Bearer fixture-token-before' } });
  const rotated = transportContext(publicEndpoint, { authRef: 'keyring:fixture-credential-after',
    headers: { Authorization: 'Bearer fixture-token-after' } });
  const launch = bindingLaunch(sessionId, 'launch-transport-credential-rotation', original);

  const accepted = await createRoutingBinding(launch);
  const resumed = await createRoutingBinding({ ...bindingLaunch(sessionId, 'launch-transport-credential-rotation', rotated), resume: true });

  expect(resumed.id).toBe(accepted.id);
  expect((resumed.identity as typeof resumed.identity & { transportFingerprint?: string }).transportFingerprint)
    .toBe((accepted.identity as typeof accepted.identity & { transportFingerprint?: string }).transportFingerprint);
});

it('keeps native Claude transport identity pinned to the existing Anthropic origin', () => {
  const { native } = nativeProviderWithRoutingMetadata();
  const nativeCache = native.modelsCache!;
  const discovery = [{ providerId: native.id, status: 'live' as const, cacheFetchedAt: nativeCache.fetchedAt }];
  const credentials = [observation(native.id, 'oauth')];
  const original = buildRoutingCatalog(input([native], { credentials, discovery }));
  const changedEndpoint = buildRoutingCatalog(input([{ ...native, api: { ...native.api, url: 'https://unrelated.invalid/custom' } }], {
    credentials, discovery,
  }));

  expect(fingerprint(original)).toMatch(/^[a-f0-9]{64}$/);
  expect(fingerprint(changedEndpoint)).toBe(fingerprint(original));
});

it.each([
  { providerId: 'openai-oauth', npm: '@ai-sdk/openai', authType: 'oauth' as const,
    format: 'openai' as const, endpoint: 'https://configured.invalid/private', expectedEndpoint: CODEX_API_BASE_URL },
  { providerId: 'openai-oauth', npm: '@ai-sdk/openai', authType: 'oauth' as const,
    format: 'openai' as const, endpoint: undefined, expectedEndpoint: CODEX_API_BASE_URL },
  { providerId: 'github-copilot', npm: '@ai-sdk/openai-compatible', authType: 'oauth' as const,
    format: 'openai' as const, endpoint: 'https://configured.invalid/copilot', expectedEndpoint: COPILOT_API_BASE_URL },
  { providerId: 'antigravity', npm: '@ai-sdk/google', authType: 'oauth' as const,
    format: 'openai' as const, endpoint: 'https://configured.invalid/antigravity', expectedEndpoint: ANTIGRAVITY_ORIGIN },
])('uses the shared transport identity for OAuth provider $providerId with endpoint $endpoint', ({ providerId, npm, authType, format, endpoint, expectedEndpoint }) => {
  const registered = provider({
    id: providerId,
    templateId: providerId,
    authType,
    authRef: `keyring:provider:${providerId}`,
    api: { npm, ...(endpoint ? { url: endpoint } : {}) },
    modelsCache: {
      source: 'account',
      fetchedAt: timestamp,
      models: [{ id: 'fixture-oauth-model', name: 'Fixture OAuth model', upstreamModelId: 'fixture-oauth-upstream',
        modelFormat: format, npm, supportedReasoningEfforts: ['low'] }],
    },
  });
  const catalog = buildRoutingCatalog(input([registered], {
    credentials: [{ providerId, kind: 'oauth', available: true }],
    discovery: [{ providerId, status: 'live', cacheFetchedAt: timestamp }],
  }));
  const expected = routingTransportFingerprint({ endpoint: expectedEndpoint, npm, format,
    credentialSource: 'registry', providerId, authType });

  expect(fingerprint(catalog)).toMatch(/^[a-f0-9]{64}$/);
  expect(fingerprint(catalog)).toBe(expected);
});

it.each([
  { label: 'provider SDK npm', changed: { providerNpm: '@ai-sdk/openai', modelFormat: 'openai' as const } },
  { label: 'model SDK npm override', changed: { modelNpm: '@ai-sdk/openai', modelFormat: 'openai' as const } },
  { label: 'wire format', changed: { providerNpm: '@ai-sdk/anthropic', modelFormat: 'anthropic' as const } },
])('changes transport identity when $label changes', ({ changed }) => {
  const first = transportContext(publicEndpoint);
  const drifted = transportContext(publicEndpoint, changed);

  expect(fingerprint(first.catalog)).toMatch(/^[a-f0-9]{64}$/);
  expect(fingerprint(drifted.catalog)).toMatch(/^[a-f0-9]{64}$/);
  expect(fingerprint(drifted.catalog)).not.toBe(fingerprint(first.catalog));
});

it('does not persist endpoint userinfo, query values, or credential headers in the snapshot or binding', async () => {
  const sessionId = 'd2222222-2222-4222-8222-222222222222';
  assertBindingStateIsIsolated(sessionId);
  const userInfoSecret = 'fixture-userinfo-secret';
  const querySecret = 'fixture-query-secret';
  const headerSecret = 'fixture-header-secret';
  const rawEndpoint = `http://${userInfoSecret}:password@127.0.0.1:43129/v1?token=${querySecret}#fragment`;
  const context = transportContext(rawEndpoint, {
    headers: { Authorization: `Bearer ${headerSecret}` },
  });
  const binding = await createRoutingBinding(bindingLaunch(sessionId, 'launch-transport-secret-redaction', context));
  const savedState = readFileSync(routingBindingStatePath(sessionId), 'utf8');

  expect(fingerprint(context.catalog)).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(context.catalog)).not.toContain(userInfoSecret);
  expect(JSON.stringify(context.catalog)).not.toContain(querySecret);
  expect(JSON.stringify(context.catalog)).not.toContain(headerSecret);
  expect(JSON.stringify(context.catalog)).not.toContain(rawEndpoint);
  expect(savedState).not.toContain(userInfoSecret);
  expect(savedState).not.toContain(querySecret);
  expect(savedState).not.toContain(headerSecret);
  expect(savedState).not.toContain('fixture-password');
  expect(savedState).not.toContain('127.0.0.1:43129');
  expect((binding.identity as typeof binding.identity & { transportFingerprint?: string }).transportFingerprint)
    .toMatch(/^[a-f0-9]{64}$/);
});

it('fails closed when the effective endpoint cannot be resolved', async () => {
  const sessionId = 'd3333333-3333-4333-8333-333333333333';
  assertBindingStateIsIsolated(sessionId);
  const context = transportContext('');

  await expect(createRoutingBinding(bindingLaunch(sessionId, 'launch-transport-unavailable', context)))
    .rejects.toMatchObject({ code: routingIdentityErrors.unavailable });
});

it('rejects a catalog fingerprint array even when it contains a valid-looking hash', async () => {
  const sessionId = 'd7777777-7777-4777-8777-777777777777';
  assertBindingStateIsIsolated(sessionId);
  const context = transportContext(publicEndpoint);
  const row = { ...context.catalog.models[0]!, transportFingerprint: ['a'.repeat(64)] as unknown as string };
  const malformedCatalog: RoutingCatalogSnapshot = { ...context.catalog, models: [row] };

  await expect(createRoutingBinding({ ...bindingLaunch(sessionId, 'launch-malformed-transport-catalog', context),
    catalog: malformedCatalog })).rejects.toMatchObject({ code: routingIdentityErrors.unavailable });
});

it('rejects a persisted fingerprint array rather than coercing it to a hash string', async () => {
  const sessionId = 'd8888888-8888-4888-8888-888888888888';
  assertBindingStateIsIsolated(sessionId);
  const context = transportContext(publicEndpoint);
  const binding = await createRoutingBinding(bindingLaunch(sessionId, 'launch-malformed-saved-transport', context));
  const statePath = routingBindingStatePath(sessionId);
  const original = readFileSync(statePath, 'utf8');
  const state = JSON.parse(original) as { bindings: Array<{ identity: Record<string, unknown> }> };
  state.bindings[0]!.identity['transportFingerprint'] = ['b'.repeat(64)];
  expect(process.env['LEVERFRAME_TEST_HOME']).toBeTruthy();

  try {
    assertBindingStateIsIsolated(sessionId);
    writeFileSync(statePath, JSON.stringify(state), 'utf8');

    await expect(resolveRoutingBinding({ sessionId, modelId: binding.id }))
      .rejects.toMatchObject({ code: routingBindingErrors.stateInvalid });
  } finally {
    assertBindingStateIsIsolated(sessionId);
    writeFileSync(statePath, original, 'utf8');
  }
});
