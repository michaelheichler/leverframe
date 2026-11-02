import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _credentialStoreInternals } from '../src/credential-store.js';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { saveRegistry } from '../src/registry/io.js';
import { forwardSdkFetchToLocal, openAiSuccessResponse, startOpenAiUpstream } from './fixtures/account-pool-proxy.js';

const oauthAlphaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000001';
const previousHome = process.env.LEVERFRAME_HOME;
let home: string;
let fakeKeyring: Map<string, string>;

function saveChatGptOAuthProvider(): void {
  const betaRef = 'keyring:oauth:provider:openai-oauth::credential::v1:00000000000000000000000000000002';
  const credential = (access: string, accountId: string) => JSON.stringify({
    type: 'oauth', access, refresh: 'unused-refresh-fixture', expires: Date.now() + 3_600_000, accountId,
  });
  fakeKeyring.set(oauthAlphaRef.slice('keyring:'.length), credential('oauth-alpha-access', 'oauth-alpha-account'));
  fakeKeyring.set(betaRef.slice('keyring:'.length), credential('oauth-beta-access', 'oauth-beta-account'));
  saveRegistry({ schemaVersion: 1, providers: [{
    id: 'openai-oauth', templateId: 'openai-oauth', name: 'ChatGPT OAuth', enabled: true,
    authType: 'oauth', authRef: oauthAlphaRef, api: {}, addedAt: '2026-01-01',
    accounts: [
      { id: 'alpha', authRef: oauthAlphaRef, enabled: true },
      { id: 'beta', authRef: betaRef, enabled: true },
    ],
  }] });
}

function chatGptRoute(): ProxyRoute {
  return {
    aliasId: 'openai-oauth__gpt-4o-mini', realModelId: 'gpt-4o-mini',
    displayName: 'ChatGPT OAuth fixture', upstreamUrl: '', apiKey: 'route-snapshot-oauth-token',
    modelFormat: 'openai', npm: '@ai-sdk/openai', providerId: 'openai-oauth', authType: 'oauth',
    preferWebSockets: false,
  };
}

function postMessages(port: number, token: string, model: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model, max_tokens: 20, messages: [{ role: 'user', content: 'fixture request' }], stream: false,
    });
    const request = http.request({ hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
    } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'leverframe-account-pool-codex-quota-'));
  process.env.LEVERFRAME_HOME = home;
  fakeKeyring = new Map();
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

it('keeps an exhausted Codex secondary window despite healthy primary telemetry', async () => {
  saveChatGptOAuthProvider();
  const resetAt = String(Math.floor(Date.now() / 1000) + 3600);
  const upstream = await startOpenAiUpstream((call, response) => {
    if (call.authorization === 'Bearer oauth-alpha-access') {
      openAiSuccessResponse(response, {
        'x-codex-primary-used-percent': '5',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': resetAt,
        'x-codex-secondary-used-percent': '100',
        'x-codex-secondary-window-minutes': '10080',
        'x-codex-secondary-reset-at': resetAt,
      });
      return;
    }
    openAiSuccessResponse(response, {
      'x-codex-primary-used-percent': '50',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': resetAt,
      'x-codex-secondary-used-percent': '50',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-at': resetAt,
    });
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => forwardSdkFetchToLocal(input, init, upstream.port));
  const route = chatGptRoute();
  const proxy = await startProxyCatalog([route], route.aliasId, false);

  try {
    const first = await postMessages(proxy.port, proxy.token, route.aliasId);
    const second = await postMessages(proxy.port, proxy.token, route.aliasId);
    const third = await postMessages(proxy.port, proxy.token, route.aliasId);

    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    expect(upstream.calls.map(call => call.authorization)).toEqual([
      'Bearer oauth-alpha-access', 'Bearer oauth-beta-access', 'Bearer oauth-beta-access',
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('retains exhausted windows reported under a dynamic Codex header prefix', async () => {
  saveChatGptOAuthProvider();
  const resetAt = String(Math.floor(Date.now() / 1000) + 3600);
  const upstream = await startOpenAiUpstream((call, response) => {
    const alpha = call.authorization === 'Bearer oauth-alpha-access';
    openAiSuccessResponse(response, {
      'x-codex-extra-primary-used-percent': alpha ? '5' : '50',
      'x-codex-extra-primary-window-minutes': '300',
      'x-codex-extra-primary-reset-at': resetAt,
      'x-codex-extra-secondary-used-percent': alpha ? '100' : '50',
      'x-codex-extra-secondary-window-minutes': '10080',
      'x-codex-extra-secondary-reset-at': resetAt,
    });
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => forwardSdkFetchToLocal(input, init, upstream.port));
  const route = chatGptRoute();
  const proxy = await startProxyCatalog([route], route.aliasId, false);

  try {
    await postMessages(proxy.port, proxy.token, route.aliasId);
    await postMessages(proxy.port, proxy.token, route.aliasId);
    await postMessages(proxy.port, proxy.token, route.aliasId);

    expect(upstream.calls.map(call => call.authorization)).toEqual([
      'Bearer oauth-alpha-access', 'Bearer oauth-beta-access', 'Bearer oauth-beta-access',
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('uses Codex rate-limit events when selecting after a successful OAuth response', async () => {
  saveChatGptOAuthProvider();
  const resetAt = Math.floor(Date.now() / 1000) + 3600;
  const upstream = await startOpenAiUpstream((call, response) => {
    const alpha = call.authorization === 'Bearer oauth-alpha-access';
    openAiSuccessResponse(response, {}, [{
      type: 'codex.rate_limits',
      rate_limits: {
        primary: { used_percent: alpha ? 5 : 50, window_minutes: 300, reset_at: resetAt },
        secondary: { used_percent: alpha ? 100 : 50, window_minutes: 10080, reset_at: resetAt },
      },
      metered_limit_name: 'fixture subscription',
    }]);
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => forwardSdkFetchToLocal(input, init, upstream.port));
  const route = chatGptRoute();
  const proxy = await startProxyCatalog([route], route.aliasId, false);

  try {
    await postMessages(proxy.port, proxy.token, route.aliasId);
    await postMessages(proxy.port, proxy.token, route.aliasId);
    await postMessages(proxy.port, proxy.token, route.aliasId);

    expect(upstream.calls.map(call => call.authorization)).toEqual([
      'Bearer oauth-alpha-access', 'Bearer oauth-beta-access', 'Bearer oauth-beta-access',
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
