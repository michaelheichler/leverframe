import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { saveRegistry } from '../src/registry/io.js';
import { forwardSdkFetchToLocal, openAiSuccessResponse, startOpenAiUpstream } from './fixtures/account-pool-proxy.js';

let home: string;
let previousHome: string | undefined;
let fakeKeyring: Map<string, string>;

const alphaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000001';
const betaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000002';

function saveOAuthAccounts(): void {
  const credential = (access: string, accountId: string) => JSON.stringify({
    type: 'oauth', access, refresh: 'unused-refresh-fixture', expires: Date.now() + 3_600_000, accountId,
  });
  fakeKeyring.set(alphaRef.slice('keyring:'.length), credential('oauth-alpha-access', 'oauth-alpha-account'));
  fakeKeyring.set(betaRef.slice('keyring:'.length), credential('oauth-beta-access', 'oauth-beta-account'));
  saveRegistry({
    schemaVersion: 1,
    providers: [{
      id: 'openai-oauth', templateId: 'openai-oauth', name: 'ChatGPT OAuth', enabled: true,
      authType: 'oauth', authRef: alphaRef, api: {}, addedAt: '2026-01-01',
      accounts: [
        { id: 'alpha', authRef: alphaRef, enabled: true },
        { id: 'beta', authRef: betaRef, enabled: true },
      ],
    }],
  });
}

function route(): ProxyRoute {
  return {
    aliasId: 'openai-oauth__gpt-4o-mini', realModelId: 'gpt-4o-mini',
    displayName: 'ChatGPT OAuth fixture', upstreamUrl: '', apiKey: 'route-snapshot-oauth-token',
    modelFormat: 'openai', npm: '@ai-sdk/openai', providerId: 'openai-oauth', authType: 'oauth',
    preferWebSockets: false,
  };
}

function request(port: number, token: string, modelId: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: modelId, max_tokens: 20, messages: [{ role: 'user', content: 'fixture' }], stream: false,
    });
    const outgoing = http.request({
      hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, response => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode ?? 0 }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-codex-capacity-ranking-'));
  previousHome = process.env.LEVERFRAME_HOME;
  fakeKeyring = new Map();
  process.env.LEVERFRAME_HOME = home;
  vi.spyOn(_credentialStoreInternals, 'keyringOperation').mockImplementation(async input => {
    if (input.operation === 'read' || input.operation === 'peek') {
      return { ok: true, value: fakeKeyring.get(input.account) ?? null };
    }
    if (input.operation === 'write') fakeKeyring.set(input.account, input.value);
    if (input.operation === 'delete') fakeKeyring.delete(input.account);
    return { ok: true, value: null };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
  else process.env.LEVERFRAME_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

it('ranks OAuth accounts by both compatible Codex capacity windows', async () => {
  saveOAuthAccounts();
  const resetAt = String(Math.floor(Date.now() / 1000) + 3600);
  const upstream = await startOpenAiUpstream((call, response) => {
    const alpha = call.authorization === 'Bearer oauth-alpha-access';
    openAiSuccessResponse(response, {
      'x-codex-primary-used-percent': alpha ? '90' : '50',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': resetAt,
      'x-codex-secondary-used-percent': alpha ? '80' : '50',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-at': resetAt,
    });
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const model = route();
  const proxy = await startProxyCatalog([model], model.aliasId, false);

  try {
    const first = await request(proxy.port, proxy.token, model.aliasId);
    const second = await request(proxy.port, proxy.token, model.aliasId);
    const third = await request(proxy.port, proxy.token, model.aliasId);

    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    expect(upstream.calls.map(call => call.authorization)).toEqual([
      'Bearer oauth-alpha-access', 'Bearer oauth-beta-access', 'Bearer oauth-beta-access',
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('uses fair rotation when Codex capacity windows cross without a dominant account', async () => {
  saveOAuthAccounts();
  const resetAt = String(Math.floor(Date.now() / 1000) + 3600);
  const upstream = await startOpenAiUpstream((call, response) => {
    const alpha = call.authorization === 'Bearer oauth-alpha-access';
    openAiSuccessResponse(response, {
      'x-codex-primary-used-percent': alpha ? '90' : '30',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': resetAt,
      'x-codex-secondary-used-percent': alpha ? '20' : '80',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-at': resetAt,
    });
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    forwardSdkFetchToLocal(input, init, upstream.port));
  const model = route();
  const proxy = await startProxyCatalog([model], model.aliasId, false);

  try {
    const first = await request(proxy.port, proxy.token, model.aliasId);
    const second = await request(proxy.port, proxy.token, model.aliasId);
    const third = await request(proxy.port, proxy.token, model.aliasId);

    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    expect(upstream.calls.map(call => call.authorization)).toEqual([
      'Bearer oauth-alpha-access', 'Bearer oauth-beta-access', 'Bearer oauth-alpha-access',
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
