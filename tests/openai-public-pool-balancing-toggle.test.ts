import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { savePreferences } from '../src/config.js';
import { recordObservation, type PoolKey } from '../src/account-pool.js';
import { startServer, type ServerHandle } from '../src/server/router.js';
import { createGatewayModelCatalog } from '../src/server/models.js';
import { saveRegistry } from '../src/registry/io.js';
import { forwardSdkFetchToLocal, startOpenAiUpstream } from './fixtures/account-pool-proxy.js';

const alphaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000041';
const betaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000042';
let home: string;
let previousHome: string | undefined;
let fakeKeyring: Map<string, string>;
let server: ServerHandle | undefined;
let closeUpstream: (() => Promise<void>) | undefined;

function savePinnedAccounts(): void {
  const credential = (access: string, accountId: string) => JSON.stringify({
    type: 'oauth', access, refresh: 'fixture-refresh-unused', expires: Date.now() + 3_600_000, accountId,
  });
  fakeKeyring.set(alphaRef.slice('keyring:'.length), credential('oauth-alpha-access', 'oauth-alpha-account'));
  fakeKeyring.set(betaRef.slice('keyring:'.length), credential('oauth-beta-access', 'oauth-beta-account'));
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: 'openai-oauth', templateId: 'openai-oauth', name: 'fixture OAuth pool', enabled: true,
      authType: 'oauth', authRef: alphaRef, pinnedAccountId: 'alpha', api: {}, addedAt: '2026-01-01',
      accounts: [
        { id: 'alpha', authRef: alphaRef, enabled: true },
        { id: 'beta', authRef: betaRef, enabled: true },
      ],
    }],
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-openai-balancing-toggle-'));
  previousHome = process.env.LEVERFRAME_HOME;
  process.env.LEVERFRAME_HOME = home;
  fakeKeyring = new Map();
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    if (input.operation === 'read' || input.operation === 'peek') return { ok: true, value: fakeKeyring.get(input.account) ?? null };
    if (input.operation === 'write') fakeKeyring.set(input.account, input.value);
    if (input.operation === 'delete') fakeKeyring.delete(input.account);
    return { ok: true, value: null };
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await server?.close();
  server = undefined;
  await closeUpstream?.();
  closeUpstream = undefined;
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

it('keeps a pinned session on its account when balancing is disabled despite better verified quota', async () => {
  savePinnedAccounts();
  savePreferences({ accountPoolBalancing: false, accountPoolFailover: true, accountPoolQuotaThresholdPercent: 10 });
  const upstream = await startOpenAiUpstream();
  closeUpstream = upstream.close;
  const gatewayFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  server = await startServer({
    host: '127.0.0.1', port: 0, apiKey: 'fixture-gateway-sentinel', serverPassword: null,
    catalog: createGatewayModelCatalog([{
      id: 'gpt-pool-toggle-fixture', name: 'fixture OAuth model', isFree: false, brand: 'OpenAI',
      sourceBackend: 'fixture', modelFormat: 'openai', providerId: 'openai-oauth', authType: 'oauth',
      npm: '@ai-sdk/openai', apiKey: 'catalog-token-sentinel', preferWebSockets: false,
    }]),
  });
  const pool: PoolKey = { providerId: 'openai-oauth', modelId: 'gpt-pool-toggle-fixture', billingType: 'oauth' };
  const session = '33333333-3333-4333-8333-333333333333';
  const send = () => gatewayFetch(`${server!.url}/openai/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': session },
    body: JSON.stringify({ model: 'gpt-pool-toggle-fixture', messages: [{ role: 'user', content: 'offline toggle fixture' }] }),
  });

  const initial = await send();
  expect(initial.status).toBe(200);
  await initial.text();
  const observedAt = Date.now();
  await recordObservation({ pool, now: observedAt, observation: {
    accountId: 'alpha', scope: { kind: 'pool' }, source: 'codex:event', observedAt,
    status: 'healthy', dimension: 'codex:weekly:secondary:10080',
    remaining: { value: 5, limit: 100, unit: 'codex:weekly:secondary:10080' },
  } });
  await recordObservation({ pool, now: observedAt, observation: {
    accountId: 'beta', scope: { kind: 'pool' }, source: 'codex:event', observedAt,
    status: 'healthy', dimension: 'codex:weekly:secondary:10080',
    remaining: { value: 70, limit: 100, unit: 'codex:weekly:secondary:10080' },
  } });

  const followup = await send();
  await followup.text();

  expect(followup.status).toBe(200);
  expect(upstream.calls.map(call => call.authorization)).toEqual([
    'Bearer oauth-alpha-access', 'Bearer oauth-alpha-access',
  ]);
});
